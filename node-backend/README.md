# SMS backend for Cloudflare Workers

Deploy **this `node-backend` folder** to **Cloudflare Workers**. It now contains a native Workers entry point, a SQLite-backed Durable Object for the queue/rate limits, and a persistent device WebSocket using the hibernation API. Your current Arduino firmware and existing applications keep the same protocol and JSON.

```text
Your applications → Cloudflare HTTPS API + durable queue
                                  ↕ secure WebSocket
                                ESP32 → A7670E → SMS
```

Cloudflare hosts the server, HTTPS endpoint and persistent storage. No home PC, VPS, Docker container, local database disk, ngrok or Raspberry Pi is needed for this deployment. The ESP32, modem and Wi-Fi/router still need power and connectivity. Worker/Durable Object usage is subject to your Cloudflare account's limits and billing.

## Deploy from your computer

Use Node 22.13+ or Node 24 for the local tools. From **`node-backend`**:

```sh
npm ci
npm run setup:cloudflare
npx wrangler login
npm run deploy
npm run secrets:cloudflare
```

1. `setup:cloudflare` creates private **`cloudflare-secrets.json`**, the file Wrangler uploads as secrets. It imports valid keys from an existing `.env`/`app-keys.json`/`APP_KEYS` configuration when available, otherwise creates random device/application keys. Existing configuration files are not changed. It refuses to overwrite an existing secrets file; inspect/reuse that file rather than regenerating credentials during upgrades.
2. Review that file. `DEVICE_KEY` is the device token; `APP_KEYS` is a JSON string containing application records, keys and per-app limits. Keep the file private; it is ignored by Git. If your existing Node setup used custom global limits, copy them into the `[vars]` section of `wrangler.toml` before deployment.
3. `wrangler login` connects your computer to your Cloudflare account.
4. `deploy` creates/updates the Worker and its Durable Object binding, then prints the actual hostname.
5. `secrets:cloudflare` uploads `DEVICE_KEY` and `APP_KEYS`. Requests return 503 until valid runtime secrets are configured. The secrets command changes your Cloudflare runtime; run it only after reviewing the local file.

No account changes, secret uploads or deployments have been performed automatically by this project.

The default Worker name in `wrangler.toml` is `sms-relay`, producing a URL like:

```text
https://sms-relay.<your-workers-subdomain>.workers.dev
```

Use the real URL printed by deployment. A custom domain is optional. You can change the Worker name before the first deployment, but changing it later creates a different service/storage namespace.

### Deploy using Cloudflare's Git integration

Choose **Workers**, connect your repository and set:

| Setting | Value |
| --- | --- |
| Root directory | `node-backend` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Local tool/build Node version | 22.13+ or 24 |

Configure the two runtime secrets `DEVICE_KEY` and `APP_KEYS` through Wrangler or the Worker's Variables and Secrets settings. For `APP_KEYS`, use the JSON string value from the prepared secrets file. Do not upload the private file to Git. This is a Worker deployment, not a static Pages site. Keep Wrangler development dependencies available during the build.

## Configure the ESP32

Edit the Arduino sketch's **`gateway_config.h`**:

```cpp
constexpr bool CLOUD_ENABLED = true;
constexpr char CLOUD_HOST[] = "sms-relay.your-workers-subdomain.workers.dev";
constexpr uint16_t CLOUD_PORT = 443;
constexpr char CLOUD_WS_PATH[] = "/device/ws";
constexpr char CLOUD_DEVICE_KEY[] = "THE_DEVICE_KEY_FROM_CLOUDFLARE_SECRETS_JSON";
```

Use your actual host without `https://`, a path or trailing slash. Copy the device token's value, not a JSON property name or enclosing quotes. Fill `CLOUD_ROOT_CA` with the PEM root certificate validating the actual HTTPS chain for that host. Inspect the chain, obtain the root from the issuer's official repository and verify its fingerprint. Retain certificate verification and working Wi-Fi/NTP. The [Arduino setup guide](../arduino/README.md) covers board/libraries/uploading.

The firmware connects to **`wss://<your-host>/device/ws`** at boot, authenticates, stays connected and reconnects when needed. The protocol is standard WebSocket, not Socket.IO. One device connection is active per backend; a new authenticated connection replaces the previous connection.

Your private Arduino configuration has not been changed automatically. Update its host/key/CA to the Cloudflare deployment. Do not erase device NVS while a job is in flight.

## Call from existing applications

In each application's backend, configure:

```env
SMS_GATEWAY_URL=https://sms-relay.your-workers-subdomain.workers.dev
SMS_GATEWAY_API_KEY=THIS_APPLICATIONS_KEY_FROM_APP_KEYS
```

Use an application key, not `DEVICE_KEY`. Each application should have a unique, stable `id` and its own random key in `APP_KEYS`. Keep IDs stable when rotating keys because ownership, quotas and duplicate protection are scoped to them. Up to 32 applications are supported. For later key/quota changes, edit the `APP_KEYS` runtime secret (or update and reupload your private bulk-secrets file) and preserve the other values.

Your existing [Express forwarding controller](../integrations/express/sendSMS.ts) works unchanged with this hostname. Applications can also call the Worker directly from their servers:

