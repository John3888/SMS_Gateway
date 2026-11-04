import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const digest = value => createHash('sha256').update(value).digest();
export function matches(header, key) {
  return typeof header === 'string' && timingSafeEqual(digest(header), digest(`Bearer ${key}`));
}
function integer(value, fallback, min, max, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${name}`);
  return parsed;
}
function secret(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 256 && !/^(REPLACE_|YOUR_|COPY_)/.test(value) && !/[\r\n]/.test(value);
}
export function validateConfig(config) {
  if (!secret(config.deviceKey)) throw new Error('Configure a random DEVICE_KEY of at least 32 characters');
  if (!Array.isArray(config.apps) || config.apps.length < 1 || config.apps.length > 32) throw new Error('Configure 1-32 application keys');
  const limits = config.limits || {};
  limits.MAX_PENDING = integer(limits.MAX_PENDING, 100, 1, 10000, 'MAX_PENDING');
  limits.GLOBAL_SMS_PER_MINUTE = integer(limits.GLOBAL_SMS_PER_MINUTE, 12, 1, 1000, 'GLOBAL_SMS_PER_MINUTE');
  limits.GLOBAL_SMS_BURST = integer(limits.GLOBAL_SMS_BURST, 10, 1, 1000, 'GLOBAL_SMS_BURST');
  const apps = config.apps.map(app => {
    if (!app || typeof app.id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(app.id) || !secret(app.key) || app.key === config.deviceKey)
      throw new Error('Application ids/keys must be valid and distinct from DEVICE_KEY');
    return { ...app,
      rate_per_minute: integer(app.rate_per_minute, 10, 1, 1000, 'rate_per_minute'),
      burst: integer(app.burst, 5, 1, 1000, 'burst'),
      daily_limit: integer(app.daily_limit, 200, 1, 100000, 'daily_limit'),
      max_pending: integer(app.max_pending, Math.min(20, limits.MAX_PENDING), 1, limits.MAX_PENDING, 'max_pending'),
    };
  });
  if (new Set(apps.map(app => app.id)).size !== apps.length || new Set(apps.map(app => app.key)).size !== apps.length)
    throw new Error('Each application needs a unique id and key');
  return { ...config, apps, limits };
}
export function loadConfig(env = process.env) {
  let apps;
  try {
    apps = env.APP_KEYS ? JSON.parse(env.APP_KEYS) : JSON.parse(readFileSync(resolve(env.APP_KEYS_FILE || './app-keys.json'), 'utf8'));
  } catch { throw new Error('Configure APP_KEYS JSON or APP_KEYS_FILE; run npm run setup for a new installation'); }
  return validateConfig({
    host: env.HOST || '127.0.0.1', port: integer(env.PORT, 3000, 1, 65535, 'PORT'),
    dbPath: resolve(env.DB_PATH || './data/sms.sqlite'), apps, deviceKey: env.DEVICE_KEY,
    limits: { MAX_PENDING: env.MAX_PENDING, GLOBAL_SMS_PER_MINUTE: env.GLOBAL_SMS_PER_MINUTE, GLOBAL_SMS_BURST: env.GLOBAL_SMS_BURST },
  });
}
