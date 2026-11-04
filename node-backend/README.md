# Node SMS gateway backend

This is a standalone Node.js backend for your existing ESP32 Arduino firmware. Deploy this folder to an always-on Node host; your applications call its HTTPS API, and the ESP32 opens one outbound authenticated WebSocket connection to it. No Cloudflare Worker, Raspberry Pi, home PC, ngrok or inbound router forwarding is required for production.

```text
App A ─┐
App B ─┼─ HTTPS POST → Node backend + SQLite queue ←→ WSS → ESP32 → A7670E → SMS
App C ─┘
```

This server uses **standard WebSocket at `/device/ws`**, matching the current firmware. It does not use the `/socket.io/` protocol. Your applications only need HTTP requests; they do not maintain a socket themselves. The earlier `cloud-relay` folder is an alternative Cloudflare implementation and is not required when you deploy this backend.

## Start locally

Use **Node.js 24 LTS** (Node 22.13+ is also supported; use Node 22 or 24, not Node 26 with its changed SQLite API). From this folder:

```sh
npm ci
npm run setup
npm start
```

`setup` creates private `.env` and `app-keys.json` files with different random device and application keys. It refuses to overwrite existing credentials. Do not run setup again as a routine restart step. View/edit those files locally; credentials are not printed in startup logs or included in the Docker image. The normal server logs do not include SMS contents or recipient numbers.

By default, the local server listens on `http://127.0.0.1:3000`. Check `GET /healthz` to verify that the process/database responds. That route does not confirm the modem is online. Use an application key for the authenticated API routes below. Local HTTP is for development or the private hop behind your HTTPS proxy; the ESP32 firmware uses TLS and needs the deployed HTTPS hostname.

### Configure keys and limits

`.env` contains the device token, listener settings, SQLite path, application-key file path and global limits. `APP_KEYS` can instead be supplied as a JSON environment secret; when present it overrides the key file. Paths in `.env` are relative to the process working directory, so start the service from this folder or use absolute paths.

Give each existing application its own entry in `app-keys.json`:

```json
[
  {
    "id": "orders",
    "key": "YOUR_UNIQUE_RANDOM_APPLICATION_KEY_AT_LEAST_32_CHARACTERS",
    "rate_per_minute": 10,
    "burst": 5,
    "daily_limit": 200,
    "max_pending": 20
  }
]
```

Use actual random secrets, not that example string. Generate additional keys using `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep application IDs stable when rotating keys: quota accounting, job ownership and idempotency are scoped to the ID. Up to 32 applications are supported. Restart the backend after changing credentials/settings. Keep `DEVICE_KEY` separate from all application keys.

## Deploy online

Deploy **this complete folder**, with Node 24, to a VPS or container host supporting persistent WebSocket connections and a **persistent disk**. Run one backend process/replica for this gateway. Set `HOST=0.0.0.0` if your hosting platform requires it; use the platform's `PORT` environment variable. Store `DB_PATH` on the persistent disk, and keep `.env`/keys in private files or hosting secrets.

SQLite contains the queue, terminal history, rate buckets and daily counters. An ephemeral filesystem will lose that state on redeploy. This implementation is not a stateless serverless function, clustered Node service or multiple-replica deployment. Use one instance and keep its database volume. A SQLite-aware backup, or a backup while the backend is stopped, avoids omitting live WAL data. Completed records are retained; removing history removes that history's duplicate protection.

The public hostname must serve **HTTPS/WSS on port 443**. The hosting platform or a reverse proxy terminates TLS and forwards normal HTTP plus WebSocket upgrades to the Node process on its internal port (3000 by default).

For a VPS using Caddy on the same machine, replace the domain in `deploy/Caddyfile`, point DNS to that server and follow [Caddy's HTTPS reverse-proxy setup](https://caddyserver.com/docs/quick-starts/reverse-proxy). Ports 80/443 must reach Caddy for the normal certificate setup. Caddy forwards `/device/ws` and API paths to `127.0.0.1:3000`.

Docker is optional:

```sh
npm run setup
docker compose up -d --build
```

The provided Compose file binds the HTTP listener to the host's loopback port 3000 for a host-level HTTPS proxy, mounts application keys read-only and keeps SQLite in a named volume. Keep that volume when upgrading. If you use a managed host instead, configure its own HTTPS endpoint and persistent disk. Docker/Caddy configurations are supplied; no host, domain or certificate is provisioned automatically.

## Connect your ESP32

In the Arduino sketch's `gateway_config.h`, set:

```cpp
constexpr bool CLOUD_ENABLED = true;
constexpr char CLOUD_HOST[] = "gateway.your-domain.com";
constexpr uint16_t CLOUD_PORT = 443;
constexpr char CLOUD_WS_PATH[] = "/device/ws";
constexpr char CLOUD_DEVICE_KEY[] = "COPY_DEVICE_KEY_FROM_THE_BACKENDS_ENV_FILE";
```

Use your actual public domain, without `https://` or a path. Copy the exact `DEVICE_KEY` value, not the name `DEVICE_KEY` or a surrounding quotation mark. Supply `CLOUD_ROOT_CA` with the PEM root CA validating that hostname's actual HTTPS chain, as described in the [Arduino setup guide](../arduino/README.md). Do not disable certificate verification. Keep Wi-Fi/NTP working so the device can reach the host and validate certificate dates.

