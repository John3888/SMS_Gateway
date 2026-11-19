import type { ForgottenJob, LegacySmsResponse, PublicJob, SmsJob } from "./sms.types.js";

export function publicJob(row: SmsJob | ForgottenJob, device = false): PublicJob {
  const result: PublicJob = {
    id: row.id,
    status: row.status,
    status_url: `/api/v1/sms/${row.id}`,
  };
  if ("forgotten" in row) {
    result.forgotten = true;
    result.error = row.error;
    return result;
  }
  result.idempotency_key = row.request_key;
  result.created_at = row.created_at;
  result.expires_at = row.expires_at;
  if (row.modem_reference != null && row.modem_reference >= 0)
    result.modem_reference = row.modem_reference;
  if (row.error) result.error = row.error;
  if (device) {
    result.phone = row.phone;
    result.message = row.message;
  }
  return result;
}

export function legacyResponse(row: SmsJob): LegacySmsResponse {
  return {
    success: true,
    message: "SMS job sent to gateway.",
    data: { number: row.phone, message: row.message },
    job: publicJob(row),
  };
}