```http
POST https://sms-relay.your-workers-subdomain.workers.dev/sms-send/
Authorization: Bearer YOUR_APPLICATION_KEY
Idempotency-Key: notification-001
Content-Type: application/json

{
  "number": "+639171234567",
  "message": "Hello from my application!"
}
```

The response retains `success`, `message` and `data`, and adds `job` with a generated ID and `status_url`. HTTP 200/202 means accepted by the queue, not handset delivery. Store the returned status URL and check it with the same application's key. Phone numbers use international `+countrycode...` strings. Text remains limited to 70 BMP characters per SMS; multipart messages and non-BMP emoji are unsupported.

| Method/path | Purpose |
| --- | --- |
| `POST /sms-send/` | Existing `{ number, message }` JSON and HTTP 200 envelope |
| `POST /api/sms-send/` | Alias for applications using an `/api` prefix |
| `POST /api/v1/sms` | Canonical `{ phone, message, idempotency_key }`; 202 for a new job |
| `GET /api/v1/sms/<id>` | Own application's job status |
| `GET /api/v1/sms?page=0&limit=20` | Own history; limit 1-50 |
| `DELETE /api/v1/sms/<id>` | Cancel a queued job |
| `GET /api/v1/health` | Own pending count and device connection/readiness |
| `GET /healthz` | Service/storage/configuration probe; no application key required |

All routes except `/healthz` require the appropriate application or device bearer token. Both trailing-slash forms work. Cross-application job access returns 404. Local ESP32 sends remain disabled while cloud mode is enabled so shared application limits apply.

Use a stable `Idempotency-Key` header or `idempotency_key` field for retries; both must match if supplied together. The same application/key with identical number, message and TTL returns the original job without consuming another SMS allowance. Conflicting content returns 409. Compatibility routes generate a key if absent, but then each separate POST is a separate job; the canonical route requires a key. Keys use 1-64 ASCII letters, digits, hyphens or underscores.

Optional `ttl_seconds` is 60-86400, default 3600, for time waiting queued. Statuses are `queued`, `claimed`, `sending`, `submitted`, `failed`, `unknown`, `cancelled`, `expired`. `submitted` means modem-confirmed submission. Claimed/sending work is not automatically expired or requeued; inspect ambiguous work before another send.

## Limits and durable state

The shared queue/scheduler code is used by both Workers and the optional Node server. Requests, jobs, rate buckets, daily quotas and scheduler turns are stored in the Durable Object's SQLite database and survive Worker hibernation/restarts.

| Control | Default |
| --- | --- |
| Each application's SMS admissions | 10/minute, burst 5 |
| Each application's daily admissions | 200/day, resets at 00:00 UTC |
| Each application's pending jobs | 20 |
| Gateway-wide admissions | 12/minute, burst 10 |
| Total pending jobs | 100 |
| Each application's API requests | 120/minute, burst 30 |
| Device protocol messages | 240/minute, burst 30 |
| Physical modem concurrency | One job; firmware minimum pause five seconds |

Per-app limits are in `APP_KEYS`; global limits are `[vars]` in `wrangler.toml`. Token buckets allow bursts and gradual refill, rather than fixed calendar-minute windows. The scheduler gives waiting applications turns, keeping FIFO within each. Daily allowances count accepted jobs even if later cancelled, failed or expired. Quota checks and insertion are transactional. Actual cellular throughput can be lower than the configured admission limit.

Overload returns **429** with `Retry-After` in seconds. Wait before retrying with the same request key; use backoff/jitter for connectivity failures. Matching retries still consume the general API request allowance. Avoid rapid status polling. Hosting edge controls handle unauthenticated connection traffic; application quotas do not replace those controls.

Completed records are retained until explicitly removed; deleting records also deletes their duplicate protection. Backend failures/reconnects do not trigger blind SMS retries: the ESP32 persists its claim/submission/result state in NVS. A restart during an armed submission reports `unknown`, requiring inspection. This is not an exactly-once handset delivery guarantee.

### Keep storage identity stable on upgrades

Keep the Worker name, Durable Object class `GatewayHub`, binding `GATEWAY`, named object `gateway` and migration history stable. The provided `v1-websocket` migration enables SQLite storage. These identifiers match the earlier `cloud-relay` implementation, so updating the same Worker/account with the same identifiers retains that Durable Object's queue. Do not deploy both folders independently to the same Worker name.

Local Node `data/sms.sqlite` files are not automatically imported into Cloudflare. Settle/export existing work before switching a device from a local/VPS Node backend. Cloudflare manages the persistent storage; `DB_PATH`, `HOST`, `PORT`, Docker and Caddy settings are not used by the Workers build.

## Local checks

```sh
npm test
npm run build
npm run dev -- --env-file .dev.vars.example --local
```

In another terminal, from this folder:

```sh
npm run test:live:cloudflare
```

`.dev.vars.example` contains public local-test credentials, never production credentials. The live check is loopback-only, simulates modem results and must not share a real device's queue. `npm test` covers queue/HTTP/auth/recovery behavior for Node and Workers. The live check uses a real local Workers/Durable Object runtime and WebSocket; physical SMS and deployed TLS still need testing.

The optional standalone Express/SQLite server remains available through `npm start`/`npm run dev:node`; its [VPS/container guide](README.node.md) is retained. **For Cloudflare, use `npm run deploy`**, not that server command. The older top-level `cloud-relay` folder is not needed to deploy this folder.

References: [Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
