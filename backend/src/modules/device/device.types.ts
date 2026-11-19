import type { WebSocket } from "ws";
export interface GatewaySocket extends WebSocket {
  ready: boolean;
  lastStatusAt: number;
  lastSeenAt: number;
  alive: boolean;
}
export interface DeviceFrame {
  type?: unknown;
  ready?: unknown;
  request_id?: unknown;
  body?: unknown;
}
export interface DeviceHealth {
  device_connected: boolean;
  device_ready: boolean;
  device_last_seen: number | null;
}
