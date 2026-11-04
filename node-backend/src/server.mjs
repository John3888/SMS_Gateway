import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { validateConfig, matches } from './config.mjs';
import { openStorage } from './storage.mjs';
import { QueueStore, HttpError, publicJob } from './queue.mjs';
import { normalizeSms, legacyResponse } from './compat.mjs';

export function createGateway(options) {
  const config = validateConfig(options);
  const storage = openStorage(config.dbPath || './data/sms.sqlite');
  const queue = new QueueStore(storage, config.limits, options.clock);
  const app = express();
  app.disable('x-powered-by');
  const server = createServer({ maxHeaderSize: 16384 }, app);
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  let device = null, closing = false;
  const clock = () => Date.now();
  function send(socket, frame) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 8192) { socket.terminate(); return; }
    socket.send(JSON.stringify(frame), error => { if (error) socket.terminate(); });
  }
  function notify() { if (device) send(device, { type: 'available' }); }
  function rejectUpgrade(socket, status, text) {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    let path;
    try { path = new URL(req.url, 'http://gateway').pathname; }
    catch { return rejectUpgrade(socket, 400, 'Bad Request'); }
    if (closing || path !== '/device/ws') return rejectUpgrade(socket, 404, 'Not Found');
    if (!matches(req.headers.authorization, config.deviceKey)) return rejectUpgrade(socket, 401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', socket => {
    const previous = device;
    device = socket;
    socket.ready = false; socket.lastStatusAt = 0; socket.lastSeenAt = clock(); socket.alive = true;
    if (previous) {
      previous.close(4001, 'Replaced by new device connection');
      const timer = setTimeout(() => previous.terminate(), 2000); timer.unref();
    }
    socket.on('pong', () => { socket.alive = true; socket.lastSeenAt = clock(); });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => { if (device === socket) device = null; });
    socket.on('message', (raw, isBinary) => {
      if (device !== socket || closing) return;
      let frame;
      try {
        if (isBinary) return socket.close(1003, 'JSON text required');
        queue.deviceBudget();
        try { frame = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new HttpError(400, 'Invalid message');
        socket.lastSeenAt = clock();
        if (frame.type === 'status') {
          const wasReady = socket.ready;
          socket.ready = frame.ready === true; socket.lastStatusAt = clock();
          if (socket.ready && !wasReady) notify();
          return;
        }
        if (!Number.isInteger(frame.request_id) || frame.request_id < 1 || frame.request_id > 0xffffffff)
          throw new HttpError(422, 'Invalid request_id');
        const row = queue.device(frame.type, frame.body);
        send(socket, { type: 'reply', request_id: frame.request_id, status: row ? 200 : 204, body: row ? publicJob(row, true) : {} });
        if (frame.type === 'result') notify();
      } catch (error) {
        if (Number.isInteger(frame?.request_id)) send(socket, { type: 'reply', request_id: frame.request_id,
          status: error.status || 503, body: { error: error.status ? error.message : 'Queue storage unavailable' } });
        else socket.close(1008, 'Invalid or excessive device messages');
      }
    });
    notify();
  });
  const heartbeat = setInterval(() => {
    if (!device || device.readyState !== WebSocket.OPEN) return;
    if (!device.alive) { device.terminate(); return; }
    device.alive = false;
    try { device.ping(); } catch { device.terminate(); }
  }, 30000);
  heartbeat.unref();

  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/healthz', (_req, res, next) => {
    try { storage.sql.exec('SELECT 1'); res.json({ status: 'ok' }); } catch (error) { next(error); }
  });
  app.all('/device/ws', (req, _res, next) => next(new HttpError(
    matches(req.get('Authorization'), config.deviceKey) ? 426 : 401, 'Authenticated WebSocket upgrade required')));
  app.use((req, res, next) => {
    const application = config.apps.find(candidate => matches(req.get('Authorization'), candidate.key));
    if (!application) return next(new HttpError(401, 'Invalid application token'));
    res.locals.application = application;
    try { queue.requestBudget(application.id); next(); } catch (error) { next(error); }
  });
  const rawJson = express.raw({ type: () => true, limit: 1024 });
  function requireJson(req, _res, next) {
    next(req.is('application/json') ? undefined : new HttpError(415, 'Content-Type must be application/json'));
  }
  function submit(req, res, next) {
    try {
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(req.body)); }
      catch { throw new HttpError(400, 'Invalid UTF-8 JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON object required');
      const legacy = req.path.replace(/\/+$/, '') !== '/api/v1/sms';
      if (legacy && (!(body.number ?? body.phone) || !body.message)) throw new HttpError(400, 'Number and message are required.');
      const normalized = normalizeSms(body, req.get('Idempotency-Key'), legacy);
      const result = queue.enqueue(res.locals.application, normalized);
      if (result.created) notify();
      res.set('Idempotency-Key', result.job.request_key);
      res.status(legacy ? 200 : result.created ? 202 : 200).json(legacy ? legacyResponse(result.job) : publicJob(result.job));
    } catch (error) { next(error); }
  }
  app.post(['/sms-send', '/api/sms-send', '/api/v1/sms'], requireJson, rawJson, submit);
  app.get('/api/v1/health', (_req, res) => res.json({
    relay: 'online', transport: 'websocket', ...queue.counts(res.locals.application.id),
    device_connected: device?.readyState === WebSocket.OPEN,
    device_ready: Boolean(device?.ready && clock() - device.lastStatusAt < 90000),
    device_last_seen: device?.lastSeenAt || null,
  }));
  app.get('/api/v1/sms', (req, res) => res.json(queue.list(res.locals.application.id, new URL(req.originalUrl, 'http://gateway').searchParams)));
  app.get('/api/v1/sms/:id', (req, res) => res.json(publicJob(queue.get(res.locals.application.id, req.params.id))));
  app.delete('/api/v1/sms/:id', (req, res) => res.json(publicJob(queue.cancel(res.locals.application.id, req.params.id))));
  app.use((_req, _res, next) => next(new HttpError(404, 'Endpoint not found')));
  app.use((error, _req, res, _next) => {
    const code = error.type === 'entity.too.large' ? 413 : error.status || 503;
    const message = error.type === 'entity.too.large' ? 'JSON exceeds 1024 bytes' : error.status ? error.message : 'Gateway storage unavailable';
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    res.status(code).json({ success: false, message, error: message });
  });
  return {
    app, server, queue,
    listen(port = config.port || 3000, host = config.host || '127.0.0.1') {
      return new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(server.address()); };
        server.once('error', onError); server.once('listening', onListening); server.listen(port, host);
      });
    },
    async close() {
      if (closing) return;
      closing = true; clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      await new Promise(resolve => wss.close(resolve));
      if (server.listening) {
        await new Promise(resolve => {
          server.close(resolve); server.closeIdleConnections();
          const timeout = setTimeout(() => server.closeAllConnections(), 1000); timeout.unref();
        });
      }
      storage.close();
    },
  };
}
