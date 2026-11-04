import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { WebSocket } from 'ws';
import { createGateway } from '../src/server.mjs';
import { validateConfig } from '../src/config.mjs';

const A = { id: 'orders', key: 'a'.repeat(40) };
const B = { id: 'alerts', key: 'b'.repeat(40) };
const deviceKey = 'd'.repeat(40);
const token = n => n.toString(16).padStart(64, '0');
const payload = (key = 'request-1') => ({ number: '+639171234567', message: 'Hello 你好', idempotency_key: key });

async function fixture(t, extra = {}) {
  const gateway = createGateway({ dbPath: ':memory:', apps: [A, B], deviceKey, ...extra });
  const address = await gateway.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => gateway.close());
  async function call(path, data, key = A.key, method = data === undefined ? 'GET' : 'POST', headers = {}) {
    const response = await fetch(base + path, { method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { response, body: await response.json() };
  }
  async function connect(key = deviceKey) {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/device/ws', { headers: { Authorization: `Bearer ${key}` } });
    socket.frames = []; socket.sequence = 0;
    socket.on('message', raw => socket.frames.push(JSON.parse(raw.toString())));
    socket.on('error', () => {});
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return socket;
  }
  return { gateway, base, call, connect };
}
async function frame(socket, predicate = value => value.type === 'available') {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const at = socket.frames.findIndex(predicate);
    if (at >= 0) return socket.frames.splice(at, 1)[0];
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('No expected WebSocket frame received');
}
async function rpc(socket, type, body, expectedStatus = 200) {
  const id = ++socket.sequence;
  socket.send(JSON.stringify({ type, request_id: id, body }));
  const reply = await frame(socket, value => value.type === 'reply' && value.request_id === id);
  assert.equal(reply.status, expectedStatus, JSON.stringify(reply)); return reply.body;
}
async function finish(socket, job, tok, status = 'submitted') {
  await rpc(socket, 'start', { token: tok, id: job.id });
  return rpc(socket, 'result', { token: tok, id: job.id, status, modem_reference: 17 });
}

test('legacy HTTP JSON is queued durably, pushed and confirmed over the real device socket', async t => {
  const { call, connect } = await fixture(t);
  const socket = await connect(); await frame(socket);
  socket.send(JSON.stringify({ type: 'status', ready: true })); await frame(socket);
  const submitted = await call('/sms-send/', payload());
  assert.equal(submitted.response.status, 200); assert.equal(submitted.body.success, true);
  assert.deepEqual(submitted.body.data, { number: payload().number, message: payload().message });
  assert.equal(submitted.body.job.status, 'queued'); await frame(socket);
  const job = await rpc(socket, 'claim', { token: token(1) });
  assert.equal(job.id, submitted.body.job.id); assert.equal(job.phone, payload().number);
  assert.equal((await finish(socket, job, token(1))).status, 'submitted');
  assert.equal((await call(job.status_url)).body.modem_reference, 17);
  const health = (await call('/api/v1/health')).body;
  assert.equal(health.device_connected, true); assert.equal(health.device_ready, true);
});
test('concurrent duplicate submissions insert once and retain response compatibility', async t => {
  const { call, gateway } = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 8 }, () => call('/api/sms-send/', payload())));
  assert.ok(responses.every(item => item.response.status === 200));
  assert.equal(new Set(responses.map(item => item.body.job.id)).size, 1);
  assert.equal(gateway.queue.one('SELECT COUNT(*) AS n FROM jobs').n, 1);
  assert.equal((await call('/sms-send', { ...payload(), message: 'changed' })).response.status, 409);
});
test('application keys isolate records and cannot authenticate the device connection', async t => {
  const { call, connect } = await fixture(t);
  const first = await call('/sms-send', payload());
  assert.equal((await call(first.body.job.status_url, undefined, B.key)).response.status, 404);
  const second = await call('/sms-send', payload(), B.key);
  assert.notEqual(first.body.job.id, second.body.job.id);
  assert.equal((await call('/sms-send', payload(), deviceKey)).response.status, 401);
  await assert.rejects(connect(A.key), /401/);
  assert.equal((await call('/device/ws', undefined, deviceKey)).response.status, 426);
});
test('canonical routes, header keys, generated legacy keys and validation work', async t => {
  const { call, base } = await fixture(t);
  const canonical = await call('/api/v1/sms/', { phone: '+1234', message: 'canonical', idempotency_key: 'canonical' });
  assert.equal(canonical.response.status, 202);
  const original = await call('/sms-send', { number: '+1234', message: 'hello' });
  const key = original.response.headers.get('Idempotency-Key'); assert.ok(key);
  const retried = await call('/sms-send', { number: '+1234', message: 'hello' }, A.key, 'POST', { 'Idempotency-Key': key });
  assert.equal(retried.body.job.id, original.body.job.id);
  assert.equal((await call('/sms-send', payload(), A.key, 'POST', { 'Idempotency-Key': 'mismatch' })).response.status, 409);
  assert.equal((await call('/sms-send', { number: '+1234' })).response.status, 400);
  assert.equal((await call('/sms-send', { ...payload(), message: '😀' })).response.status, 422);
  assert.equal((await call('/sms-send', { ...payload(), message: 'x'.repeat(2000) })).response.status, 413);
  const wrongType = await fetch(base + '/sms-send', { method: 'POST', headers: { Authorization: `Bearer ${A.key}`, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415);
  const invalidUtf8 = await fetch(base + '/sms-send', { method: 'POST', headers: { Authorization: `Bearer ${A.key}`, 'Content-Type': 'application/json' }, body: Buffer.from([0xff]) });
  assert.equal(invalidUtf8.status, 400);
});
test('per-application burst limits and refill return Retry-After without charging duplicates', async t => {
  let now = Date.parse('2026-11-04T12:00:00Z');
  const { call } = await fixture(t, { apps: [{ ...A, burst: 1 }], clock: () => now });
  await call('/sms-send', payload());
  assert.equal((await call('/sms-send', payload())).response.status, 200);
  const limited = await call('/sms-send', payload('second'));
  assert.equal(limited.response.status, 429); assert.equal(limited.response.headers.get('Retry-After'), '6');
  now += 6000; assert.equal((await call('/sms-send', payload('second'))).response.status, 200);
});
test('global limit atomically rolls back application allowance and daily accounting', async t => {
  const { call, gateway } = await fixture(t, { limits: { GLOBAL_SMS_BURST: 1 } });
  await call('/sms-send', payload());
  assert.equal((await call('/sms-send', payload(), B.key)).response.status, 429);
  assert.equal(gateway.queue.one('SELECT * FROM buckets WHERE id=?', 'sms:alerts'), undefined);
  assert.equal(gateway.queue.one('SELECT * FROM daily_usage WHERE app_id=?', B.id), undefined);
});
test('fair scheduling alternates waiting applications and reserves only one job', async t => {
  const { call, connect } = await fixture(t);
  await call('/sms-send', payload('a1')); await call('/sms-send', payload('a2'));
  await call('/sms-send', payload('b1'), B.key);
  const socket = await connect(); await frame(socket);
  const a = await rpc(socket, 'claim', { token: token(1) }); assert.equal(a.idempotency_key, 'a1');
  await rpc(socket, 'claim', { token: token(2) }, 204);
  await finish(socket, a, token(1));
  const b = await rpc(socket, 'claim', { token: token(2) }); assert.equal(b.idempotency_key, 'b1');
  await finish(socket, b, token(2));
  assert.equal((await rpc(socket, 'claim', { token: token(3) })).idempotency_key, 'a2');
});
test('queue capacity, queued cancellation, expiry and paginated history are enforced', async t => {
  let now = Date.parse('2026-11-04T12:00:00Z');
  const { call, connect } = await fixture(t, { limits: { MAX_PENDING: 2 }, clock: () => now });
  const first = await call('/sms-send', payload('one'));
  const second = await call('/sms-send', { ...payload('two'), ttl_seconds: 60 });
  assert.equal((await call('/sms-send', payload('three'))).response.status, 429);
  assert.equal((await call(first.body.job.status_url, undefined, A.key, 'DELETE')).body.status, 'cancelled');
  now += 60000;
  assert.equal((await call(second.body.job.status_url)).body.status, 'expired');
  assert.equal((await call('/api/v1/sms?limit=1')).body.jobs.length, 1);
  const socket = await connect(); await frame(socket); await rpc(socket, 'claim', { token: token(1) }, 204);
});
test('daily admission quota survives cancellation and resets at the next UTC day', async t => {
  let now = Date.parse('2026-11-04T12:00:00Z');
  const { call } = await fixture(t, { apps: [{ ...A, daily_limit: 1 }], clock: () => now });
  const first = await call('/sms-send', payload()); await call(first.body.job.status_url, undefined, A.key, 'DELETE');
  assert.equal((await call('/sms-send', payload('two'))).response.status, 429);
  now += 86400000; assert.equal((await call('/sms-send', payload('two'))).response.status, 200);
});
test('reconnect recovers the same claim and terminal reply replay cannot overwrite success', async t => {
  const { call, connect } = await fixture(t);
  await call('/sms-send', payload());
  const before = await connect(); await frame(before);
  const job = await rpc(before, 'claim', { token: token(1) });
  await rpc(before, 'start', { token: token(1), id: job.id }); before.close();
  const after = await connect(); await frame(after);
  assert.equal((await rpc(after, 'claim', { token: token(1) })).status, 'sending');
  await rpc(after, 'result', { token: token(1), id: job.id, status: 'submitted', modem_reference: 42 });
  const replay = await rpc(after, 'result', { token: token(1), id: job.id, status: 'unknown' });
  assert.equal(replay.status, 'submitted'); assert.equal(replay.modem_reference, 42);
});
test('replacement socket closes the old connection and malformed/binary frames are rejected', async t => {
  const { connect } = await fixture(t);
  const old = await connect(); await frame(old);
  const replaced = new Promise(resolve => old.once('close', code => resolve(code)));
  const replacement = await connect(); await frame(replacement);
  assert.equal(await replaced, 4001);
  const closed = new Promise(resolve => replacement.once('close', code => resolve(code)));
  replacement.send(Buffer.from('binary')); assert.equal(await closed, 1003);
  const invalid = await connect(); await frame(invalid);
  const invalidClosed = new Promise(resolve => invalid.once('close', code => resolve(code)));
  invalid.send('{bad-json'); assert.equal(await invalidClosed, 1008);
});
test('database restart preserves queued jobs, rate counters and an in-flight claim', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sms-node-test-'));
  t.after(async () => {
    const absolute = resolve(directory);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('sms-node-test-')) throw new Error('Unexpected test cleanup target');
    await rm(absolute, { recursive: true, force: true });
  });
  const dbPath = join(directory, 'jobs.sqlite');
  const first = await fixture(t, { dbPath, apps: [{ ...A, burst: 1 }] });
  const admitted = await first.call('/sms-send', payload());
  const socket = await first.connect(); await frame(socket);
  await rpc(socket, 'claim', { token: token(1) }); await first.gateway.close();
  const restarted = await fixture(t, { dbPath, apps: [{ ...A, burst: 1 }] });
  assert.equal((await restarted.call(admitted.body.job.status_url)).body.status, 'claimed');
  assert.equal((await restarted.call('/sms-send', payload('different'))).response.status, 429);
  assert.equal((await restarted.call('/sms-send', payload())).body.job.id, admitted.body.job.id);
  const after = await restarted.connect(); await frame(after);
  assert.equal((await rpc(after, 'claim', { token: token(1) })).id, admitted.body.job.id);
  await rpc(after, 'claim', { token: token(2) }, 204);
  await restarted.gateway.close();
});
test('API request budget limits status polling independently of SMS admission', async t => {
  const { call } = await fixture(t);
  for (let i = 0; i < 30; i++) assert.equal((await call('/api/v1/health')).response.status, 200);
  const limited = await call('/api/v1/health');
  assert.equal(limited.response.status, 429); assert.ok(limited.response.headers.get('Retry-After'));
});
test('startup rejects shared/placeholder secrets and invalid quota configuration', () => {
  assert.throws(() => validateConfig({ apps: [A], deviceKey: A.key }));
  assert.throws(() => validateConfig({ apps: [A, A], deviceKey }));
  assert.throws(() => validateConfig({ apps: [{ ...A, id: 1 }], deviceKey }));
  assert.throws(() => validateConfig({ apps: [{ ...A, burst: 0 }], deviceKey }));
  assert.throws(() => validateConfig({ apps: [A], deviceKey: 'REPLACE_WITH_A_RANDOM_SECRET_AT_LEAST_32_CHARACTERS' }));
  assert.throws(() => validateConfig({ apps: [{ ...A, key: 'YOUR_UNIQUE_RANDOM_APPLICATION_KEY_AT_LEAST_32_CHARACTERS' }], deviceKey }));
});
