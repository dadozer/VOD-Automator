import React from "react";
import { Activity, HardDrive, Settings, Terminal, Tv } from "lucide-react";
import type { SystemHealth } from "../types";
import { formatBytes, formatUptime } from "../utils/formatters";

export type AppTab = "dashboard" | "settings" | "logs";

interface SidebarProps {
  activeTab: AppTab;
  isConfigDirty: boolean;
  sseConnected: boolean;
  systemHealth?: SystemHealth;
  onSelectTab: (tab: AppTab) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  isConfigDirty,
  sseConnected,
  systemHealth,
  onSelectTab,
}) => {
  return (
    <div className="fixed left-0 top-0 bottom-0 w-68 bg-[#111111] border-r border-white/5 flex flex-col">
      <div className="px-5 py-4 border-b border-white/5 relative">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-purple-600 rounded-lg flex items-center justify-center shadow-md shadow-purple-500/20">
            <Activity className="w-4.5 h-4.5 text-white" />
          </div>
          <div>
            <h1 className="font-bold text-base tracking-tight text-white leading-tight">
              VOD Automator
            </h1>
            <p className="text-xs text-purple-400 font-mono tabular-nums font-medium">
              v6.0.0
            </p>
          </div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1.5 overflow-y-auto">
        <button
          type="button"
          onClick={() => onSelectTab("dashboard")}
          className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-semibold transition-all cursor-pointer ${
            activeTab === "dashboard"
              ? "bg-purple-600/10 text-purple-400 border border-purple-500/20"
              : "text-gray-400 hover:bg-white/5 hover:text-white border border-transparent"
          }`}
        >
          <Tv className="w-4.5 h-4.5" />
          <span>Livestream Monitor</span>
        </button>
        <button
          type="button"
          onClick={() => onSelectTab("settings")}
          className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-semibold transition-all cursor-pointer ${
            activeTab === "settings"
              ? "bg-purple-600/10 text-purple-400 border border-purple-500/20"
              : "text-gray-400 hover:bg-white/5 hover:text-white border border-transparent"
          }`}
        >
          <span className="flex items-center gap-2.5">
            <Settings className="w-4.5 h-4.5" />
            <span>Settings</span>
          </span>
          {isConfigDirty && (
            <span
              className="w-2 h-2 rounded-full bg-amber-400"
              title="Unsaved settings changes"
            />
          )}
        </button>
        <button
          type="button"
          onClick={() => onSelectTab("logs")}
          className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-semibold transition-all cursor-pointer ${
            activeTab === "logs"
              ? "bg-purple-600/10 text-purple-400 border border-purple-500/20"
              : "text-gray-400 hover:bg-white/5 hover:text-white border border-transparent"
          }`}
        >
          <Terminal className="w-4.5 h-4.5" />
          <span>System Log</span>
        </button>
      </nav>

      {/* System Health Card */}
      <div className="p-4 border-t border-white/5 bg-black/25 space-y-3 shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
            <HardDrive className="w-4 h-4 text-purple-400" />
            System Health
          </span>
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono ${
              sseConnected
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                : "bg-amber-500/10 text-amber-300 border border-amber-500/25"
            }`}
            title={
              sseConnected
                ? "Real-time Server-Sent Events telemetry stream connected"
                : "SSE reconnecting — fallback HTTP status polling active"
            }
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                sseConnected ? "bg-emerald-400" : "bg-amber-400 animate-pulse"
              }`}
            />
            {sseConnected ? "Live SSE" : "Polling"}
          </span>
        </div>

        {systemHealth ? (
          <div className="space-y-2.5 text-sm">
            <div className="bg-[#161618] border border-white/5 rounded-lg p-2.5">
              <div className="flex items-center justify-between text-gray-300 mb-1.5">
                <span className="text-xs text-gray-400">Disk Free</span>
                <span className="font-mono tabular-nums font-bold text-white text-xs">
                  {formatBytes(systemHealth.diskFree)}
                </span>
              </div>
              {systemHealth.diskTotal > 0 && (
                <div className="w-full bg-white/10 h-1.5 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      systemHealth.diskFree < 5 * 1024 * 1024 * 1024
                        ? "bg-red-500"
                        : systemHealth.diskFree < 20 * 1024 * 1024 * 1024
                        ? "bg-amber-500"
                        : "bg-emerald-500"
                    }`}
                    style={{
                      width: `${Math.max(
                        0,
                        100 - (systemHealth.diskFree / systemHealth.diskTotal) * 100
                      )}%`,
                    }}
                  />
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 font-mono tabular-nums text-xs">
              <div className="bg-[#161618] border border-white/5 rounded-lg p-2">
                <div className="text-[11px] text-gray-500 uppercase">Memory</div>
                <div className="font-semibold text-gray-200 truncate mt-0.5">
                  {formatBytes(systemHealth.memoryUsed)}
                </div>
              </div>
              <div className="bg-[#161618] border border-white/5 rounded-lg p-2">
                <div className="text-[11px] text-gray-500 uppercase">Uptime</div>
                <div className="font-semibold text-gray-200 truncate mt-0.5">
                  {formatUptime(systemHealth.uptime)}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-xs text-gray-500 font-mono py-1">
            Telemetry loading...
          </div>
        )}
      </div>
    </div>
  );
};
