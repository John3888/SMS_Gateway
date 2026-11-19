import { Router } from "express";
import type { GatewayConfig } from "./types/gateway.types.js";
import type { SmsService } from "./modules/sms/sms.services.js";
import type { DeviceHealth } from "./modules/device/device.types.js";
import { requireApplication } from "./middlewares/auth.middleware.js";
import { requestRateLimit } from "./middlewares/rate-limit.middleware.js";
import { createDeviceRoutes } from "./modules/device/device.routes.js";
import { deviceHealth } from "./modules/device/device.controller.js";
import { createSmsRoutes } from "./modules/sms/sms.routes.js";
export function createRoutes(
  config: GatewayConfig,
  queue: SmsService,
  realtime: { notify: () => void; getHealth: () => DeviceHealth },
) {
  const router = Router();
  router.get("/healthz", (_req, res) => {
    res.json({ status: "ok", state: "memory" });
  });
  router.use(createDeviceRoutes(config.deviceKey));
  router.use(requireApplication(config), requestRateLimit(queue));
  router.get("/api/v1/health", deviceHealth(queue, realtime.getHealth));
  router.use(createSmsRoutes(queue, realtime.notify));
  return router;
}