The existing firmware already speaks this protocol: connect at boot, stay connected, process availability notifications, and reconnect when needed. The hostname is now your Node host, not a Cloudflare Workers hostname. Only one ESP32/gateway is supported by this backend instance; another authenticated device connection replaces the previous one. Configure the backend's device key first; arbitrary self-issued tokens are not accepted automatically.

## Call from your existing applications

Store your Node backend URL and the application's own key in each deployed application's backend:

```env
SMS_GATEWAY_URL=https://gateway.your-domain.com
SMS_GATEWAY_API_KEY=THIS_APPLICATIONS_KEY_FROM_APP_KEYS_JSON
```

The existing [Express controller](../integrations/express/sendSMS.ts) works with this Node backend. Keep your frontend route/body; replace its old Socket.IO broadcast with the supplied durable submission controller. If you prefer to call this backend directly from your application server:

```js
const response = await fetch(`${process.env.SMS_GATEWAY_URL}/sms-send/`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.SMS_GATEWAY_API_KEY}`,
    "Content-Type": "application/json",
    "Idempotency-Key": "order-123-notification-1",
  },
  body: JSON.stringify({
    number: "+639171234567",
    message: "Hello from my application!",
  }),
  signal: AbortSignal.timeout(10000),
});
const result = await response.json();
if (!response.ok) throw new Error(`${response.status}: ${result.message}`);
console.log(result.job); // Persist its ID/status_url and check for a terminal status.
```

Keep keys on your application servers, not browser frontends. The gateway does not enable cross-origin browser access. Match your application's existing user authorization before allowing users to submit SMS.

### Endpoints

Every route below requires `Authorization: Bearer <application-key>`:

| Method/path | Purpose |
| --- | --- |
| `POST /sms-send/` | Existing `{ number, message }` body, HTTP 200 acceptance envelope |
| `POST /api/sms-send/` | Alias matching an existing `/api` router prefix |
| `POST /api/v1/sms` | Canonical `{ phone, message, idempotency_key }`, 202 for a new job |
| `GET /api/v1/sms/<id>` | Own application's job status |
| `GET /api/v1/sms?page=0&limit=20` | Own history, newest first; limit 1-50 |
| `DELETE /api/v1/sms/<id>` | Cancel a queued job |
| `GET /api/v1/health` | Own pending count and device connection/readiness |

Both trailing-slash forms work. The device authenticates separately at `wss://<host>/device/ws` using `DEVICE_KEY` in its Authorization header.

The compatibility success response is:

