import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { GatewayConfig } from "./types/gateway.types.js";
import { matchesToken } from "./middlewares/auth.middleware.js";
import { AppError } from "./middlewares/error.middleware.js";
import type { SmsService } from "./modules/sms/sms.services.js";
import type { GatewaySocket, DeviceFrame } from "./modules/device/device.types.js";
import { parseDeviceFrame } from "./modules/device/device.validation.js";
import { processDeviceRequest } from "./modules/device/device.services.js";
export function createRealtime(
  server: Server,
  queue: SmsService,
  config: GatewayConfig,
  isClosing: () => boolean,
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  let device: GatewaySocket | null = null;
  const clock = () => Date.now();
  const log = (message: string) => console.log(`[ESP32] ${message}`);
  function send(socket: GatewaySocket, frame: unknown) {
    if (socket.readyState !== WebSocket.OPEN) {
      log(`Skipped outbound ${String((frame as { type?: unknown })?.type ?? "frame")}: WebSocket is not open (state ${socket.readyState}).`);
      return;
    }
    if (socket.bufferedAmount > 8192) {
      log("Closing connection because the outbound buffer exceeded 8192 bytes.");
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify(frame), (error) => {
      if (error) {
        log(`Failed to send outbound ${String((frame as { type?: unknown })?.type ?? "frame")}: ${error.message}`);
        socket.terminate();
      } else {
        log(`Sent outbound ${String((frame as { type?: unknown })?.type ?? "frame")}${(frame as { request_id?: unknown })?.request_id !== undefined ? ` (request_id=${String((frame as { request_id?: unknown }).request_id)})` : ""}.`);
      }
    });
  }
  function notify() {
    if (device) send(device, { type: "available" });
    else log("SMS queue changed; ESP32 is not connected, so no availability notification was sent.");
  }
  function rejectUpgrade(socket: Duplex, status: number, text: string) {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    let path;
    try {
      path = new URL(req.url || "/", "http://gateway").pathname;
    } catch {
      return rejectUpgrade(socket, 400, "Bad Request");
    }
    if (isClosing() || path !== "/device/ws") {
      log(`Rejected WebSocket upgrade for ${path}: ${isClosing() ? "server is shutting down" : "unknown path"}.`);
      return rejectUpgrade(socket, 404, "Not Found");
    }
    if (!matchesToken(req.headers.authorization, config.deviceKey)) {
      log("Rejected WebSocket upgrade: invalid or missing device authorization.");
      return rejectUpgrade(socket, 401, "Unauthorized");
    }
    log("Accepted authenticated WebSocket upgrade request.");
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws) => {
    const socket = ws as GatewaySocket;
    const previous = device;
    device = socket;
    log("WebSocket connection established.");
    socket.ready = false;
    socket.lastStatusAt = 0;
    socket.lastSeenAt = clock();
    socket.alive = true;
    if (previous) {
      log("Replacing the previous ESP32 WebSocket connection with a new one.");
      previous.close(4001, "Replaced by new device connection");
      const timer = setTimeout(() => previous.terminate(), 2000);
      timer.unref();
    }
    socket.on("pong", () => {
      socket.alive = true;
      socket.lastSeenAt = clock();
    });
    socket.on("error", (error) => {
      log(`WebSocket error: ${error.message}`);
      socket.terminate();
    });
    socket.on("close", (code, reason) => {
      log(`WebSocket connection closed (code=${code}${reason.length ? `, reason=${reason.toString()}` : ""}).`);
      if (device === socket) device = null;
    });
    socket.on("message", (raw, isBinary) => {
      if (device !== socket || isClosing()) return;
      let frame: DeviceFrame | undefined;
      try {
        if (isBinary) return socket.close(1003, "JSON text required");
        queue.deviceBudget();
        frame = parseDeviceFrame(raw.toString());
        socket.lastSeenAt = clock();
        if (frame.type === "status") {
          const wasReady = socket.ready;
          socket.ready = frame.ready === true;
          socket.lastStatusAt = clock();
          log(`Received status frame: ready=${socket.ready}.`);
          if (socket.ready && !wasReady) notify();
          return;
        }
        log(`Received device ${String(frame.type)} frame${Number.isInteger(frame.request_id) ? ` (request_id=${String(frame.request_id)})` : ""}.`);
        const reply = processDeviceRequest(queue, frame);
        log(`Processed device ${String(frame.type)} frame: status=${reply.status}${reply.body && "id" in reply.body ? `, job_id=${String(reply.body.id)}` : ""}.`);
        send(socket, reply);
        if (frame.type === "result") notify();
      } catch (caught) {
        const error =
          caught instanceof AppError ? caught : new AppError(503, "Gateway unavailable");
        log(`Failed to process device frame${error.status ? ` (${error.status})` : ""}: ${error.message}`);
        if (Number.isInteger(frame?.request_id))
          send(socket, {
            type: "reply",
            request_id: frame?.request_id,
            status: error.status || 503,
            body: { error: error.status ? error.message : "Gateway unavailable" },
          });
        else socket.close(1008, "Invalid or excessive device messages");
      }
    });
    notify();
  });
  const heartbeat = setInterval(() => {
    if (!device || device.readyState !== WebSocket.OPEN) return;
    if (!device.alive) {
      device.terminate();
      return;
    }
    device.alive = false;
    try {
      device.ping();
    } catch {
      device.terminate();
    }
  }, 30000);
  heartbeat.unref();

  return {
    notify,
    getHealth() {
      return {
        device_connected: device?.readyState === WebSocket.OPEN,
        device_ready: Boolean(device?.ready && clock() - device.lastStatusAt < 90000),
        device_last_seen: device?.lastSeenAt || null,
      };
    },
    async close() {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
