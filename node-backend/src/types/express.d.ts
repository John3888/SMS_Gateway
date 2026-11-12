import type { ApplicationConfig } from "./gateway.types.js";

declare global {
  namespace Express {
    interface Locals {
      application: ApplicationConfig;
    }
  }
}
