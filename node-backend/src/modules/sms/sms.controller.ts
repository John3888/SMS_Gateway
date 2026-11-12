import type { RequestHandler } from "express";
import { AppError } from "../../middlewares/error.middleware.js";
import { readJsonObject } from "../../middlewares/validate.middleware.js";
import type { SmsService } from "./sms.services.js";
import type { SmsStatus } from "./sms.types.js";
import { normalizeSms, readWaitMilliseconds } from "./sms.validation.js";
import { legacyResponse, publicJob } from "./sms.response.js";
const failureCodes: Partial<Record<SmsStatus, number>> = {
  failed: 502,
  unknown: 504,
  expired: 410,
  cancelled: 409,
};
export function createSmsController(queue: SmsService, notify: () => void) {
  const submit: RequestHandler = async (req, res, next) => {
    try {
      const body = readJsonObject(req.body);
      const waitMs = readWaitMilliseconds(body);
      if (waitMs && queue.waiterCount >= 100)
        throw new AppError(429, "Too many waiting API calls", 1);
      const legacy = req.path.replace(/\/+$/, "") !== "/api/v1/sms";
      if (legacy && (!(body.number ?? body.phone) || !body.message))
        throw new AppError(400, "Number and message are required.");
      const normalized = normalizeSms(body, req.get("Idempotency-Key"), legacy);
      const result = queue.enqueue(res.locals.application, normalized);
      if (result.created) notify();
      res.set("Idempotency-Key", result.job.request_key);
      const job = waitMs ? await queue.waitForTerminal(result.job.id, waitMs) : result.job;
      if (res.destroyed) return;
      const response = legacy ? legacyResponse(job) : publicJob(job);
      let code = legacy ? 200 : result.created ? 202 : 200;
      if (waitMs) {
        if (job.status === "submitted") code = 200;
        else if (["failed", "unknown", "expired", "cancelled"].includes(job.status)) {
          code = failureCodes[job.status] || 503;
          if ("success" in response) {
            response.success = false;
            response.message = job.error || `SMS job ${job.status}.`;
          }
        } else {
          code = 202;
          response.pending = true;
        }
      }
      res.status(code).json(response);
    } catch (error) {
      next(error);
    }
  };
  const list: RequestHandler = (req, res) => {
    res.json(
      queue.list(
        res.locals.application.id,
        new URL(req.originalUrl, "http://gateway").searchParams,
      ),
    );
  };
  const get: RequestHandler = (req, res) => {
    res.json(publicJob(queue.get(res.locals.application.id, String(req.params.id))));
  };
  const cancel: RequestHandler = (req, res) => {
    res.json(publicJob(queue.cancel(res.locals.application.id, String(req.params.id))));
  };
  return { submit, list, get, cancel };
}
