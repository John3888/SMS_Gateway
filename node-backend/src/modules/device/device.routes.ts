import { Router } from "express";
import { requireDeviceUpgrade } from "./device.controller.js";
export function createDeviceRoutes(deviceKey: string) {
  const router = Router();
  router.all("/device/ws", requireDeviceUpgrade(deviceKey));
  return router;
}
