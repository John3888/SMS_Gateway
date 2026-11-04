import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { validSecret, validateConfig } from '../src/settings.mjs';

try {
  if (existsSync('cloudflare-secrets.json')) throw new Error('cloudflare-secrets.json already exists; it will not be overwritten');
  const local = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
  const env = { ...local, ...process.env };
  let deviceKey = env.DEVICE_KEY;
  if (!deviceKey || /^(REPLACE_|YOUR_|COPY_)/.test(deviceKey)) deviceKey = randomBytes(32).toString('hex');
  if (!validSecret(deviceKey)) throw new Error('Existing DEVICE_KEY is invalid; correct it before importing');
  let apps;
  const keysPath = resolve(env.APP_KEYS_FILE || 'app-keys.json');
  if (env.APP_KEYS) apps = JSON.parse(env.APP_KEYS);
  else if (existsSync(keysPath)) apps = JSON.parse(readFileSync(keysPath, 'utf8'));
  else if (env.APP_KEY) apps = [{ id: 'default', key: env.APP_KEY }];
  else apps = [{ id: 'my-app', key: randomBytes(32).toString('hex'), rate_per_minute: 10, burst: 5, daily_limit: 200, max_pending: 20 }];
  const settings = validateConfig({ deviceKey, apps });
  const secrets = { DEVICE_KEY: settings.deviceKey, APP_KEYS: JSON.stringify(settings.apps) };
  writeFileSync('cloudflare-secrets.json', JSON.stringify(secrets, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Created private cloudflare-secrets.json. Existing .env and application-key files are unchanged.');
  console.log('The file imports valid existing keys where available, otherwise generates random keys. Review it before uploading.');
  console.log('Copy its DEVICE_KEY into the ESP32; use an APP_KEYS entry only in each application backend.');
} catch {
  console.error('Cloudflare secret preparation failed. Check existing configuration/keys and whether cloudflare-secrets.json already exists. No credentials were printed.');
  process.exitCode = 1;
}
