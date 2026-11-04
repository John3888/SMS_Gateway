import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { QueueStore, HttpError } from '../src/queue.mjs';
import { GatewayHub } from '../src/cloudflare/worker.mjs';

const APP_A = { id: 'orders', key: 'a'.repeat(40) };
const APP_B = { id: 'alerts', key: 'b'.repeat(40) };
const DEVICE_KEY = 'd'.repeat(40);
const sms = (key = 'request-1', extra = {}) => ({ phone: '+639171234567', message: 'Hello 你好', idempotency_key: key, ...extra });
const token = n => n.toString(16).padStart(64, '0');
const statusError = (code, retry = false) => error => error instanceof HttpError && error.status === code && (!retry || error.retryAfter > 0);
function setup(config = {}) {
  const db = new DatabaseSync(':memory:');
  const storage = {
    sql: { exec(sql, ...args) { return { toArray: () => db.prepare(sql).all(...args) }; } },
    transactionSync(fn) {
      db.exec('BEGIN');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  // Execute statements when exec is called, matching Durable Object SQL semantics.
  storage.sql.exec = (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; };
  let now = Date.parse('2026-11-04T12:00:00Z');
  const queue = new QueueStore(storage, config, () => now);
  const sockets = [];
  const ctx = { storage, getWebSockets: () => sockets };
  const hub = new GatewayHub(ctx, { ...config, APP_KEYS: JSON.stringify([APP_A, APP_B]), DEVICE_KEY });
  hub.queue = queue;
  async function call(path, data, key = APP_A.key, method = data === undefined ? 'GET' : 'POST', headers = {}) {
    return hub.fetch(new Request('https://relay.example' + path, {
      method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }));
  }
  return { queue, hub, call, db, storage, sockets, ctx, advance: ms => { now += ms; } };
}
function finish(queue, row, t, status = 'submitted') {
  queue.device('start', { token: t, id: row.id });
  return queue.device('result', { token: t, id: row.id, status, modem_reference: 42 });
}
test('simultaneous idempotent requests insert once and isolate applications', async () => {
  const { call, db } = setup();
  const responses = await Promise.all(Array.from({ length: 8 }, () => call('/api/v1/sms', sms())));
  assert.equal(responses.filter(r => r.status === 202).length, 1);
  assert.equal(responses.filter(r => r.status === 200).length, 7);
  const first = await responses[0].json();
  assert.equal((await call('/api/v1/sms', sms('request-1', { message: 'different' }))).status, 409);
  assert.equal((await call(first.status_url, undefined, APP_B.key)).status, 404);
  assert.equal((await call('/api/v1/sms', sms(), APP_B.key)).status, 202);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 2);
  db.close();
});
test('application burst/refill limits persist and duplicates do not consume SMS tokens', () => {
  const { queue, storage, advance, db } = setup();
  const app = { ...APP_A, burst: 2, rate_per_minute: 10 };
  queue.enqueue(app, sms('one')); queue.enqueue(app, sms('two'));
  assert.equal(queue.enqueue(app, sms('one')).created, false);
  assert.throws(() => queue.enqueue(app, sms('three')), statusError(429, true));
  const recovered = new QueueStore(storage, {}, queue.clock);
  assert.throws(() => recovered.enqueue(app, sms('three')), statusError(429));
  advance(6000); assert.equal(recovered.enqueue(app, sms('three')).created, true);
  db.close();
});
test('global limit rolls back per-app token and daily accounting atomically', () => {
  const { queue, db } = setup({ GLOBAL_SMS_BURST: 1 });
  queue.enqueue(APP_A, sms());
  assert.throws(() => queue.enqueue(APP_B, sms()), statusError(429));
  assert.equal(db.prepare('SELECT * FROM buckets WHERE id=?').get('sms:alerts'), undefined);
  assert.equal(db.prepare('SELECT * FROM daily_usage WHERE app_id=?').get('alerts'), undefined);
  db.close();
});
test('per-app and global queue capacities reject overload while matching retries work', () => {
  const { queue, db } = setup({ MAX_PENDING: 2 });
  const app = { ...APP_A, max_pending: 1 };
  queue.enqueue(app, sms('one'));
  assert.throws(() => queue.enqueue(app, sms('two')), statusError(429, true));
  queue.enqueue(APP_B, sms());
  assert.throws(() => queue.enqueue({ id: 'third' }, sms()), statusError(429));
  assert.equal(queue.enqueue(app, sms('one')).created, false);
  db.close();
});
test('daily admission quotas count cancelled jobs and reset on the next UTC day', () => {
  const { queue, advance, db } = setup();
  const app = { ...APP_A, daily_limit: 1 };
  const first = queue.enqueue(app, sms()).job; queue.cancel(app.id, first.id);
  assert.throws(() => queue.enqueue(app, sms('next')), statusError(429, true));
  advance(86400000); assert.equal(queue.enqueue(app, sms('next')).created, true);
  db.close();
});
test('fair scheduling gives waiting applications turns, with only one in-flight job', () => {
  const { queue, db } = setup();
  queue.enqueue(APP_A, sms('a1')); queue.enqueue(APP_A, sms('a2')); queue.enqueue(APP_A, sms('a3'));
  queue.enqueue(APP_B, sms('b1')); queue.enqueue(APP_B, sms('b2'));
  const first = queue.device('claim', { token: token(1) });
  assert.equal(first.app_id, APP_A.id);
  assert.equal(queue.device('claim', { token: token(2) }), null);
  assert.equal(queue.device('claim', { token: token(1) }).id, first.id);
  finish(queue, first, token(1));
  const second = queue.device('claim', { token: token(2) });
  assert.equal(second.app_id, APP_B.id); finish(queue, second, token(2));
  assert.equal(queue.device('claim', { token: token(3) }).app_id, APP_A.id);
  db.close();
});
test('expiry and cancellation only affect queued work; scoped list/get are consistent', () => {
  const { queue, advance, db } = setup();
  const one = queue.enqueue(APP_A, sms('one', { ttl_seconds: 60 })).job;
  const two = queue.enqueue(APP_A, sms('two')).job;
  assert.equal(queue.cancel(APP_A.id, two.id).status, 'cancelled');
  assert.throws(() => queue.cancel(APP_B.id, one.id), statusError(404));
  advance(60000); assert.equal(queue.get(APP_A.id, one.id).status, 'expired');
  assert.equal(queue.device('claim', { token: token(1) }), null);
  assert.equal(queue.list(APP_A.id, new URLSearchParams('limit=1')).jobs.length, 1);
  assert.equal(queue.counts(APP_A.id).pending, 0);
  assert.throws(() => queue.list(APP_A.id, new URLSearchParams('limit=51')), statusError(422));
  db.close();
});
test('lost start/result replies replay safely and never overwrite terminal results', () => {
  const { queue, db } = setup();
  queue.enqueue(APP_A, sms()); const row = queue.device('claim', { token: token(1) });
  assert.throws(() => queue.device('result', { token: token(1), id: row.id, status: 'submitted' }), statusError(409));
  queue.device('start', { token: token(1), id: row.id }); queue.device('start', { token: token(1), id: row.id });
  assert.throws(() => queue.cancel(APP_A.id, row.id), statusError(409));
  finish(queue, row, token(1));
  assert.equal(queue.device('result', { token: token(1), id: row.id, status: 'unknown' }).status, 'submitted');
  assert.equal(queue.device('claim', { token: token(1) }).status, 'submitted');
  assert.throws(() => queue.device('start', { token: token(1), id: row.id }), statusError(409));
  assert.throws(() => queue.device('result', { token: token(2), id: row.id, status: 'submitted' }), statusError(404));
  db.close();
});
test('HTTP authentication, validation and Retry-After are enforced', async () => {
  const { call, db } = setup();
  assert.equal((await call('/api/v1/sms', sms(), DEVICE_KEY)).status, 401);
  assert.equal((await call('/device/ws', undefined, APP_A.key)).status, 401);
  assert.equal((await call('/device/ws', undefined, DEVICE_KEY)).status, 426);
  for (const message of ['', 'x'.repeat(71), '😀', '\u0000', '\ud800'])
    assert.equal((await call('/api/v1/sms', sms('bad', { message }))).status, 422);
  assert.equal((await call('/api/v1/sms', sms('bad', { message: 'x'.repeat(2000) }))).status, 413);
  for (let i = 0; i < 5; i++) assert.equal((await call('/api/v1/sms', sms(`job-${i}`))).status, 202);
  const limited = await call('/api/v1/sms', sms('overflow'));
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  db.close();
});
test('WebSocket protocol supports push, correlated replies, status and invalid frame rejection', async () => {
  const { hub, call, sockets, db } = setup();
  const socket = { readyState: 1, sent: [], attachment: {},
    send(value) { this.sent.push(JSON.parse(value)); },
    close(code) { this.code = code; this.readyState = 3; },
    serializeAttachment(value) { this.attachment = value; }, deserializeAttachment() { return this.attachment; } };
  sockets.push(socket);
  await call('/api/v1/sms', sms()); assert.equal(socket.sent[0].type, 'available');
  hub.webSocketMessage(socket, JSON.stringify({ type: 'claim', request_id: 1, body: { token: token(1) } }));
  const reply = socket.sent.find(x => x.type === 'reply'); assert.equal(reply.request_id, 1); assert.equal(reply.body.status, 'claimed');
  hub.webSocketMessage(socket, JSON.stringify({ type: 'status', ready: true }));
  assert.equal((await (await call('/api/v1/health')).json()).device_ready, true);
  hub.webSocketMessage(socket, 'x'.repeat(2049)); assert.equal(socket.code, 1009);
  db.close();
});

test('existing /sms-send/ number/message contract uses the same durable queue and limits', async () => {
  const { call, queue, db } = setup();
  const payload = { number: '+639171234567', message: 'Existing application' };
  const first = await call('/sms-send/', payload);
  assert.equal(first.status, 200);
  const result = await first.json();
  assert.equal(result.success, true);
  assert.equal(result.message, 'SMS job sent to gateway.');
  assert.deepEqual(result.data, payload);
  assert.equal(result.job.status, 'queued');
  const key = first.headers.get('Idempotency-Key'); assert.ok(key);
  const retry = await call('/sms-send', payload, APP_A.key, 'POST', { 'Idempotency-Key': key });
  assert.equal((await retry.json()).job.id, result.job.id);
  const claimed = queue.device('claim', { token: token(1) });
  assert.equal(claimed.phone, payload.number);
  assert.equal(claimed.id, result.job.id);
  const conflict = await call('/sms-send/', { ...payload, message: 'changed' }, APP_A.key, 'POST', { 'Idempotency-Key': key });
  assert.equal(conflict.status, 409);
  const missing = await call('/sms-send/', { number: payload.number });
  assert.equal(missing.status, 400); assert.equal((await missing.json()).message, 'Number and message are required.');
  for (let i = 0; i < 4; i++) assert.equal((await call('/sms-send/', payload)).status, 200);
  const limited = await call('/sms-send/', payload);
  assert.equal(limited.status, 429); assert.ok(limited.headers.get('Retry-After'));
  db.close();
});
test('compatibility keys are scoped per app, conflicts are rejected and canonical API accepts number', async () => {
  const { call, db } = setup();
  const payload = { number: '+639171234567', message: 'Compatible', idempotency_key: 'same-key' };
  const a = await (await call('/sms-send/', payload)).json();
  const b = await (await call('/sms-send/', payload, APP_B.key)).json();
  assert.notEqual(a.job.id, b.job.id);
  assert.equal((await call(a.job.status_url, undefined, APP_B.key)).status, 404);
  assert.equal((await call('/sms-send/', payload, APP_A.key, 'POST', { 'Idempotency-Key': 'different' })).status, 409);
  assert.equal((await call('/sms-send/', { ...payload, phone: '+1234' })).status, 422);
  assert.equal((await call('/api/v1/sms', { ...payload, idempotency_key: 'canonical' })).status, 202);
  assert.equal((await call('/sms-send/', payload, DEVICE_KEY)).status, 401);
  db.close();
});

test('Cloudflare supports the Node backend API prefix, canonical trailing slash and health probe', async () => {
  const { call, db } = setup();
  assert.equal((await call('/healthz', undefined, 'not-a-key')).status, 200);
  const legacy = await call('/api/sms-send/', { number: '+1234', message: 'existing app', idempotency_key: 'prefix' });
  assert.equal(legacy.status, 200); assert.equal((await legacy.json()).success, true);
  assert.equal((await call('/api/v1/sms/', sms('canonical-trailing'))).status, 202);
  const health = await (await call('/api/v1/health/')).json();
  assert.equal(health.transport, 'websocket'); assert.equal(health.device_connected, false);
  db.close();
});
test('Cloudflare rejects placeholder/shared credentials and preserves legacy APP_KEY support', async () => {
  const { hub, call, db } = setup();
  hub.env = { APP_KEY: APP_A.key, DEVICE_KEY };
  assert.equal((await call('/sms-send', { number: '+1234', message: 'legacy key' })).status, 200);
  hub.env = { APP_KEY: DEVICE_KEY, DEVICE_KEY };
  assert.equal((await call('/api/v1/health')).status, 503);
  hub.env = { APP_KEY: APP_A.key, DEVICE_KEY: 'YOUR_DEVICE_TOKEN_SHOULD_BE_RANDOM_AND_PRIVATE' };
  assert.equal((await call('/healthz')).status, 503);
  db.close();
});
test('recreating a hibernating Cloudflare hub retains socket attachments, claims and rate state', async () => {
  const { ctx, hub, call, queue, sockets, db } = setup();
  const socket = { readyState: 1, sent: [], attachment: {},
    send(value) { this.sent.push(JSON.parse(value)); }, close(code) { this.code = code; this.readyState = 3; },
    serializeAttachment(value) { this.attachment = value; }, deserializeAttachment() { return this.attachment; } };
  sockets.push(socket);
  await call('/api/v1/sms', sms());
  hub.webSocketMessage(socket, JSON.stringify({ type: 'status', ready: true }));
  hub.webSocketMessage(socket, JSON.stringify({ type: 'claim', request_id: 1, body: { token: token(1) } }));
  const original = socket.sent.find(value => value.type === 'reply').body;
  const recovered = new GatewayHub(ctx, hub.env); recovered.queue.clock = queue.clock;
  recovered.webSocketMessage(socket, JSON.stringify({ type: 'claim', request_id: 2, body: { token: token(1) } }));
  const replay = socket.sent.find(value => value.request_id === 2).body;
  assert.equal(replay.id, original.id); assert.equal(replay.status, 'claimed');
  assert.equal((await (await recovered.fetch(new Request('https://relay.example/api/v1/health', {
    headers: { Authorization: `Bearer ${APP_A.key}` },
  }))).json()).device_ready, true);
  recovered.webSocketMessage(socket, JSON.stringify({ type: 'claim', request_id: 0x100000000, body: { token: token(1) } }));
  assert.equal(socket.sent.at(-1).status, 422);
  db.close();
});
