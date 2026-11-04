import { QueueStore, HttpError, publicJob } from '../queue.mjs';
import { normalizeSms, legacyResponse } from '../compat.mjs';
import { validSecret, validateConfig } from '../settings.mjs';
const json = (value, status = 200, headers = {}) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store', ...headers },
});
function errorReply(error) {
  const message = error.status ? error.message : 'Gateway storage unavailable';
  return json({ success: false, message, error: message },
    error.status || 503, error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
}
async function readBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || ''))
    throw new HttpError(415, 'Content-Type must be application/json');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'JSON object required');
  let size = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 1024) { await reader.cancel(); throw new HttpError(413, 'JSON exceeds 1024 bytes'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, 'Invalid UTF-8 JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON object required');
  return body;
}
async function keyMatches(received, key) {
  if (!validSecret(key)) return false;
  const encoder = new TextEncoder();
  const digests = await Promise.all([received, `Bearer ${key}`].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const a = new Uint8Array(digests[0]), b = new Uint8Array(digests[1]);
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function authenticate(request, env, device = false) {
  const settings = workerSettings(env);
  const header = request.headers.get('Authorization') || '';
  if (device) {
    if (!await keyMatches(header, settings.deviceKey)) throw new HttpError(401, 'Invalid device token');
    return;
  }
  for (const app of settings.apps) if (await keyMatches(header, app.key)) return app;
  throw new HttpError(401, 'Invalid application token');
}
function workerSettings(env) {
  try {
    return validateConfig({ deviceKey: env.DEVICE_KEY,
      apps: env.APP_KEYS ? JSON.parse(env.APP_KEYS) : [{ id: 'default', key: env.APP_KEY }],
      limits: { MAX_PENDING: env.MAX_PENDING, GLOBAL_SMS_PER_MINUTE: env.GLOBAL_SMS_PER_MINUTE, GLOBAL_SMS_BURST: env.GLOBAL_SMS_BURST } });
  } catch { throw new HttpError(503, 'Configure Cloudflare DEVICE_KEY, APP_KEYS and valid queue limits'); }
}
export class GatewayHub {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.queue = new QueueStore(ctx.storage, env); }
  notify() {
    for (const socket of this.ctx.getWebSockets('device')) {
      try { socket.send(JSON.stringify({ type: 'available' })); } catch { /* reconnect resumes */ }
    }
  }
  async fetch(request) {
    try {
      const url = new URL(request.url), path = url.pathname.replace(/\/+$/, '') || '/';
      if (request.method === 'GET' && path === '/healthz') {
        workerSettings(this.env); this.ctx.storage.sql.exec('SELECT 1');
        return json({ status: 'ok' });
      }
      if (path === '/device/ws') {
        await authenticate(request, this.env, true);
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'WebSocket upgrade required');
        for (const socket of this.ctx.getWebSockets('device')) socket.close(4001, 'Replaced by new connection');
        const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server, ['device']);
        server.serializeAttachment({ ready: false, lastStatusAt: 0, lastSeenAt: Date.now() });
        server.send(JSON.stringify({ type: 'available' }));
        return new Response(null, { status: 101, webSocket: client });
      }
      const app = await authenticate(request, this.env);
      this.queue.requestBudget(app.id);
      const legacy = path === '/sms-send' || path === '/api/sms-send';
      if (request.method === 'POST' && (path === '/api/v1/sms' || legacy)) {
        const body = await readBody(request);
        if (legacy && (!(body.number ?? body.phone) || !body.message))
          throw new HttpError(400, 'Number and message are required.');
        const normalized = normalizeSms(body, request.headers.get('Idempotency-Key'), legacy);
        const result = this.queue.enqueue(app, normalized);
        if (result.created) this.notify();
        return json(legacy ? legacyResponse(result.job) : publicJob(result.job), legacy ? 200 : result.created ? 202 : 200,
          { 'Idempotency-Key': result.job.request_key });
      }
      if (request.method === 'GET' && path === '/api/v1/health') {
        const sockets = this.ctx.getWebSockets('device').filter(socket => socket.readyState === 1);
        const attachment = sockets[0]?.deserializeAttachment();
        return json({ relay: 'online', transport: 'websocket', ...this.queue.counts(app.id), device_connected: sockets.length > 0,
          device_ready: Boolean(attachment?.ready && Date.now() - (attachment.lastStatusAt ?? attachment.seen ?? 0) < 90000),
          device_last_seen: attachment?.lastSeenAt ?? attachment?.seen ?? null });
      }
      if (request.method === 'GET' && path === '/api/v1/sms') return json(this.queue.list(app.id, url.searchParams));
      if (path.startsWith('/api/v1/sms/')) {
        const id = path.slice('/api/v1/sms/'.length);
        if (request.method === 'GET') return json(publicJob(this.queue.get(app.id, id)));
        if (request.method === 'DELETE') return json(publicJob(this.queue.cancel(app.id, id)));
      }
      throw new HttpError(404, 'Endpoint not found');
    } catch (error) { return errorReply(error); }
  }
  webSocketMessage(socket, message) {
    if (!this.ctx.getWebSockets('device').includes(socket) || socket.readyState !== 1) return;
    let request;
    try {
      if (typeof message !== 'string') return socket.close(1003, 'JSON text required');
      if (new TextEncoder().encode(message).length > 2048) return socket.close(1009, 'Text frame limit 2048 bytes');
      this.queue.deviceBudget();
      try { request = JSON.parse(message); } catch { throw new HttpError(400, 'Invalid JSON'); }
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new HttpError(400, 'Invalid message');
      const attachment = socket.deserializeAttachment() || {};
      socket.serializeAttachment({ ...attachment, lastSeenAt: Date.now() });
      if (request.type === 'status') {
        const ready = request.ready === true;
        const wasReady = attachment.ready === true;
        socket.serializeAttachment({ ready, lastStatusAt: Date.now(), lastSeenAt: Date.now() });
        if (ready && !wasReady) this.notify();
        return;
      }
      if (!Number.isInteger(request.request_id) || request.request_id < 1 || request.request_id > 0xffffffff) throw new HttpError(422, 'Invalid request_id');
      const result = this.queue.device(request.type, request.body);
      socket.send(JSON.stringify({ type: 'reply', request_id: request.request_id, status: result ? 200 : 204,
        body: result ? publicJob(result, true) : {} }));
      if (request.type === 'result') this.notify();
    } catch (error) {
      if (Number.isInteger(request?.request_id)) socket.send(JSON.stringify({ type: 'reply', request_id: request.request_id,
        status: error.status || 503, body: { error: error.status ? error.message : 'Storage unavailable' } }));
      else socket.close(1008, 'Invalid or excessive device requests');
    }
  }
  webSocketClose(socket, code) { try { socket.close(code === 1005 ? 1000 : code, 'Disconnected'); } catch {} }
  webSocketError(socket) { try { socket.close(1011, 'Connection error'); } catch {} }
}
export default {
  async fetch(request, env) {
    try { return await env.GATEWAY.get(env.GATEWAY.idFromName('gateway')).fetch(request); }
    catch { return errorReply(new HttpError(503, 'Gateway storage unavailable')); }
  },
};
