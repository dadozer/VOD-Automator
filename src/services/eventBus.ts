import type { Response } from "express";
import type { ActiveTask, Config, SessionsDeltaPayload, Status } from "../types";

interface SseClient {
  id: string;
  res: Response;
}

const clients = new Map<string, SseClient>();
let sessionsPayloadBuilder: (() => SessionsDeltaPayload) | null = null;
let tasksFlushTimer: NodeJS.Timeout | null = null;
let sessionsFlushTimer: NodeJS.Timeout | null = null;
let lastSessionsPushMs = 0;

function writeSseFrame(res: Response, eventName: string, data: unknown): boolean {
  try {
    if (res.writableEnded || res.destroyed) return false;
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function broadcastSseEvent(eventName: string, data: unknown): void {
  if (clients.size === 0) return;
  for (const [id, client] of clients.entries()) {
    const ok = writeSseFrame(client.res, eventName, data);
    if (!ok) {
      clients.delete(id);
    }
  }
}

// 15-second keepalive heartbeat so proxies and browsers never drop idle SSE connections
const heartbeatTimer = setInterval(() => {
  if (clients.size === 0) return;
  for (const [id, client] of clients.entries()) {
    try {
      if (client.res.writableEnded || client.res.destroyed) {
        clients.delete(id);
        continue;
      }
      client.res.write(`: keepalive ${Date.now()}\n\n`);
    } catch {
      clients.delete(id);
    }
  }
}, 15_000);
heartbeatTimer.unref?.();

export function registerSessionsPayloadBuilder(builder: () => SessionsDeltaPayload): void {
  sessionsPayloadBuilder = builder;
}

export function getConnectedSseClientCount(): number {
  return clients.size;
}

export function subscribeSseClient(
  res: Response,
  initialSnapshot: { status: Status; config: Config }
): () => void {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const clientId = `sse_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  clients.set(clientId, { id: clientId, res });

  writeSseFrame(res, "snapshot", initialSnapshot);

  return () => {
    clients.delete(clientId);
  };
}

export function emitLogLine(line: string): void {
  if (clients.size === 0 || !line) return;
  broadcastSseEvent("log", { line });
}

export function emitLogsCleared(): void {
  if (clients.size === 0) return;
  broadcastSseEvent("logs_cleared", {});
}

export function emitTasksDelta(getActiveTasks: () => ActiveTask[], immediate = false): void {
  if (clients.size === 0) return;
  if (immediate) {
    if (tasksFlushTimer) {
      clearTimeout(tasksFlushTimer);
      tasksFlushTimer = null;
    }
    broadcastSseEvent("tasks", { activeTasks: getActiveTasks() });
    return;
  }
  if (tasksFlushTimer) return;
  tasksFlushTimer = setTimeout(() => {
    tasksFlushTimer = null;
    broadcastSseEvent("tasks", { activeTasks: getActiveTasks() });
  }, 80);
}

export function emitSessionsDelta(immediate = false): void {
  if (clients.size === 0 || !sessionsPayloadBuilder) return;
  const now = Date.now();
  if (immediate || now - lastSessionsPushMs >= 650) {
    if (sessionsFlushTimer) {
      clearTimeout(sessionsFlushTimer);
      sessionsFlushTimer = null;
    }
    lastSessionsPushMs = now;
    broadcastSseEvent("sessions", sessionsPayloadBuilder());
    return;
  }
  if (sessionsFlushTimer) return;
  const waitMs = Math.max(80, 650 - (now - lastSessionsPushMs));
  sessionsFlushTimer = setTimeout(() => {
    sessionsFlushTimer = null;
    if (clients.size === 0 || !sessionsPayloadBuilder) return;
    lastSessionsPushMs = Date.now();
    broadcastSseEvent("sessions", sessionsPayloadBuilder());
  }, waitMs);
}

export function emitConfigDelta(config: Config): void {
  if (clients.size === 0) return;
  broadcastSseEvent("config", { config });
}
