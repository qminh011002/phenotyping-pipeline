// useLogs — hook for the log viewer.
// Manages: recent log fetch, WebSocket stream, level filtering, auto-scroll pause,
// and connection status.

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { LogStreamClient } from "@/services/websocket";
import { getRecentLogs } from "@/services/api";
import { getBaseUrl } from "@/services/http";
import type { LogEntry, LogLevel } from "@/types/api";

const MAX_LOGS = 500;

export type WsStatus = "connecting" | "connected" | "disconnected";

export interface LogFilters {
  DEBUG: boolean;
  INFO: boolean;
  WARNING: boolean;
  ERROR: boolean;
}

const DEFAULT_FILTERS: LogFilters = { DEBUG: true, INFO: true, WARNING: true, ERROR: true };

export interface UseLogsReturn {
  logs: LogEntry[];
  filteredLogs: LogEntry[];
  filters: LogFilters;
  wsStatus: WsStatus;
  autoScroll: boolean;
  setFilters: (updates: Partial<LogFilters>) => void;
  toggleFilter: (level: LogLevel) => void;
  setAutoScroll: (v: boolean) => void;
  clearLogs: () => void;
}

export function useLogs(): UseLogsReturn {
  const [allLogs, setAllLogs] = useState<LogEntry[]>([]);
  const [filters, setFiltersState] = useState<LogFilters>(DEFAULT_FILTERS);
  const [wsStatus, setWsStatus] = useState<WsStatus>("connecting");
  const [autoScroll, setAutoScroll] = useState(true);
  const clientRef = useRef<LogStreamClient | null>(null);

  // Load recent history on mount
  useEffect(() => {
    let cancelled = false;
    getRecentLogs(200)
      .then(({ logs }) => { if (!cancelled) setAllLogs(logs); })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, []);

  // Connect WebSocket
  useEffect(() => {
    const client = new LogStreamClient({
      onLog: (entry) => {
        setAllLogs((prev) => {
          const next = [entry, ...prev];
          return next.length > MAX_LOGS ? next.slice(0, MAX_LOGS) : next;
        });
      },
      onHeartbeat: () => { /* no-op */ },
      onConnect: () => setWsStatus("connected"),
      onDisconnect: () => setWsStatus("disconnected"),
      onError: () => setWsStatus("disconnected"),
    });

    clientRef.current = client;
    setWsStatus("connecting");
    client.connect(getBaseUrl());

    return () => { client.disconnect(); };
  }, []);

  const toggleFilter = useCallback((level: LogLevel) => {
    setFiltersState((prev) => ({ ...prev, [level]: !prev[level] }));
  }, []);

  const setFilters = useCallback((updates: Partial<LogFilters>) => {
    setFiltersState((prev) => ({ ...prev, ...updates }));
  }, []);

  const clearLogs = useCallback(() => {
    setAllLogs([]);
  }, []);

  const filteredLogs = useMemo(
    () => allLogs.filter((log) => filters[log.level]),
    [allLogs, filters],
  );

  return {
    logs: allLogs,
    filteredLogs,
    filters,
    wsStatus,
    autoScroll,
    setAutoScroll,
    toggleFilter,
    setFilters,
    clearLogs,
  };
}
