import type {
  ApplicationConfig,
  GatewayConfig,
  GatewayOptions,
  QueueLimits,
} from "../types/gateway.types.js";

export function integer(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${name}`);
  return parsed;
}

export function validSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 32 &&
    value.length <= 256 &&
    !/^(REPLACE_|YOUR_|COPY_)/.test(value) &&
    !/[\r\n]/.test(value)
  );
}

export function validateConfig(config: GatewayOptions): GatewayConfig {
  if (!validSecret(config.deviceKey))
    throw new Error("Configure a random DEVICE_KEY of at least 32 characters");
  if (!Array.isArray(config.apps) || config.apps.length < 1 || config.apps.length > 32)
    throw new Error("Configure 1-32 application keys");
  const input = config.limits || {};
  const limits: QueueLimits = {
    MAX_PENDING: integer(input.MAX_PENDING, 100, 1, 10000, "MAX_PENDING"),
    GLOBAL_SMS_PER_MINUTE: integer(
      input.GLOBAL_SMS_PER_MINUTE,
      12,
      1,
      1000,
      "GLOBAL_SMS_PER_MINUTE",
    ),
    GLOBAL_SMS_BURST: integer(input.GLOBAL_SMS_BURST, 10, 1, 1000, "GLOBAL_SMS_BURST"),
    MAX_COMPLETED: integer(input.MAX_COMPLETED, 200, 1, 10000, "MAX_COMPLETED"),
    HISTORY_TTL_SECONDS: integer(input.HISTORY_TTL_SECONDS, 900, 30, 86400, "HISTORY_TTL_SECONDS"),
  };
  const apps = config.apps.map((value: unknown): ApplicationConfig => {
    if (!value || typeof value !== "object")
      throw new Error("Application configuration is invalid");
    const app = value as Record<string, unknown>;
    if (
      typeof app.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(app.id) ||
      !validSecret(app.key) ||
      app.key === config.deviceKey
    )
      throw new Error("Application ids/keys must be valid and distinct from DEVICE_KEY");
    return {
      ...app,
      id: app.id,
      key: app.key,
      rate_per_minute: integer(app.rate_per_minute, 10, 1, 1000, "rate_per_minute"),
      burst: integer(app.burst, 5, 1, 1000, "burst"),
      daily_limit: integer(app.daily_limit, 200, 1, 100000, "daily_limit"),
      max_pending: integer(
        app.max_pending,
        Math.min(20, limits.MAX_PENDING),
        1,
        limits.MAX_PENDING,
        "max_pending",
      ),
    };
  });
  if (
    new Set(apps.map((app) => app.id)).size !== apps.length ||
    new Set(apps.map((app) => app.key)).size !== apps.length
  )
    throw new Error("Each application needs a unique id and key");
  return { ...config, deviceKey: config.deviceKey, apps, limits };
}
