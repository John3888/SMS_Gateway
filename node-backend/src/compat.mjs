import { HttpError, publicJob } from './queue.mjs';

// The existing HTTP clients use number/message. The device protocol remains
// phone/message so both API contracts share the same queue and quota accounting.
export function normalizeSms(data, headerKey, allowGeneratedKey = false) {
  if (data.number !== undefined && data.phone !== undefined && data.number !== data.phone)
    throw new HttpError(422, 'number and phone must match when both are provided');
  if (headerKey && data.idempotency_key !== undefined && headerKey !== data.idempotency_key)
    throw new HttpError(409, 'Idempotency-Key header and body key must match');
  return {
    phone: data.phone ?? data.number,
    message: data.message,
    idempotency_key: headerKey ?? data.idempotency_key ?? (allowGeneratedKey ? crypto.randomUUID() : undefined),
    ...(data.ttl_seconds === undefined ? {} : { ttl_seconds: data.ttl_seconds }),
  };
}

export function legacyResponse(row) {
  return {
    success: true,
    message: 'SMS job sent to gateway.',
    data: { number: row.phone, message: row.message },
    job: publicJob(row),
  };
}
