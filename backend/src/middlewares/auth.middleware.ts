import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { GatewayConfig } from "../types/gateway.types.js";
import { AppError } from "./error.middleware.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

export function matchesToken(header: string | undefined, key: string): boolean {
  return typeof header === "string" && timingSafeEqual(digest(header), digest(`Bearer ${key}`));
}

export function requireApplication(config: GatewayConfig): RequestHandler {
  return (req, res, next) => {
    const application = config.apps.find((candidate) =>
      matchesToken(req.get("Authorization"), candidate.key),
    );
    if (!application) return next(new AppError(401, "Invalid application token"));
    res.locals.application = application;
    next();
  };
}
