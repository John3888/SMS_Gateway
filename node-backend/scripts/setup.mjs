import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('.env') || existsSync('app-keys.json')) {
  console.error('Existing .env or app-keys.json found. Edit them directly; setup will not overwrite credentials.');
  process.exitCode = 1;
} else {
  const deviceKey = randomBytes(32).toString('hex');
  const appKey = randomBytes(32).toString('hex');
  const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
    .replace('REPLACE_WITH_A_DIFFERENT_RANDOM_SECRET_AT_LEAST_32_CHARACTERS', deviceKey);
  writeFileSync('.env', env, { flag: 'wx', mode: 0o600 });
  writeFileSync('app-keys.json', JSON.stringify([{ id: 'my-app', key: appKey,
    rate_per_minute: 10, burst: 5, daily_limit: 200, max_pending: 20 }], null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Created private .env and app-keys.json with different random device/application keys.');
  console.log('Copy DEVICE_KEY from .env into the ESP32; use the application key only in your application backend.');
}
