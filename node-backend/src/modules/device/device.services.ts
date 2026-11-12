import { AppError } from "../../middlewares/error.middleware.js";
import type { SmsService } from "../sms/sms.services.js";
import { publicJob } from "../sms/sms.response.js";
import type { DeviceFrame } from "./device.types.js";
export function processDeviceRequest(queue: SmsService, frame: DeviceFrame) {
  if (
    typeof frame.request_id !== "number" ||
    !Number.isInteger(frame.request_id) ||
    frame.request_id < 1 ||
    frame.request_id > 0xffffffff
  )
    throw new AppError(422, "Invalid request_id");
  const row = queue.device(frame.type, frame.body);
  return {
    type: "reply",
    request_id: frame.request_id,
    status: row ? 200 : 204,
    body: row ? publicJob(row, true) : {},
  };
}
