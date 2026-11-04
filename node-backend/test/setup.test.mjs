import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';

test('setup generates private distinct credentials, loads them and refuses to overwrite them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sms-node-setup-'));
  t.after(async () => {
    const absolute = resolve(directory);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('sms-node-setup-')) throw new Error('Unexpected cleanup target');
    await rm(absolute, { recursive: true, force: true });
  });
  const script = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url));
  const created = spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const environment = await readFile(join(directory, '.env'), 'utf8');
  const keys = await readFile(join(directory, 'app-keys.json'), 'utf8');
  const deviceKey = environment.match(/^DEVICE_KEY=([a-f0-9]{64})$/m)?.[1];
  assert.ok(deviceKey); assert.notEqual(JSON.parse(keys)[0].key, deviceKey);
  assert.ok(!created.stdout.includes(deviceKey)); assert.ok(!created.stdout.includes(JSON.parse(keys)[0].key));
  const config = loadConfig({ APP_KEYS_FILE: join(directory, 'app-keys.json'), DEVICE_KEY: deviceKey, DB_PATH: join(directory, 'data/jobs.sqlite') });
  assert.equal(config.apps[0].id, 'my-app'); assert.equal(config.port, 3000);
  const again = spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
  assert.equal(again.status, 1);
  assert.equal(await readFile(join(directory, '.env'), 'utf8'), environment);
  assert.equal(await readFile(join(directory, 'app-keys.json'), 'utf8'), keys);
});
