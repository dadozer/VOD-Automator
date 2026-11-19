import React, { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { ArrowDown, Download, Search, X } from "lucide-react";

type LogCategory = "all" | "errors" | "video" | "chat";

interface SystemLogViewProps {
  logs: string[];
}

export const SystemLogView: React.FC<SystemLogViewProps> = ({ logs }) => {
  const [logSearchQuery, setLogSearchQuery] = useState<string>("");
  const [logCategory, setLogCategory] = useState<LogCategory>("all");
  const [autoScrollLogs, setAutoScrollLogs] = useState<boolean>(true);
  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScrollLogs && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScrollLogs]);

  const handleLogScroll = () => {
    if (!logContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 40;
    setAutoScrollLogs(isAtBottom);
  };

  const scrollToBottomLogs = () => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      setAutoScrollLogs(true);
    }
  };

  const filteredLogs = logs.filter((line) => {
    const lower = line.toLowerCase();
    if (logCategory === "errors") {
      if (
        !lower.includes("error") &&
        !lower.includes("warn") &&
        !lower.includes("critical") &&
        !lower.includes("fail")
      ) {
        return false;
      }
    } else if (logCategory === "video") {
      if (
        !lower.includes("[video") &&
        !lower.includes("[stitch") &&
        !lower.includes("[backfill]") &&
        !lower.includes("[game slicing]") &&
        !lower.includes("[game change]") &&
        !lower.includes("[manual splice") &&
        !lower.includes("[time splice]") &&
        !lower.includes("[recovery]") &&
        !lower.includes("[stream") &&
        !lower.includes("[resumption") &&
        !lower.includes("[session resumption]")
      ) {
        return false;
      }
    } else if (logCategory === "chat") {
      if (
        !lower.includes("[chat") &&
        !lower.includes("[vod chat]") &&
        !lower.includes("[render") &&
        !lower.includes("[auto-render]") &&
        !lower.includes("[manual render]") &&
        !lower.includes("[pubsub]") &&
        !lower.includes("[hermes]") &&
        !lower.includes("[emotes]") &&
        !lower.includes("[game profile]")
      ) {
        return false;
      }
    }
    if (logSearchQuery.trim()) {
      return lower.includes(logSearchQuery.trim().toLowerCase());
    }
    return true;
  });

  return (
    <motion.div
      key="logs"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="space-y-5"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold text-white tracking-tight">System Log</h2>
          <p className="text-sm text-gray-400 mt-0.5">
            Real-time SSE tail of all monitoring, recording, and compilation events.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {!autoScrollLogs ? (
            <button
              type="button"
              onClick={scrollToBottomLogs}
              className="flex items-center gap-2 px-3 py-2 bg-purple-600/20 text-purple-400 border border-purple-500/30 hover:bg-purple-600 hover:text-white rounded-lg text-sm font-semibold transition-all shadow-sm cursor-pointer"
            >
              <ArrowDown className="w-4 h-4 animate-bounce" />
              Auto-scroll paused (click to resume)
            </button>
          ) : (
            <span className="flex items-center gap-2 text-sm text-gray-400 bg-white/5 px-3 py-1.5 rounded-lg border border-white/5 font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Auto-scroll on
            </span>
          )}
          <a
            href="/api/system-log"
            download="system.log"
            className="flex items-center gap-2 px-3 py-2 bg-white/5 hover:bg-white/10 text-gray-300 rounded-lg text-sm font-semibold transition-colors border border-white/10"
          >
            <Download className="w-4 h-4" />
            Download File
          </a>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="bg-[#111113] border border-white/10 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={logSearchQuery}
            onChange={(e) => setLogSearchQuery(e.target.value)}
            placeholder="Filter logs by keyword, channel, error, or sequence..."
            className="w-full bg-[#18181b] border border-white/10 rounded-lg pl-9 pr-8 py-1.5 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-purple-500/50"
          />
          {logSearchQuery && (
            <button
              type="button"
              onClick={() => setLogSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { id: "all", label: "All Events" },
              { id: "errors", label: "Errors & Warnings" },
              { id: "video", label: "Video & Stitch" },
              { id: "chat", label: "Chat & Render" },
            ] as const
          ).map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setLogCategory(cat.id)}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                logCategory === cat.id
                  ? "bg-purple-600 text-white"
                  : "bg-white/5 text-gray-400 hover:text-white hover:bg-white/10"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-[#111113] border border-white/10 rounded-xl overflow-hidden shadow-md">
        <div
          ref={logContainerRef}
          onScroll={handleLogScroll}
          className="p-3 h-[620px] overflow-y-auto font-mono tabular-nums text-xs leading-tight space-y-0 scrollbar-thin scrollbar-thumb-white/10"
        >
          {filteredLogs.length === 0 ? (
            <div className="text-gray-500 text-center py-20 text-xs">
              {logs.length === 0
                ? "No logs recorded yet."
                : "No log entries match your current filter."}
            </div>
          ) : (
            filteredLogs.map((log, i) => {
              const lower = log.toLowerCase();
              const isErr =
                lower.includes("error]") ||
                lower.includes("critical") ||
                lower.includes("fatal") ||
                lower.includes("failed");
              const isWarn =
                !isErr && (lower.includes("warn") || lower.includes("warning]"));
              return (
                <div
                  key={i}
                  className={`px-2 py-[1px] leading-[1.3] rounded-sm transition-colors break-words font-mono select-text whitespace-pre-wrap ${
                    isErr
                      ? "text-red-300 bg-red-500/10 hover:bg-red-500/15"
                      : isWarn
                      ? "text-amber-300 bg-amber-500/10 hover:bg-amber-500/15"
                      : "text-gray-300 hover:bg-white/[0.04]"
                  }`}
                >
                  {log}
                </div>
              );
            })
          )}
        </div>
      </div>
    </motion.div>
  );
};
