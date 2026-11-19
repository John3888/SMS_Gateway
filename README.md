# ESP32 SMS gateway

The Next.js dashboard runs on port 3000. The Express gateway on port 5008 accepts application SMS requests and the ESP32 WebSocket at /device/ws. The live queue is in memory. MySQL stores request history for the dashboard.

## Local development

1. In backend run `npm ci` and `npm run setup`. Configure HOST and PORT in .env. On this LAN use HOST=192.168.1.108 and PORT=5008.
2. Set DATABASE_URL to the MySQL connection URL for your gateway database. Set ADMIN_USERNAME and a unique ADMIN_PASSWORD of at least 12 characters in the same file. Set ADMIN_COOKIE_SECURE=false for local HTTP, or true when serving the dashboard over HTTPS.
3. In backend run `npx prisma generate`, `npx prisma migrate deploy`, `npm run build`, and `npm start`.
4. In frontend set GATEWAY_ORIGIN=http://192.168.1.108:5008 in .env.local. Run `npm ci` and `npm run dev`. Open http://192.168.1.108:3000/admin/dashboard.

The frontend proxies /admin-api to the backend. Sign-in creates an HTTP-only session cookie. Sign-out or a gateway restart invalidates the session. Applications still use their own bearer credentials, and the device uses DEVICE_KEY.

## Docker and GitHub Actions

Compose publishes the API on port 5008 and the dashboard on port 3001 (container port 3000). Open http://192.168.1.108:3001/admin/dashboard. Stop any native backend using port 5008 before switching to Compose. Use one gateway instance per database.

Compose reads backend/.env and mounts backend/app-keys.json read-only. For MySQL on the Docker host, put a DATABASE_URL with the same database credentials and host `host.docker.internal` in backend/.env.docker. The database must accept connections from the container. For a remote MySQL server reachable from the containers, use its address directly in DATABASE_URL.

From the project root run `docker compose up --build -d`. The backend applies pending Prisma migrations to the configured database on startup. The web image proxies to http://backend:5008 on the Compose network.

The GitHub workflow builds both images on pull requests to main and publishes sms-gateway-web and sms-gateway-api to GHCR on pushes to main, version tags, or manual dispatch. Runtime credentials are supplied at deployment.

See [backend setup and API](backend/README.md) for gateway configuration and application requests.