```json
{
  "success": true,
  "message": "SMS job sent to gateway.",
  "data": { "number": "+639171234567", "message": "Hello from my application!" },
  "job": {
    "id": "server-generated-uuid",
    "idempotency_key": "order-123-notification-1",
    "status": "queued",
    "status_url": "/api/v1/sms/server-generated-uuid",
    "created_at": 1793793600000,
    "expires_at": 1793797200000
  }
}
```

HTTP 200/202 confirms acceptance, not cellular transmission or delivery. Statuses are `queued`, `claimed`, `sending`, `submitted`, `failed`, `unknown`, `cancelled`, `expired`. `submitted` is modem confirmation, not proof of handset receipt. The device's readiness report is considered fresh for 90 seconds; it is not a guarantee of future success.

Numbers must be strings in international `+countrycode...` format. Text is 1-70 BMP characters; multipart SMS and non-BMP emoji are unsupported. `number` is an alias of `phone`; conflicting aliases are rejected. Optional `ttl_seconds` defaults to 3600, range 60-86400, and limits time waiting queued. Claimed/sending jobs are not automatically expired or reassigned.

Use a unique `Idempotency-Key` header or `idempotency_key` body field per intended SMS, and reuse it with the same number, text and TTL when retrying. Keys are 1-64 ASCII letters, digits, hyphens or underscores. If both key locations are supplied they must match. Matching retries return the original job without charging another SMS allowance; changed content returns 409. Keys are scoped to each application. The compatibility routes generate a key if none is supplied, but then separate POSTs are separate jobs, even for identical text. The canonical route requires a key. Always use the returned server-generated `status_url` for lookups.

### Default limits

| Control | Default |
| --- | --- |
| Each application's SMS admission | 10/minute, burst 5 |
| Each application's daily admissions | 200; resets at 00:00 UTC |
| Each application's pending jobs | 20 |
| Total pending jobs | 100 |
| Gateway-wide SMS admission | 12/minute, burst 10 |
| Each application's HTTP requests, including status/retries | 120/minute, burst 30 |
| Device protocol messages | 240/minute, burst 30 |
| Physical sending | One job at a time; firmware minimum pause five seconds |

Admission uses token buckets and supports short bursts; it is not a fixed calendar-minute limit or a throughput promise. The scheduler takes turns between waiting applications, keeping FIFO order within each. Pending counts include queued, claimed and sending work. Daily quotas count accepted requests, including those later failed/cancelled/expired, and are not refunded. Invalid requests, duplicate lookups and general API requests still use the request-rate allowance.

Overload returns **429** with `Retry-After` in seconds. Wait that long before retrying with the same key, and use backoff/jitter for connectivity failures. Error JSON has `success: false`, `message` and `error`. Other relevant codes: 400 malformed/missing fields, 401 credentials, 404 missing/another app's job, 409 conflicting key or invalid cancellation, 413 body over 1024 bytes, 415 content type, 422 invalid SMS/TTL, 503 queue storage unavailable. Use hosting-level request limits for unauthenticated traffic; app quotas do not replace edge connection limits.

### Recovery

The backend retains jobs and counters in SQLite. The ESP32 retains its claim token and submission/result record in NVS. A lost claim/start/result acknowledgement is replayed with the same token. An ambiguous send or restart during submission is reported as `unknown`; it is never blindly resubmitted. Inspect unknown/stuck work before restarting or issuing a new SMS. Retain the same database file, application IDs and credentials on normal restarts. Erasing device NVS or deleting the database can break recovery; there is no exactly-once handset delivery guarantee.

Old Cloudflare queue/history is not automatically migrated into this database. Settle/export any existing work before switching hosts, then update the device host/key/CA. The firmware's local health endpoint remains available; local sends are disabled in cloud/WebSocket mode to enforce the shared quotas.

## Tests

```sh
npm test
```

Tests run the actual HTTP server, authenticated WebSocket connections and SQLite storage with a simulated modem. They cover concurrent duplicate submissions, per-app isolation, limits/transaction rollback, fair scheduling, cancellation/expiry, reconnection/result replay, replacing a connection and persistent restart recovery. They do not send real SMS. Test on your own phone after deployment and verify that Wi-Fi interruptions and restarts do not produce duplicates.
