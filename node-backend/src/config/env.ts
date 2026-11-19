import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { integer, validateConfig } from "./settings.js";
import type { GatewayConfig } from "../types/gateway.types.js";
export { validateConfig } from "./settings.js";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  let apps: unknown;
  try {
    apps = env.APP_KEYS
      ? JSON.parse(env.APP_KEYS)
      : JSON.parse(readFileSync(resolve(env.APP_KEYS_FILE || "./app-keys.json"), "utf8"));
  } catch {
    throw new Error(
      "Configure APP_KEYS JSON or APP_KEYS_FILE; run npm run setup for a new installation",
    );
  }
  return validateConfig({
    host: env.HOST || "127.0.0.1",
    port: integer(env.PORT, 3000, 1, 65535, "PORT"),
    apps,
    deviceKey: env.DEVICE_KEY,
    limits: {
      MAX_PENDING: env.MAX_PENDING,
      GLOBAL_SMS_PER_MINUTE: env.GLOBAL_SMS_PER_MINUTE,
      GLOBAL_SMS_BURST: env.GLOBAL_SMS_BURST,
      MAX_COMPLETED: env.MAX_COMPLETED,
      HISTORY_TTL_SECONDS: env.HISTORY_TTL_SECONDS,
    },
  });
}

export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env) {
  const { DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD } = env;
  if (!DATABASE_URL && !ADMIN_USERNAME && !ADMIN_PASSWORD) return null;
  if (!DATABASE_URL || !ADMIN_USERNAME?.trim() || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12)
    throw new Error("Set DATABASE_URL, ADMIN_USERNAME and ADMIN_PASSWORD (12 or more characters)");
  return { username: ADMIN_USERNAME.trim(), password: ADMIN_PASSWORD, secureCookie: env.ADMIN_COOKIE_SECURE !== "false" };
}
