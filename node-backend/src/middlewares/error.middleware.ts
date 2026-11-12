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

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const code = error.type === "entity.too.large" ? 413 : error.status || 503;
  const message =
    error.type === "entity.too.large"
      ? "JSON exceeds 1024 bytes"
      : error.status
        ? error.message
        : "Gateway unavailable";
  if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
  res.status(code).json({ success: false, message, error: message });
};
