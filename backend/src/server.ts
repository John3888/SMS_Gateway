import dotenv from "dotenv";
import { loadConfig } from "./config/env.js";
import { createGateway } from "./app.js";

dotenv.config({ quiet: true });

let gateway: ReturnType<typeof createGateway> | undefined;
try {
  const config = loadConfig();
  gateway = createGateway(config);
  const address = await gateway.listen();
  console.log(
    `SMS backend listening on ${address.address}:${address.port}; device WebSocket path /device/ws`,
  );
} catch (error) {
  console.error(
    `Startup failed: ${error instanceof Error ? error.message : "Unknown startup error"}`,
  );
  if (gateway) await gateway.close();
  process.exitCode = 1;
}
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    if (gateway) await gateway.close();
  });
