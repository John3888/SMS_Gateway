import { AppError } from "../../middlewares/error.middleware.js";
import type { DeviceFrame } from "./device.types.js";
export function parseDeviceFrame(raw: string): DeviceFrame {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    throw new AppError(400, "Invalid JSON");
  }
  if (!frame || typeof frame !== "object" || Array.isArray(frame))
    throw new AppError(400, "Invalid message");
  return frame as DeviceFrame;
}
