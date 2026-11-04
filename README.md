# ESP32 SMS gateway

Use these two parts:

- **[Arduino firmware](arduino/README.md):** open `arduino/SMS_Gateway/SMS_Gateway.ino` in Arduino IDE.
- **[Node backend](node-backend/README.md):** deploy `node-backend` to an always-on Node host with HTTPS, WebSocket support and a persistent disk.

```text
Your applications → Node API + queue ← WebSocket connection initiated by ESP32
                                                    ↓
                                              A7670E sends SMS
```

From `node-backend`, with Node 24 installed:

```sh
npm ci
npm run setup
npm start
```

The setup command creates separate random device/application keys. The local HTTP listener defaults to port 3000; production uses your host's HTTPS/WSS endpoint on port 443. Follow the backend guide to deploy and set the Arduino host, device key and trusted root certificate. No PC needs to stay on at home; the ESP32, modem and Wi-Fi/router do.

Applications call authenticated `POST /sms-send/` with `{ "number": "+639171234567", "message": "Hello!" }`. The API keeps a durable SQLite queue, per-app keys/quotas, fair scheduling, idempotency, status, expiry and queued-job cancellation. The existing [Express controller](integrations/express/sendSMS.ts) can forward your application's route to this backend.

`cloud-relay` is the older Cloudflare alternative and is not required for Node hosting. The Node folder is self-contained and uses the current firmware's standard WebSocket protocol at `/device/ws`, rather than Socket.IO. Your private Arduino configuration is preserved; update its host/key/CA to the backend you choose. Nothing has been deployed or flashed automatically.
