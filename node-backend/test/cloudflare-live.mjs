// Run against wrangler dev --env-file .dev.vars.example. Modem results are
// simulated, so this tool accepts loopback servers only.
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8787';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('This simulated-device test is local-only');
const appKey = process.env.TEST_APP_KEY || 'local-test-application-key-000000000000000000';
const deviceKey = process.env.TEST_DEVICE_KEY || 'local-test-device-key-000000000000000000000';
const sockets = [];
async function connect() {
  const socket = new WebSocket(base.replace(/^http/, 'ws') + '/device/ws', { headers: { Authorization: `Bearer ${deviceKey}` } });
  sockets.push(socket);
  socket.frames = [];
  socket.on('error', () => {});
  socket.on('message', raw => socket.frames.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return socket;
}
async function waitFor(socket, predicate) {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const index = socket.frames.findIndex(predicate);
    if (index >= 0) return socket.frames.splice(index, 1)[0];
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for WebSocket frame');
}
let sequence = 0;
async function rpc(socket, type, body) {
  const id = ++sequence;
  socket.send(JSON.stringify({ type, request_id: id, body }));
  const reply = await waitFor(socket, frame => frame.type === 'reply' && frame.request_id === id);
  assert.equal(reply.status, 200, JSON.stringify(reply)); return reply.body;
}
async function request(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + path, { method,
    headers: { Authorization: `Bearer ${appKey}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { response, body: await response.json() };
}
try {
  const socket = await connect(); await waitFor(socket, frame => frame.type === 'available');
  socket.send(JSON.stringify({ type: 'status', ready: true }));
  await waitFor(socket, frame => frame.type === 'available');
  const payload = { phone: '+639171234567', message: 'WebSocket emulator check', idempotency_key: `smoke-${crypto.randomUUID()}` };
  const created = await request('/api/v1/sms', payload); assert.equal(created.response.status, 202);
  await waitFor(socket, frame => frame.type === 'available');
  assert.equal((await request('/api/v1/sms', payload)).response.status, 200);
  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const job = await rpc(socket, 'claim', { token }); assert.equal(job.id, created.body.id);
  assert.equal((await rpc(socket, 'claim', { token })).id, job.id);
  await rpc(socket, 'start', { token, id: job.id });
  // Simulate a disconnect while the hardware retains its armed/result record.
  socket.close(); const reconnected = await connect();
  await waitFor(reconnected, frame => frame.type === 'available');
  assert.equal((await rpc(reconnected, 'claim', { token })).status, 'sending');
  const result = { token, id: job.id, status: 'submitted', modem_reference: 17 };
  assert.equal((await rpc(reconnected, 'result', result)).status, 'submitted');
  assert.equal((await rpc(reconnected, 'result', { ...result, status: 'unknown' })).status, 'submitted');
  assert.equal((await request(job.status_url)).body.status, 'submitted');
  const legacyPayload = { number: '+639171234567', message: 'Existing Express payload', idempotency_key: `legacy-${crypto.randomUUID()}` };
  const legacy = await request('/api/sms-send/', legacyPayload);
  assert.equal(legacy.response.status, 200); assert.equal(legacy.body.success, true);
  assert.deepEqual(legacy.body.data, { number: legacyPayload.number, message: legacyPayload.message });
  assert.equal((await request('/sms-send/', legacyPayload)).body.job.id, legacy.body.job.id);
  const legacyToken = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const legacyJob = await rpc(reconnected, 'claim', { token: legacyToken });
  assert.equal(legacyJob.id, legacy.body.job.id); assert.equal(legacyJob.phone, legacyPayload.number);
  await rpc(reconnected, 'start', { token: legacyToken, id: legacyJob.id });
  await rpc(reconnected, 'result', { token: legacyToken, id: legacyJob.id, status: 'submitted', modem_reference: 18 });
  const cancelJob = await request('/api/v1/sms', { ...payload, idempotency_key: `cancel-${crypto.randomUUID()}` });
  assert.equal((await request(cancelJob.body.status_url, undefined, 'DELETE')).body.status, 'cancelled');
  assert.equal((await request('/api/v1/sms?limit=10')).response.status, 200);
  console.log('Live Workers/Durable Object WebSocket check passed: push, claim, reconnect, replay, legacy number/message POST, status and cancellation. No SMS sent.');
} finally { for (const socket of sockets) socket.close(); }
