import type { RequestHandler } from "express";
import { AppError } from "./error.middleware.js";

export const requireJson: RequestHandler = (req, _res, next) => {
  next(
    req.is("application/json")
      ? undefined
      : new AppError(415, "Content-Type must be application/json"),
  );
};

export function readJsonObject(body: unknown): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body as Uint8Array));
  } catch {
    throw new AppError(400, "Invalid UTF-8 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError(400, "JSON object required");
  return value as Record<string, unknown>;
}
