export type SmsStatus =
  "queued" | "claimed" | "sending" | "submitted" | "failed" | "unknown" | "expired" | "cancelled";

export interface SmsInput {
  phone?: unknown;
  message?: unknown;
  idempotency_key?: unknown;
  ttl_seconds?: unknown;
}

export interface ValidatedSms {
  phone: string;
  message: string;
  idempotency_key: string;
  ttl_seconds: number;
}

export interface SmsJob {
  id: string;
  app_id: string;
  request_key: string;
  phone: string;
  message: string;
  ttl_seconds: number;
  status: SmsStatus;
  created_at: number;
  updated_at: number;
  expires_at: number;
  sequence: number;
  claim_token?: string;
  completed_at?: number;
  modem_reference?: number | null;
  error?: string | null;
}

export interface ForgottenJob {
  id: string;
  status: "unknown";
  forgotten: true;
  error: string;
}

export interface PublicJob {
  id: string;
  status: SmsStatus;
  status_url: string;
  idempotency_key?: string;
  created_at?: number;
  expires_at?: number;
  modem_reference?: number;
  error?: string;
  forgotten?: boolean;
  phone?: string;
  message?: string;
  pending?: boolean;
}

export interface LegacySmsResponse {
  success: boolean;
  message: string;
  data: { number: string; message: string };
  job: PublicJob;
  pending?: boolean;
}

export interface RateBucket {
  tokens: number;
  updated_at: number;
}

export type JobWaiter = (job: SmsJob) => void;
