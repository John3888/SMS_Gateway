# WebSocket SMS relay

**Alternative backend:** the project now also includes a [standalone Node backend](../node-backend/README.md) with the same device protocol and SMS API. Use that folder for Node hosting; this folder is only for Cloudflare Workers. Deploy one backend and point the ESP32 to that host.

Applications use an authenticated HTTPS API. The ESP32 maintains **one outbound secure WebSocket** to the relay. New jobs are pushed as availability notifications; the device reserves one job and returns its result through the same connection. There is no periodic HTTP job polling. Wi-Fi/router, ESP32 and modem must stay powered; no Raspberry Pi or ngrok is needed. For the existing Express `/sms-send/` route and `{ number, message }` payload, see the [compatible controller](../integrations/express/README.md).

```text
App A ─┐
App B ─┼─ HTTPS API → durable queue ←→ WSS → ESP32 → A7670E → SMS
App C ─┘
```

The API, queue and rate limits run in a Cloudflare Worker with a SQLite-backed Durable Object. This keeps the WebSocket, scheduler and transactional request accounting together. Queued phone numbers/message contents are stored in the cloud. This firmware uses Wi-Fi for Internet and LTE for SMS.

## Deploy

From this folder, with Node.js/npm installed:

```sh
npm ci
npx wrangler login
```

Copy `app-keys.example.json` to `app-keys.json`. Give each application a stable unique `id`, a different random `key` (at least 32 characters), and the desired limits. Generate each key independently, for example:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Store the complete JSON file as the `APP_KEYS` secret. In PowerShell:

```powershell
Get-Content -Raw .\app-keys.json | npx wrangler secret put APP_KEYS
```

Then generate a **different** secret for the ESP32 and enter it at the prompt:

```sh
npx wrangler secret put DEVICE_KEY
npm run deploy
```

The deployment prints the real HTTPS hostname. `wrangler.toml` provisions the `GatewayHub` Durable Object using its migration; there is no separate D1 creation/schema step. Keep that binding, object name and migration history stable across deployments. No cloud service has been provisioned automatically. Cloudflare account features, usage limits and charges depend on your plan.

For compatibility with a single application, `APP_KEY` can be used instead of `APP_KEYS`; it receives application ID `default` and the default limits. `APP_KEYS` takes precedence. Up to 32 applications are supported per relay configuration. Keep application IDs stable when rotating keys: job ownership, quotas and deduplication are scoped to that ID. Do not share app keys, use the device key as an app key, or put secrets in a browser frontend. `app-keys.json` is ignored by Git.

## ESP32 configuration

Open `arduino/SMS_Gateway/SMS_Gateway.ino` in Arduino IDE and follow the [Arduino setup guide](../arduino/README.md). Copy `arduino/SMS_Gateway/gateway_config.example.h` to `gateway_config.h` in that same sketch folder if it is missing. Set Wi-Fi credentials, LAN diagnostic API key, UART pins, and:

```cpp
constexpr bool CLOUD_ENABLED = true;
constexpr char CLOUD_HOST[] = "sms-relay.your-account.workers.dev";
constexpr uint16_t CLOUD_PORT = 443;
constexpr char CLOUD_WS_PATH[] = "/device/ws";
constexpr char CLOUD_DEVICE_KEY[] = "YOUR_DEVICE_KEY";
```

`CLOUD_HOST` is the real hostname from deployment, without `https://`, `wss://`, path or trailing slash. The connection is always TLS (`wss://`). Fill `CLOUD_ROOT_CA` with the PEM root CA validating the certificate chain of that hostname. Inspect the chain using your browser's certificate viewer, obtain the root from the issuer's official repository and verify its fingerprint, then copy the complete PEM including BEGIN/END lines. Roots can be concatenated. Keep trust roots current when the certificate issuer changes. NTP must work so certificate validity dates can be checked; certificate checking is never disabled.

Verify/upload using Arduino IDE. The WebSocket task independently handles ping/pong, status updates and reconnection (five-second reconnect interval by default). A cellular submission can take up to two minutes while the socket remains serviced. Only one device connection is allowed: a new authenticated connection replaces the previous one.

In WebSocket mode, local `POST /api/v1/sms` returns 403 so requests cannot bypass the shared application quotas and scheduler. Local authenticated health/status reads remain available; health includes `cloud_connected`. For LAN-only operation, set `CLOUD_ENABLED=false`; its separate RAM queue accepts 10 new messages/minute with burst 5 by default. LAN-only rate buckets and jobs reset on reboot.

## Application API

Compatibility route: authenticated `POST /sms-send/` (or `/sms-send`) accepts `{ "number": "+639171234567", "message": "Hello" }` and returns HTTP 200 with your existing `success`, `message`, `data` fields plus `job` tracking details. It uses the exact same queue and quotas. Supply `Idempotency-Key` or `idempotency_key` for safe retries; otherwise each POST gets a new generated key (returned in the response). On `/api/v1/sms`, `number` is also accepted as an alias for `phone`, but a request key remains required. Conflicting aliases/keys are rejected. Your unchanged `io.emit('new_sms', ...)` is not a direct device protocol; use the supplied Express controller to preserve the HTTP contract while changing that submission step.

Keep `SMS_GATEWAY_URL=https://<your-relay-host>` and that application's `SMS_GATEWAY_API_KEY` in your deployed backend's environment. Every API request needs `Authorization: Bearer <application-key>`.

```http
POST /api/v1/sms
Authorization: Bearer YOUR_APPLICATION_KEY
Content-Type: application/json

{
  "phone": "+639171234567",
  "message": "Hello from my application!",
  "idempotency_key": "notification-001",
  "ttl_seconds": 3600
}
```

