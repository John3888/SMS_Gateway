import type { RequestHandler } from "express";
import { matchesToken } from "../../middlewares/auth.middleware.js";
import { AppError } from "../../middlewares/error.middleware.js";
import type { SmsService } from "../sms/sms.services.js";
import type { DeviceHealth } from "./device.types.js";
export function requireDeviceUpgrade(deviceKey: string): RequestHandler {
  return (req, _res, next) =>
    next(
      new AppError(
        matchesToken(req.get("Authorization"), deviceKey) ? 426 : 401,
        "Authenticated WebSocket upgrade required",
      ),
    );
}
export function deviceHealth(queue: SmsService, getHealth: () => DeviceHealth): RequestHandler {
  return (_req, res) => {
    res.json({
      backend: "online",
      state: "memory",
      transport: "websocket",
      ...queue.counts(res.locals.application.id),
      ...getHealth(),
    });
  };
}
