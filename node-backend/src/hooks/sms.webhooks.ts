import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ApplicationConfig } from "../types/gateway.types.js";
import type { SmsJob } from "../modules/sms/sms.types.js";

type Webhook = NonNullable<ApplicationConfig["webhook"]>;

async function deliver(hook: Webhook, body: string) {
  const signature = createHmac("sha256", hook.secret).update(body).digest("hex");
  for (const backoff of [0, 1000, 3000]) {
    if (backoff) await delay(backoff);
    try {
      const response = await fetch(hook.url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(4000),
        headers: {
          "Content-Type": "application/json",
          "X-Gateway-Signature": "sha256=" + signature,
        },
        body,
      });
      await response.body?.cancel();
      if (response.ok) return;
      if (response.status < 500 && ![408, 429].includes(response.status)) break;
    } catch {
      // Connection errors and timeouts may occur after the receiver saved the event.
    }
  }
  throw new Error("Callback was not acknowledged");
}

export function createWebhooks(apps: ApplicationConfig[]) {
  const pending = new Set<Promise<void>>();
  return {
    notify(job: SmsJob) {
      const hook = apps.find(app => app.id === job.app_id)?.webhook;
      if (!hook) return;
      const body = JSON.stringify({
        event: "sms.completed",
        event_id: job.id + ":completed",
        job_id: job.id,
        application: job.app_id,
        idempotency_key: job.request_key,
        status: job.status,
        updated_at: new Date(job.updated_at).toISOString(),
        modem_reference: job.modem_reference ?? null,
        error: job.error ?? null,
      });
      const attempt = deliver(hook, body)
        .catch(() => console.error("Webhook delivery failed for", job.app_id, job.id))
        .finally(() => pending.delete(attempt));
      pending.add(attempt);
    },
    async drain() {
      await Promise.all(pending);
    },
  };
}
