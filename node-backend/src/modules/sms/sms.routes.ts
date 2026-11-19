import express, { Router } from "express";
import { requireJson } from "../../middlewares/validate.middleware.js";
import { createSmsController } from "./sms.controller.js";
import type { SmsService } from "./sms.services.js";
export function createSmsRoutes(queue: SmsService, notify: () => void) {
  const router = Router();
  const controller = createSmsController(queue, notify);
  router.post(
    ["/sms-send", "/api/sms-send", "/api/v1/sms"],
    requireJson,
    express.raw({ type: () => true, limit: 1024 }),
    controller.submit,
  );
  router.get("/api/sms", controller.list);
  router.get("/api/v1/sms/:id", controller.get);
  router.delete("/api/v1/sms/:id", controller.cancel);
  return router;
}
