import { randomUUID } from "node:crypto";
import { AppError } from "../../middlewares/error.middleware.js";
import type { ApplicationConfig, Clock, QueueLimits } from "../../types/gateway.types.js";
import type {
  SmsJob,
  ForgottenJob,
  SmsStatus,
  SmsInput,
  RateBucket,
  JobWaiter,
} from "./sms.types.js";
import { SMS_ID, validateSms } from "./sms.validation.js";
import { publicJob } from "./sms.response.js";

const ACTIVE = new Set<SmsStatus>(["queued", "claimed", "sending"]);
const TERMINAL = new Set<SmsStatus>(["submitted", "failed", "unknown", "expired", "cancelled"]);
function limit(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new AppError(503, "Invalid rate/queue configuration");
  return n;
}
// All jobs, deduplication keys, quotas and waiters exist only in this process.
export class SmsService {
  readonly clock: Clock;
  readonly maxPending: number;
  readonly globalRate: number;
  readonly globalBurst: number;
  readonly maxCompleted: number;
  readonly historyMs: number;
  readonly jobs = new Map<string, SmsJob>();
  readonly keys = new Map<string, string>();
  readonly claims = new Map<string, string>();
  readonly buckets = new Map<string, RateBucket>();
  readonly daily = new Map<string, { day: string; used: number }>();
  readonly served = new Map<string, number>();
  readonly waiters = new Map<string, Set<JobWaiter>>();
  sequence = 0;
  turn = 0;
  activeId: string | null = null;
  waiterCount = 0;
  constructor(config: Partial<QueueLimits> = {}, clock: Clock = () => Date.now()) {
    this.clock = clock;
    this.maxPending = limit(config.MAX_PENDING, 100, 1, 10000);
    this.globalRate = limit(config.GLOBAL_SMS_PER_MINUTE, 12, 1, 1000);
    this.globalBurst = limit(config.GLOBAL_SMS_BURST, 10, 1, 1000);
    this.maxCompleted = limit(config.MAX_COMPLETED, 200, 1, 10000);
    this.historyMs = limit(config.HISTORY_TTL_SECONDS, 900, 30, 86400) * 1000;
  }
  finish(job: SmsJob, status: SmsStatus, error: string | null = null) {
    job.status = status;
    job.error = error;
    job.updated_at = this.clock();
    job.completed_at = this.clock();
    if (this.activeId === job.id) this.activeId = null;
    for (const resolve of [...(this.waiters.get(job.id) || [])]) resolve({ ...job });
  }
  prune() {
    const now = this.clock();
    for (const job of this.jobs.values())
      if (job.status === "queued" && job.expires_at <= now) this.finish(job, "expired");
    const completed = [...this.jobs.values()]
      .filter((job) => TERMINAL.has(job.status))
      .sort((a, b) => (a.completed_at ?? 0) - (b.completed_at ?? 0) || a.sequence - b.sequence);
    let remaining = completed.length;
    for (const job of completed) {
      if (now - (job.completed_at ?? 0) < this.historyMs && remaining <= this.maxCompleted)
        continue;
      this.jobs.delete(job.id);
      this.keys.delete(`${job.app_id}:${job.request_key}`);
      if (job.claim_token) this.claims.delete(job.claim_token);
      remaining--;
    }
  }
  allowance(id: string, rate: number, burst: number): RateBucket {
    const now = this.clock(),
      previous = this.buckets.get(id);
    const tokens = previous
      ? Math.min(burst, previous.tokens + (Math.max(0, now - previous.updated_at) * rate) / 60000)
      : burst;
    if (tokens < 1)
      throw new AppError(
        429,
        "Rate limit exceeded",
        Math.max(1, Math.ceil(((1 - tokens) * 60) / rate)),
      );
    return { tokens: tokens - 1, updated_at: now };
  }
  budget(id: string, rate: number, burst: number) {
    this.buckets.set(id, this.allowance(id, rate, burst));
  }
  requestBudget(app: string) {
    this.budget(`requests:${app}`, 120, 30);
  }
  deviceBudget() {
    this.budget("device", 240, 30);
  }
  enqueue(app: ApplicationConfig, input: SmsInput) {
    const data = validateSms(input);
    const ttl = data.ttl_seconds;
    this.prune();
    const existingId = this.keys.get(`${app.id}:${data.idempotency_key}`);
    const existing = existingId ? this.jobs.get(existingId) : undefined;
    if (existing) {
      if (
        existing.phone !== data.phone ||
        existing.message !== data.message ||
        existing.ttl_seconds !== ttl
      )
        throw new AppError(409, "Idempotency key already used with different content or TTL");
      return { job: { ...existing }, created: false };
    }
    const pending = [...this.jobs.values()].filter((job) => ACTIVE.has(job.status));
    const appMax = limit(app.max_pending, Math.min(20, this.maxPending), 1, this.maxPending);
    if (
      pending.length >= this.maxPending ||
      pending.filter((job) => job.app_id === app.id).length >= appMax
    )
      throw new AppError(429, "Queue capacity reached", 5);
    const now = this.clock(),
      day = new Date(now).toISOString().slice(0, 10);
    const daily = this.daily.get(app.id);
    const used = daily && daily.day === day ? daily.used : 0;
    if (used >= limit(app.daily_limit, 200, 1, 100000))
      throw new AppError(
        429,
        "Daily SMS quota reached",
        Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86400000 - now) / 1000),
      );
    // Compute both allowances before committing either; a global rejection must
    // not consume that application's SMS or daily allowance.
    const appBudget = this.allowance(
      `sms:${app.id}`,
      limit(app.rate_per_minute, 10, 1, 1000),
      limit(app.burst, 5, 1, 1000),
    );
    const globalBudget = this.allowance("sms:global", this.globalRate, this.globalBurst);
    const job: SmsJob = {
      id: randomUUID(),
      app_id: app.id,
      request_key: data.idempotency_key,
      phone: data.phone,
      message: data.message,
      ttl_seconds: ttl,
      status: "queued",
      created_at: now,
      updated_at: now,
      expires_at: now + ttl * 1000,
      sequence: ++this.sequence,
    };
    this.buckets.set(`sms:${app.id}`, appBudget);
    this.buckets.set("sms:global", globalBudget);
    this.daily.set(app.id, { day, used: used + 1 });
    this.jobs.set(job.id, job);
    this.keys.set(`${app.id}:${job.request_key}`, job.id);
    return { job: { ...job }, created: true };
  }
  get(app: string, id: string): SmsJob {
    this.prune();
    const job = this.jobs.get(id);
    if (!job || job.app_id !== app) throw new AppError(404, "Job not found or no longer retained");
    return { ...job };
  }
  cancel(app: string, id: string): SmsJob {
    const snapshot = this.get(app, id),
      job = this.jobs.get(id)!;
    if (snapshot.status === "cancelled") return snapshot;
    if (snapshot.status !== "queued") throw new AppError(409, "Only queued jobs can be cancelled");
    this.finish(job, "cancelled");
    const result = { ...job };
    this.prune();
    return result;
  }
  list(app: string, params: URLSearchParams) {
    this.prune();
    const page = Number(params.get("page") ?? 0),
      size = Number(params.get("limit") ?? 20);
    if (
      !Number.isInteger(page) ||
      page < 0 ||
      page > 10000 ||
      !Number.isInteger(size) ||
      size < 1 ||
      size > 50
    )
      throw new AppError(422, "Use page 0-10000 and limit 1-50");
    return {
      jobs: [...this.jobs.values()]
        .filter((job) => job.app_id === app)
        .sort((a, b) => b.sequence - a.sequence)
        .slice(page * size, (page + 1) * size)
        .map((job) => publicJob(job)),
      page,
      limit: size,
    };
  }
  counts(app: string) {
    this.prune();
    return {
      pending: [...this.jobs.values()].filter((job) => job.app_id === app && ACTIVE.has(job.status))
        .length,
      queue_capacity: this.maxPending,
    };
  }
  waitForTerminal(id: string, milliseconds: number): Promise<SmsJob> {
    const job = this.jobs.get(id);
    if (!job) throw new AppError(404, "Job no longer retained");
    if (TERMINAL.has(job.status)) return Promise.resolve({ ...job });
    if (this.waiterCount >= 100) throw new AppError(429, "Too many waiting API calls", 1);
    return new Promise<SmsJob>((resolve) => {
      const listeners = this.waiters.get(id) || new Set<JobWaiter>();
      const done: JobWaiter = (snapshot) => {
        if (!listeners.delete(done)) return;
        clearTimeout(timer);
        this.waiterCount--;
        if (!listeners.size) this.waiters.delete(id);
        resolve(snapshot);
      };
      const timer = setTimeout(() => {
        this.prune();
        done({ ...(this.jobs.get(id) || job) });
      }, milliseconds);
      timer.unref();
      listeners.add(done);
      this.waiters.set(id, listeners);
      this.waiterCount++;
    });
  }
  device(type: unknown, input: unknown): SmsJob | ForgottenJob | null {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new AppError(422, "Invalid claim token");
    const data = input as Record<string, unknown>;
    if (!data || typeof data.token !== "string" || !/^[a-f0-9]{64}$/.test(data.token))
      throw new AppError(422, "Invalid claim token");
    this.prune();
    if (type === "claim") {
      const previousId = this.claims.get(data.token);
      const previous = previousId ? this.jobs.get(previousId) : undefined;
      if (previous) return { ...previous };
      if (this.activeId) return null;
      const job = [...this.jobs.values()]
        .filter((job) => job.status === "queued")
        .sort(
          (a, b) =>
            (this.served.get(a.app_id) || 0) - (this.served.get(b.app_id) || 0) ||
            a.sequence - b.sequence,
        )[0];
      if (!job) return null;
      job.status = "claimed";
      job.claim_token = data.token;
      job.updated_at = this.clock();
      this.activeId = job.id;
      this.claims.set(data.token, job.id);
      this.served.set(job.app_id, ++this.turn);
      return { ...job };
    }
    if (typeof data.id !== "string" || !SMS_ID.test(data.id))
      throw new AppError(422, "Invalid job id");
    if (type === "result") {
      if (
        typeof data.status !== "string" ||
        !["submitted", "failed", "unknown"].includes(data.status)
      )
        throw new AppError(422, "Invalid result status");
      if (data.error != null && (typeof data.error !== "string" || data.error.length > 400))
        throw new AppError(422, "Invalid error");
      if (
        data.modem_reference != null &&
        (typeof data.modem_reference !== "number" ||
          !Number.isInteger(data.modem_reference) ||
          data.modem_reference < -1 ||
          data.modem_reference > 255)
      )
        throw new AppError(422, "Invalid modem reference");
    }
    const job = this.jobs.get(data.id);
    if (!job && type === "result") {
      // The ESP32 can retain an old result across a backend restart. Acknowledge
      // that it is forgotten, without resending or inventing a successful send.
      return {
        id: data.id,
        status: "unknown",
        forgotten: true,
        error: "Backend no longer retains this job; original send outcome is unconfirmed",
      };
    }
    if (!job || job.claim_token !== data.token) throw new AppError(404, "Claim not found");
    if (type === "start") {
      if (!["claimed", "sending"].includes(job.status))
        throw new AppError(409, "Job already completed");
      job.status = "sending";
      job.updated_at = this.clock();
    } else if (type === "result") {
      if (TERMINAL.has(job.status)) return { ...job };
      if (job.status !== "sending") throw new AppError(409, "Start job before reporting a result");
      job.modem_reference = (data.modem_reference as number | undefined) ?? null;
      this.finish(job, data.status as SmsStatus, (data.error as string | undefined) || null);
    } else throw new AppError(422, "Unknown device message type");
    const result = { ...job };
    this.prune();
    return result;
  }
  clear() {
    for (const job of this.jobs.values())
      if (ACTIVE.has(job.status))
        this.finish(job, "unknown", "Backend stopped; job state is no longer retained");
    this.jobs.clear();
    this.keys.clear();
    this.claims.clear();
    this.buckets.clear();
    this.daily.clear();
    this.served.clear();
    this.activeId = null;
  }
}
