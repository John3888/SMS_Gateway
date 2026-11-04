import test from 'node:test';
import assert from 'node:assert/strict';
import { sendSMS } from './sendSMS.ts';

function fixture(t, body = { number: '+639171234567', message: 'Existing request' }, headers = {}) {
  const savedFetch = globalThis.fetch, savedBase = process.env.SMS_GATEWAY_URL, savedKey = process.env.SMS_GATEWAY_API_KEY;
  process.env.SMS_GATEWAY_URL = 'https://relay.example/';
  process.env.SMS_GATEWAY_API_KEY = 'a'.repeat(40);
  t.after(() => {
    globalThis.fetch = savedFetch;
    if (savedBase === undefined) delete process.env.SMS_GATEWAY_URL; else process.env.SMS_GATEWAY_URL = savedBase;
    if (savedKey === undefined) delete process.env.SMS_GATEWAY_API_KEY; else process.env.SMS_GATEWAY_API_KEY = savedKey;
  });
  const req = { body, get: name => headers[name] };
  const res = { headers: {}, code: 200, value: undefined,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } };
  return { req, res };
}
test('existing controller payload/response works and creates a stable upstream submission key', async t => {
  const { req, res } = fixture(t); let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return Response.json({ success: true, job: { id: 'job-1', status: 'queued', status_url: '/api/v1/sms/job-1' } });
  };
  await sendSMS(req, res);
  assert.equal(res.code, 200); assert.equal(res.value.success, true);
  assert.equal(res.value.message, 'SMS job sent to gateway.'); assert.deepEqual(res.value.data, req.body);
  assert.equal(captured.url, 'https://relay.example/sms-send/');
  assert.equal(captured.options.headers.Authorization, 'Bearer ' + 'a'.repeat(40));
  assert.deepEqual(JSON.parse(captured.options.body), req.body);
  assert.equal(captured.options.headers['Idempotency-Key'], res.headers['Idempotency-Key']);
  assert.ok(res.headers['Idempotency-Key']);
});
test('missing/non-string fields return the existing validation error without submitting', async t => {
  const { req, res } = fixture(t, { number: '+639171234567' });
  globalThis.fetch = () => { throw new Error('must not call'); };
  await sendSMS(req, res); assert.equal(res.code, 400);
  assert.equal(res.value.message, 'Number and message are required.');
});
test('rate limiting propagates 429 and Retry-After', async t => {
  const { req, res } = fixture(t);
  globalThis.fetch = async () => Response.json({ message: 'Rate limit exceeded' }, { status: 429, headers: { 'Retry-After': '6' } });
  await sendSMS(req, res);
  assert.equal(res.code, 429); assert.equal(res.headers['Retry-After'], '6'); assert.equal(res.value.success, false);
});
test('client-supplied keys survive forwarding and failed requests', async t => {
  const { req, res } = fixture(t, { number: '+1234', message: 'hello' }, { 'Idempotency-Key': 'client-job-1' });
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers['Idempotency-Key'], 'client-job-1'); throw new Error('network unavailable');
  };
  await sendSMS(req, res);
  assert.equal(res.code, 503); assert.equal(res.value.idempotency_key, 'client-job-1');
});
test('mismatched or invalid keys are rejected before forwarding', async t => {
  const { req, res } = fixture(t, { number: '+1234', message: 'hello', idempotency_key: 'body-key' }, { 'Idempotency-Key': 'header-key' });
  globalThis.fetch = () => { throw new Error('must not call'); };
  await sendSMS(req, res); assert.equal(res.code, 409);
});
test('unconfirmed gateway responses do not report success', async t => {
  const { req, res } = fixture(t);
  globalThis.fetch = async () => Response.json({ success: true });
  await sendSMS(req, res); assert.equal(res.code, 502); assert.equal(res.value.success, false);
});
test('non-JSON gateway errors are handled without claiming acceptance', async t => {
  const { req, res } = fixture(t);
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  await sendSMS(req, res); assert.equal(res.code, 502); assert.equal(res.value.success, false);
});
test('missing deployment configuration returns a clear unavailable response', async t => {
  const { req, res } = fixture(t); delete process.env.SMS_GATEWAY_API_KEY;
  globalThis.fetch = () => { throw new Error('must not call'); };
  await sendSMS(req, res); assert.equal(res.code, 503); assert.equal(res.value.success, false);
});
