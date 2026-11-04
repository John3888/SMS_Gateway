# Keep your existing /sms-send/ frontend request

The controller works with the new [standalone Node backend](../../node-backend/README.md). Set `SMS_GATEWAY_URL` to its deployed HTTPS hostname. The ESP32 connects to that same Node host using `/device/ws`; the Cloudflare backend is optional.

Your existing frontend can keep this request to your own deployed Express application:

```http
POST /sms-send/
Content-Type: application/json

{
  "number": "+639171234567",
  "message": "Hello from my application!"
}
```

Keep the router registration, authentication/authorization middleware and `express.json()` middleware. Replace the controller body with **`sendSMS.ts`** from this folder:

```ts
router.post('/sms-send/', sendSMS);
```

Set these environment variables on the deployed backend, then restart/redeploy it:

```env
SMS_GATEWAY_URL=https://gateway.your-domain.com
SMS_GATEWAY_API_KEY=THE_KEY_FOR_THIS_APPLICATION
```

Use your actual backend hostname and that application's key from `app-keys.json` or `APP_KEYS`. This forwarding controller can run on Node.js 18+ with built-in `fetch`; the standalone gateway server itself requires Node 22.13+ or Node 24. Existing Express and Node types are required by your TypeScript project. No additional runtime package is required by this controller. Keep secrets on your backend.

The response retains your existing fields and adds job tracking:

```json
{
  "success": true,
  "message": "SMS job sent to gateway.",
  "data": {
    "number": "+639171234567",
    "message": "Hello from my application!"
  },
  "job": {
    "id": "server-generated-uuid",
    "status": "queued",
    "status_url": "/api/v1/sms/server-generated-uuid"
  }
}
```

HTTP **200 means the durable gateway accepted the request**, not that the handset received the SMS. The full job also includes its idempotency key and timestamps. Use the returned status URL against the relay with your application key to check the result; expose that check through your own authenticated backend if a browser needs it. This example does not add a status-proxy route to your existing application automatically.

## Why the Socket.IO emit changes

`io.emit('new_sms', { number, message })` is an unacknowledged broadcast. A plain WebSocket client cannot consume Socket.IO events directly, and a broadcast alone cannot persist offline work, confirm queue acceptance or return quota errors to the HTTP caller. The provided controller replaces that transport step with a durable relay submission. The ESP32's existing secure WebSocket consumes the shared queue.

Do **not** leave another SMS sender listening to the old broadcast and also forward the same job to this gateway, or both paths could send it. Socket.IO can remain in your application for unrelated features. This update preserves the HTTP route/body/response contract; it is not a direct Socket.IO `new_sms` listener in the firmware. See [Socket.IO's protocol explanation](https://socket.io/docs/v4/) for the distinction.

## Retries and rate limits

The controller propagates the relay's **429** and `Retry-After` header. Application keys, per-app/global limits, fair queue turns, pending-job caps, expiry, status, cancellation and restart protection are retained.

Your original two-field JSON still works. To safely retry across network errors, add a stable `Idempotency-Key` header, or optional `idempotency_key` field. Reuse the same key, number, message and TTL for the same intended SMS. If both key locations are supplied they must match. Keys are 1–64 ASCII letters, digits, hyphens or underscores. The controller generates a new key if absent, forwards it, and returns it in the response header (also in error JSON when submission is unconfirmed). **Without a client-provided stable key, two separate POSTs are two jobs**, even if their text is identical. Do not assume the server can distinguish an intentional repeat from a retry.

Phone numbers must be strings in international `+countrycode...` format. Local numbers such as `0917...` need conversion by your application using its known country; the gateway does not guess the country. SMS text remains limited to 70 BMP characters per message. Optional `ttl_seconds` (60–86400; default 3600) controls time waiting in the queue.

For direct backend-to-relay calls, the relay itself now accepts authenticated **`POST /sms-send/`** (with or without the trailing slash) using the same `{ number, message }` body and response envelope. It also accepts `number` as an alias of `phone` on `/api/v1/sms`; that canonical endpoint still requires an idempotency key. The ESP32 LAN diagnostic API is separate and does not listen for Socket.IO broadcasts.

## Checks

The controller tests run with Node.js 22.13+:

```sh
node --experimental-strip-types --test integrations/express/sendSMS.test.mjs
```

They check the original HTTP contract, credentials, request keys, rate-limit propagation, ambiguous failures and malformed upstream responses. The relay's tests verify that compatibility requests enter the same quota/scheduling pipeline as canonical requests.
