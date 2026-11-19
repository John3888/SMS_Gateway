import { randomUUID } from "node:crypto";
import { AppError } from "../../middlewares/error.middleware.js";
import type { SmsInput, ValidatedSms } from "./sms.types.js";

export const SMS_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function validateSms(data: SmsInput): ValidatedSms {
  const { phone, message, idempotency_key } = data;
  if (
    typeof phone !== "string" ||
    typeof message !== "string" ||
    typeof idempotency_key !== "string"
  )
    throw new AppError(400, "phone, message and idempotency_key must be strings");
  if (!/^\+[1-9][0-9]{1,14}$/.test(phone) || !SMS_ID.test(idempotency_key))
    throw new AppError(422, "Invalid phone or idempotency_key");
  const chars = [...message];
  if (
    !chars.length ||
    chars.length > 70 ||
    chars.some(
      (c) => !c.codePointAt(0) || c.codePointAt(0)! > 0xffff || /^[\uD800-\uDFFF]$/.test(c),
    )
  )
    throw new AppError(422, "Use 1-70 BMP characters; NUL and non-BMP emoji unsupported");
  const ttl = data.ttl_seconds ?? 3600;
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 60 || ttl > 86400)
    throw new AppError(422, "ttl_seconds must be 60-86400");
  return { phone, message, idempotency_key, ttl_seconds: ttl };
}

export function normalizeSms(
  data: Record<string, unknown>,
  headerKey: string | undefined,
  allowGeneratedKey = false,
): SmsInput {
  if (data.number !== undefined && data.phone !== undefined && data.number !== data.phone)
    throw new AppError(422, "number and phone must match when both are provided");
  if (headerKey && data.idempotency_key !== undefined && headerKey !== data.idempotency_key)
    throw new AppError(409, "Idempotency-Key header and body key must match");
  return {
    phone: data.phone ?? data.number,
    message: data.message,
    idempotency_key:
      headerKey ?? data.idempotency_key ?? (allowGeneratedKey ? randomUUID() : undefined),
    ...(data.ttl_seconds === undefined ? {} : { ttl_seconds: data.ttl_seconds }),
  };
}

export function readWaitMilliseconds(body: Record<string, unknown>): number {
  const value = body.wait_ms ?? 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 30000)
    throw new AppError(422, "wait_ms must be 0-30000");
  return value;
}
