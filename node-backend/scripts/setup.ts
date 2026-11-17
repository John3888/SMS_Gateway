import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { loadConfig } from "../src/config/env.js";

try {
  const hasEnv = existsSync(".env");
  const envText = hasEnv
    ? readFileSync(".env", "utf8")
    : readFileSync(new URL("../.env.example", import.meta.url), "utf8").replace(
        "REPLACE_WITH_A_DIFFERENT_RANDOM_SECRET_AT_LEAST_32_CHARACTERS",
        randomBytes(32).toString("hex"),
      );
  const environment = { ...dotenv.parse(envText), ...process.env };
  const keyFile = resolve(environment.APP_KEYS_FILE || "./app-keys.json");
  const needsKeys = !environment.APP_KEYS && !existsSync(keyFile);
  const keys = needsKeys
    ? JSON.stringify(
        [{ id: "my-app", key: randomBytes(32).toString("hex"),
          rate_per_minute: 10, burst: 5, daily_limit: 200, max_pending: 20 }],
        null,
        2,
      ) + "\n"
    : undefined;

  // Validate before writing anything. Existing credentials are never replaced.
  loadConfig(keys ? { ...environment, APP_KEYS: keys } : environment);
  if (keys) {
    writeFileSync(keyFile, keys, { flag: "wx", mode: 0o600 });
    console.log("Created missing application-key file at " + keyFile);
  }
  if (!hasEnv) {
    writeFileSync(".env", envText, { flag: "wx", mode: 0o600 });
    console.log("Created missing .env with a random device key.");
  }
  console.log("Configuration is valid. Existing credentials were preserved.");
  console.log("Use the application key in Postman or your application backend; DEVICE_KEY is only for the ESP32.");
} catch (error) {
  console.error("Setup failed: " + (error instanceof Error ? error.message : "Unable to prepare configuration"));
  process.exitCode = 1;
}
