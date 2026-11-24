import type { ErrorRequestHandler } from "express";

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter = 0,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const code = error.type === "entity.too.large" ? 413 : error.status || 503;
  const message =
    error.type === "entity.too.large"
      ? "JSON exceeds 1024 bytes"
      : error.status
        ? error.message
        : "Gateway unavailable";
  if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));

  // Browser navigations to protected API URLs should return to the admin UI.
  // Fetch/API clients do not send an explicit text/html Accept type and keep JSON errors.
  const acceptsHtml = /(?:^|,)\s*text\/html(?:\s*;|\s*,|$)/i.test(
    req.get("Accept") || "",
  );
  if (code === 401 && req.method === "GET" && acceptsHtml) {
    res.redirect(303, "/admin/dashboard");
    return;
  }

  res.status(code).json({ success: false, message, error: message });
};
