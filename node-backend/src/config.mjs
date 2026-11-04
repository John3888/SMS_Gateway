import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { integer, validateConfig } from './settings.mjs';
export { validateConfig } from './settings.mjs';

export const digest = value => createHash('sha256').update(value).digest();
export function matches(header, key) {
  return typeof header === 'string' && timingSafeEqual(digest(header), digest(`Bearer ${key}`));
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
