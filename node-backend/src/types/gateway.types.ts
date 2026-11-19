export type Clock = () => number;

export interface QueueLimits {
  MAX_PENDING: number;
  GLOBAL_SMS_PER_MINUTE: number;
  GLOBAL_SMS_BURST: number;
  MAX_COMPLETED: number;
  HISTORY_TTL_SECONDS: number;
}

export type QueueLimitsInput = Partial<Record<keyof QueueLimits, unknown>>;

export interface ApplicationConfig {
  webhook?: { url: string; secret: string };
  id: string;
  key: string;
  rate_per_minute: number;
  burst: number;
  daily_limit: number;
  max_pending: number;
}

export interface GatewayOptions {
  apps: unknown;
  deviceKey: unknown;
  host?: string;
  port?: number;
  limits?: QueueLimitsInput;
  clock?: Clock;
}

export interface GatewayConfig {
  apps: ApplicationConfig[];
  deviceKey: string;
  host?: string;
  port?: number;
  limits: QueueLimits;
  clock?: Clock;
}
