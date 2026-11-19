import type { RequestHandler } from "express";
import type { SmsService } from "../modules/sms/sms.services.js";

export function requestRateLimit(sms: SmsService): RequestHandler {
  return (_req, res, next) => {
    try {
      sms.requestBudget(res.locals.application.id);
      next();
    } catch (error) {
      next(error);
    }
  };
}
