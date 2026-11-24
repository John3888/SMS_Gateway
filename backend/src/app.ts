import { createAudit } from "./modules/admin/admin.services.js";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadAdminConfig, validateConfig } from "./config/env.js";
import type { GatewayOptions } from "./types/gateway.types.js";
import { AppError, errorHandler } from "./middlewares/error.middleware.js";
import { SmsService } from "./modules/sms/sms.services.js";
import { createRealtime } from "./realtime.js";
import { createRoutes } from "./routes.js";
import { createWebhooks } from "./hooks/sms.webhooks.js";
export function createGateway(options: GatewayOptions) {
  const config = validateConfig(options);
  const admin = loadAdminConfig();
  const audit = admin
    ? createAudit(
        config.apps.map((app) => app.id),
        admin,
        () => queue.prune(),
      )
    : null;
  const hooks = createWebhooks(config.apps);
  const queue: SmsService = new SmsService(config.limits, options.clock, job => {
    audit?.record(job);
    if (job.completed_at !== undefined) hooks.notify(job);
  });
  let expiryTimer: NodeJS.Timeout | undefined;
  const app = express();
  app.disable("x-powered-by");
  const server = createServer({ maxHeaderSize: 16384 }, app);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  let closing = false;
  const realtime = createRealtime(server, queue, config, () => closing);
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use((_req, _res, next) =>
    next(closing ? new AppError(503, "Backend is stopping") : undefined),
  );
  if (audit) app.use("/api/admin", audit.router);
  app.use(createRoutes(config, queue, realtime));
  app.use((_req, _res, next) => next(new AppError(404, "Endpoint not found")));
  app.use(errorHandler);
  return {
    app,
    server,
    queue,
    async listen(
      port = config.port || 5400,
      host = config.host || "192.168.1.108",
    ) {
      await audit?.initialize();
      return new Promise<AddressInfo>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          if (config.apps.some(app => app.webhook))
            expiryTimer = setInterval(() => queue.prune(), 1000).unref();
          resolve(server.address() as AddressInfo);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(expiryTimer);
      queue.clear();
      await realtime.close();
      await hooks.drain();
      await audit?.close();
      if (server.listening) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
          const timeout = setTimeout(() => server.closeAllConnections(), 1000);
          timeout.unref();
        });
      }
    },
  };
}
