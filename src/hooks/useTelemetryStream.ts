import { useState, useEffect, useRef, useCallback } from "react";
import { vodApi } from "../api/client";
import type { Config, SessionsDeltaPayload, Status } from "../types";

const MAX_CLIENT_LOGS = 300;

interface UseTelemetryStreamOptions {
  isConfigDirty: boolean;
  onServerConfigSynced?: (nextConfig: Config) => void;
}

export function useTelemetryStream({
  isConfigDirty,
  onServerConfigSynced,
}: UseTelemetryStreamOptions) {
  const [status, setStatus] = useState<Status | null>(null);
  const [savedConfig, setSavedConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [sseConnected, setSseConnected] = useState<boolean>(false);

  const isConfigDirtyRef = useRef<boolean>(isConfigDirty);
  const onServerConfigSyncedRef = useRef(onServerConfigSynced);
  const initializedRef = useRef<boolean>(false);

  useEffect(() => {
    isConfigDirtyRef.current = isConfigDirty;
  }, [isConfigDirty]);

  useEffect(() => {
    onServerConfigSyncedRef.current = onServerConfigSynced;
  }, [onServerConfigSynced]);

  const refreshStatus = useCallback(async () => {
    try {
      const nextStatus = await vodApi.getStatus();
      if (nextStatus && typeof nextStatus === "object") {
        setStatus(nextStatus);
      }
    } catch (err) {
      console.warn("Failed to refresh status snapshot", err);
    }
  }, []);

  const refreshConfig = useCallback(async (): Promise<Config | null> => {
    try {
      const nextConfig = await vodApi.getConfig();
      if (nextConfig && typeof nextConfig === "object") {
        setSavedConfig(nextConfig);
        onServerConfigSyncedRef.current?.(nextConfig);
        return nextConfig;
      }
    } catch (err) {
      console.warn("Failed to refresh configuration", err);
    }
    return null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let fallbackPollInterval: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const clearFallbackPolling = () => {
      if (fallbackPollInterval) {
        clearInterval(fallbackPollInterval);
        fallbackPollInterval = null;
      }
    };

    const startFallbackPolling = () => {
      if (cancelled || fallbackPollInterval) return;
      fallbackPollInterval = setInterval(() => {
        if (!document.hidden) {
          refreshStatus();
        }
      }, 5000);
    };

    // Initial HTTP bootstrap in parallel with SSE connection so first paint never stalls
    (async () => {
      try {
        const [initialConfig, initialStatus] = await Promise.all([
          vodApi.getConfig().catch(() => null),
          vodApi.getStatus().catch(() => null),
        ]);
        if (cancelled) return;
        if (initialConfig && !initializedRef.current) {
          setSavedConfig(initialConfig);
          onServerConfigSyncedRef.current?.(initialConfig);
        }
        if (initialStatus) {
          setStatus((prev) => prev || initialStatus);
        }
      } finally {
        if (!cancelled) {
          initializedRef.current = true;
          setLoading(false);
        }
      }
    })();

    const connectEventSource = () => {
      if (cancelled) return;
      if (es) {
        es.close();
        es = null;
      }

      const source = new EventSource("/api/events");
      es = source;

      source.onopen = () => {
        if (cancelled) return;
        setSseConnected(true);
        clearFallbackPolling();
      };

      source.addEventListener("snapshot", (event: MessageEvent) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(event.data) as { status?: Status; config?: Config };
          if (parsed.status) {
            setStatus(parsed.status);
          }
          if (parsed.config) {
            setSavedConfig(parsed.config);
            if (!initializedRef.current || !isConfigDirtyRef.current) {
              onServerConfigSyncedRef.current?.(parsed.config);
            }
          }
          initializedRef.current = true;
          setLoading(false);
          setSseConnected(true);
          clearFallbackPolling();
        } catch (err) {
          console.warn("Malformed SSE snapshot payload", err);
        }
      });

      source.addEventListener("log", (event: MessageEvent) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(event.data) as { line?: string };
          if (typeof parsed.line === "string") {
            const line = parsed.line;
            setStatus((prev) => {
              if (!prev) return prev;
              const nextLogs =
                prev.logs.length >= MAX_CLIENT_LOGS
                  ? [...prev.logs.slice(prev.logs.length - MAX_CLIENT_LOGS + 1), line]
                  : [...prev.logs, line];
              return { ...prev, logs: nextLogs };
            });
          }
        } catch {
          // Ignore malformed log frame
        }
      });

      source.addEventListener("logs_cleared", () => {
        if (cancelled) return;
        setStatus((prev) => (prev ? { ...prev, logs: [] } : prev));
      });

      source.addEventListener("tasks", (event: MessageEvent) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(event.data) as { activeTasks?: Status["activeTasks"] };
          if (Array.isArray(parsed.activeTasks)) {
            setStatus((prev) =>
              prev ? { ...prev, activeTasks: parsed.activeTasks! } : prev
            );
          }
        } catch {
          // Ignore malformed tasks frame
        }
      });

      source.addEventListener("sessions", (event: MessageEvent) => {
        if (cancelled) return;
        try {
          const delta = JSON.parse(event.data) as SessionsDeltaPayload;
          if (delta && typeof delta === "object") {
            setStatus((prev) =>
              prev
                ? {
                    ...prev,
                    isMonitoring: delta.isMonitoring,
                    monitoredChannels: delta.monitoredChannels,
                    isLive: delta.isLive,
                    lastCheckTime: delta.lastCheckTime,
                    systemHealth: delta.systemHealth ?? prev.systemHealth,
                    activeSessions: delta.activeSessions,
                  }
                : {
                    ...delta,
                    logs: [],
                    activeTasks: [],
                  }
            );
          }
        } catch {
          // Ignore malformed sessions frame
        }
      });

      source.addEventListener("config", (event: MessageEvent) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(event.data) as { config?: Config };
          if (parsed.config && typeof parsed.config === "object") {
            setSavedConfig(parsed.config);
            if (!isConfigDirtyRef.current) {
              onServerConfigSyncedRef.current?.(parsed.config);
            }
          }
        } catch {
          // Ignore malformed config frame
        }
      });

      source.onerror = () => {
        if (cancelled) return;
        setSseConnected(false);
        startFallbackPolling();
        // If browser permanently closed the EventSource (readyState === CLOSED), schedule explicit reconnect
        if (source.readyState === EventSource.CLOSED) {
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            connectEventSource();
          }, 3000);
        }
      };
    };

    connectEventSource();

    const handleVisibilityChange = () => {
      if (!document.hidden && (!es || es.readyState === EventSource.CLOSED)) {
        refreshStatus();
        connectEventSource();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      clearFallbackPolling();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (es) {
        es.close();
        es = null;
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refreshStatus]);

  return {
    status,
    setStatus,
    savedConfig,
    setSavedConfig,
    loading,
    sseConnected,
    refreshStatus,
    refreshConfig,
  };
}
