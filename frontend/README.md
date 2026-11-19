# SMS gateway admin

Use /admin/dashboard (or /) to view SMS requests by application. Select a request ID to open its Logs tab. Both views refresh every five seconds. The filter lists configured application IDs and IDs with recorded history. Applications use an HTTP API, so this list represents identities rather than live connections.

## Configure the backend

Use one running gateway process. Provision a MySQL database and put its connection URL and administrator credentials in node-backend/.env:

```dotenv
DATABASE_URL="mysql://sms_user:URL_ENCODED_PASSWORD@localhost:3306/sms_gateway"
ADMIN_USERNAME=admin
ADMIN_PASSWORD="<choose a unique password of at least 12 characters>"
ADMIN_COOKIE_SECURE=false
```

Use ADMIN_COOKIE_SECURE=false for local HTTP. Set it to true when deploying with HTTPS. Keep the application and device credentials. From node-backend run:

```sh
npm ci --include=dev
npx prisma generate
npx prisma migrate deploy
npm run build
npm start
```

The gateway records accepted SMS jobs and their status transitions starting when auditing is enabled. The live queue stays in memory. The database stores application, job ID, timestamps, statuses, modem reference or failure detail. The gateway writes history asynchronously. A database outage or abrupt process termination can leave gaps. On startup, unfinished records from an earlier process are marked unknown. With all dashboard settings omitted, the gateway continues in its original memory-only mode.

## Run the panel

From frontend run `npm ci` and `npm run dev`. Open http://192.168.1.108:3000/admin/dashboard on your LAN. Sign in with the configured username and password. Your session lasts up to eight hours and ends on sign-out or a backend restart.

Set GATEWAY_ORIGIN in frontend/.env.local to the backend address reachable from Next.js (here http://192.168.1.108:5008). Docker builds use http://backend:5008. The browser accesses /admin-api on the frontend origin.
