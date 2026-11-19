import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import type { loadAdminConfig } from "../../config/env.js";

const digest = (value: string) => createHash("sha256").update(value).digest();
const lifetime = 8 * 60 * 60 * 1000;
const cookieName = "gateway_session";

export function authenticationRoutes(admin: NonNullable<ReturnType<typeof loadAdminConfig>>) {
  const router = Router();
  const sessions = new Map<string, number>();
  const username = digest(admin.username);
  const password = digest(admin.password);
  const cookie = { httpOnly: true, sameSite: "strict" as const, secure: admin.secureCookie, path: "/admin-api" };
  // The gateway runs as a single instance behind the admin UI proxy.
  let failures = 0;
  let windowEnd = 0;
  router.post("/authentication/login", express.json({ limit: "2kb" }), (req, res) => {
    const now = Date.now();
    if (now >= windowEnd) {
      failures = 0;
      windowEnd = now + 60000;
    }
    if (failures >= 15) {
      res.set("Retry-After", String(Math.ceil((windowEnd - now) / 1000))).sendStatus(429);
      return;
    }
    const body = req.body;
    if (typeof body?.username !== "string" || typeof body.password !== "string" ||
        !timingSafeEqual(digest(body.username), username) || !timingSafeEqual(digest(body.password), password)) {
      failures++;
      res.sendStatus(401);
      return;
    }
    for (const [id, expires] of sessions) {
      if (expires <= now) sessions.delete(id);
    }
    if (sessions.size >= 128) sessions.delete(sessions.keys().next().value!);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, now + lifetime);
    res.cookie(cookieName, token, { ...cookie, maxAge: lifetime }).sendStatus(204);
  });

  router.use((req, res, next) => {
    const token = req.headers.cookie?.match(/(?:^|;\s*)gateway_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    if (!token || (sessions.get(token) ?? 0) <= Date.now()) {
      if (token) sessions.delete(token);
    } else {
      res.locals.sessionId = token;
    }
    next();
  });
  router.get("/authentication/session", (_req, res) => {
    res.json({ authenticated: Boolean(res.locals.sessionId) });
  });
  router.use((_req, res, next) => {
    if (res.locals.sessionId) next();
    else res.sendStatus(401);
  });
  router.post("/authentication/logout", (_req, res) => {
    sessions.delete(res.locals.sessionId);
    res.clearCookie(cookieName, cookie).sendStatus(204);
  });
  return router;
}