`phone` is `+` and 2–15 digits without a leading zero. `message` is 1–70 BMP characters; multipart SMS and non-BMP emoji are unsupported. `idempotency_key` is 1–64 ASCII letters, digits, hyphens or underscores. Optional `ttl_seconds` defaults to 3600 and accepts 60–86400. It limits how long a job can wait **queued**; claimed/sending work is not automatically expired or reassigned.

The API returns 202 for a newly queued job:

```json
{
  "id": "server-generated-uuid",
  "idempotency_key": "notification-001",
  "status": "queued",
  "status_url": "/api/v1/sms/server-generated-uuid",
  "created_at": 1793793600000,
  "expires_at": 1793797200000
}
```

Use the returned `status_url`; cloud IDs are now server-generated, not the idempotency key. Matching retries from the same application return the original job with 200 and do not consume another SMS allowance. Changing phone, text or TTL for a retained key returns 409. Different applications may reuse the same key without colliding.

| Method/path | Behavior |
| --- | --- |
| `GET /api/v1/sms/<id>` | Own application's job status |
| `GET /api/v1/sms?page=0&limit=20` | Own job history, newest first; limit 1–50 |
| `DELETE /api/v1/sms/<id>` | Cancel a queued job; repeated cancellation is safe |
| `GET /api/v1/health` | Own pending count, total queue capacity, socket/readiness information |

Cross-application lookups/cancellation return 404. Cancellation after reservation/sending returns 409. Health's `device_connected` indicates a socket exists; `device_ready` is the latest device report (fresh within 90 seconds), not a guarantee that the next SMS will succeed.

Statuses are `queued`, `claimed`, `sending`, `submitted`, `failed`, `unknown`, `cancelled`, `expired`. `submitted` means the modem confirmed submission; it does not prove handset delivery. Expiry is applied when the queue is inspected or work is requested. History pages use offsets and can shift while new jobs arrive.

## Limits and scheduling

| Scope | Default |
| --- | --- |
| Each application's new SMS admission | 10/minute, burst 5 |
| Each application's daily admission quota | 200/day, reset at 00:00 UTC |
| Each application's pending jobs | 20 |
| Gateway's new SMS admission | 12/minute, burst 10 |
| Gateway's total pending jobs | 100 |
| Each application's API requests, including status/retries | 120/minute, burst 30 |
| Device protocol messages | 240/minute, burst 30 |
| Physical SMS concurrency | One |
| Minimum pause between device jobs | Five seconds |

Per-app fields are in `app-keys.json`; global fields are in `wrangler.toml`. Physical pacing is `MIN_SMS_INTERVAL_MS` in the firmware. Admission limits are token buckets: short bursts are allowed, followed by gradual refill. They are not fixed calendar-minute windows. The gateway cannot promise 12 actual SMS per minute; cellular delays and the pause reduce throughput.

Jobs are FIFO within an application; waiting applications take turns using least-recently-served scheduling. Pending counts include queued, claimed and sending jobs. Daily allowances count accepted requests, including jobs later cancelled, failed or expired; they are not refunded. Rate/quota/queue checks and insertion are transactional, and cloud limits survive object/device restarts. Completed history is retained until explicitly removed. Removing records removes their duplicate protection; preserve current-day quota counters and active claims during maintenance.

Overload returns HTTP **429** with `Retry-After` in seconds. Wait at least that long, then retry with the **same key, phone, text and TTL**. Matching retries still consume the general API request allowance. Use backoff with jitter for network errors/503, avoid fast status polling (for example, check every 5–10 seconds), and set a deadline relevant to the message. The authenticated API limits do not replace provider edge protection against unauthenticated traffic.

## Recovery and upgrades

The ESP32 persists a claim token before requesting work, an `armed` record before UART submission, and its terminal result before acknowledging it. Lost WebSocket replies are replayed safely with the same token. Power loss while armed reports `unknown` without resending and quarantines sending for that session. Inspect the job/recipient before another restart or a new request. Claimed/sending jobs are never automatically requeued, including after device NVS is erased; investigate stuck work before issuing another SMS. This avoids blind duplicate retries but is not an exactly-once delivery guarantee.

**Upgrading from the earlier HTTP-polling/D1 version:** settle/export its jobs first. The WebSocket version uses a new SQLite-backed Durable Object and does not automatically migrate the previous D1 queue, counters or IDs. Keep any previously deployed database for review. Upgrade both relay and firmware together. Do not erase an active device's NVS or change its storage partitions as a routine upgrade step.

## Verification

`npm test` runs queue/protocol tests using Node.js 22.13+ SQLite. `npm run test:live` uses a real WebSocket against `wrangler dev` with a simulated modem. To run it locally, start a development relay in one terminal with the documented test credentials:

```sh
npx wrangler dev --local --port 8787 --var APP_KEY:local-test-application-key-000000000000000000 --var DEVICE_KEY:local-test-device-key-000000000000000000000
```

Then run `npm run test:live` in another terminal. These credentials are exclusively for local tests; never deploy them. The live test can be configured with `TEST_BASE_URL`, `TEST_APP_KEY`, and `TEST_DEVICE_KEY`; it creates test rows and simulates results, so do not point it at a working hardware gateway.

Before real use, verify your own phone receives an SMS, simultaneous applications receive separate status histories, Wi-Fi reconnects do not duplicate jobs, and power-loss recovery is handled. Hardware, carrier service and production TLS still require physical/deployed testing.

References: [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [transactional SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [Arduino WebSocket client](https://github.com/Links2004/arduinoWebSockets/tree/2.6.1).
