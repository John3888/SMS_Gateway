import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Cloudflare setup imports existing credentials without changing files or printing secrets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sms-cf-setup-'));
  t.after(async () => {
    const absolute = resolve(directory);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('sms-cf-setup-')) throw new Error('Unexpected cleanup target');
    await rm(absolute, { recursive: true, force: true });
  });
  const deviceKey = 'd'.repeat(40), appKey = 'a'.repeat(40);
  const originalEnv = `DEVICE_KEY=${deviceKey}\nAPP_KEYS_FILE=./app-keys.json\n`;
  const originalKeys = JSON.stringify([{ id: 'orders', key: appKey, daily_limit: 50 }]);
  await writeFile(join(directory, '.env'), originalEnv); await writeFile(join(directory, 'app-keys.json'), originalKeys);
  const env = { ...process.env };
  for (const name of ['DEVICE_KEY', 'APP_KEYS', 'APP_KEYS_FILE', 'APP_KEY']) delete env[name];
  const script = fileURLToPath(new URL('../scripts/setup-cloudflare.mjs', import.meta.url));
  const created = spawnSync(process.execPath, [script], { cwd: directory, env, encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const before = await readFile(join(directory, 'cloudflare-secrets.json'), 'utf8');
  const secrets = JSON.parse(before);
  assert.equal(secrets.DEVICE_KEY, deviceKey);
  assert.equal(JSON.parse(secrets.APP_KEYS)[0].key, appKey);
  assert.equal(JSON.parse(secrets.APP_KEYS)[0].daily_limit, 50);
  assert.equal(await readFile(join(directory, '.env'), 'utf8'), originalEnv);
  assert.equal(await readFile(join(directory, 'app-keys.json'), 'utf8'), originalKeys);
  assert.ok(!created.stdout.includes(deviceKey) && !created.stdout.includes(appKey));
  const again = spawnSync(process.execPath, [script], { cwd: directory, env, encoding: 'utf8' });
  assert.equal(again.status, 1); assert.equal(await readFile(join(directory, 'cloudflare-secrets.json'), 'utf8'), before);
});
