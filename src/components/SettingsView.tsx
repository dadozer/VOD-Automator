import React, { useState } from "react";
import { motion } from "motion/react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Clock,
  Eye,
  EyeOff,
  Film,
  Folder,
  Gamepad2,
  Key,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Scissors,
  Trash2,
} from "lucide-react";
import type { Config, GameResolutionProfile } from "../types";
import { cleanChannel } from "../utils/formatters";

export type SettingsSubTab = "general" | "render" | "render_appearance";

interface SettingsViewProps {
  config: Config | null;
  channelsInput: string;
  isConfigDirty: boolean;
  isSavingConfig: boolean;
  saveStatusMessage: { type: "success" | "error"; text: string } | null;
  isResetting: boolean;
  onChannelsInputChange: (raw: string) => void;
  onUpdateDraftConfig: (next: Config) => void;
  onSaveConfig: (e: React.FormEvent) => void;
  onDiscardChanges: () => void;
  onOpenFolder: (folderPath?: string) => void;
  onOpenManualRenderModal: () => void;
  onRequestReboot: () => void;
  onShowToast: (text: string, type?: "success" | "info" | "error", title?: string) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  config,
  channelsInput,
  isConfigDirty,
  isSavingConfig,
  saveStatusMessage,
  isResetting,
  onChannelsInputChange,
  onUpdateDraftConfig,
  onSaveConfig,
  onDiscardChanges,
  onOpenFolder,
  onOpenManualRenderModal,
  onRequestReboot,
  onShowToast,
}) => {
  const [settingsTab, setSettingsTab] = useState<SettingsSubTab>("general");
  const [showOAuthToken, setShowOAuthToken] = useState<boolean>(false);
  const [newProfileGameName, setNewProfileGameName] = useState<string>("");
  const [newProfileWidth, setNewProfileWidth] = useState<string>("640");
  const [newProfileHeight, setNewProfileHeight] = useState<string>("936");

  if (!config) return null;
  const cr = (config.chatRender || {}) as Record<string, any>;

  const updateChatRenderField = (patch: Record<string, any>) => {
    onUpdateDraftConfig({
      ...config,
      chatRender: {
        ...(config.chatRender || {}),
        ...patch,
      } as any,
    });
  };

  return (
    <motion.div
      key="settings"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="space-y-6"
    >
      <div>
        <h2 className="text-3xl font-bold text-white tracking-tight">Settings</h2>
        <p className="text-sm text-gray-400 mt-0.5">
          Configure stream monitoring, automated game splicing, per-game render profiles, and chat overlay preferences.
        </p>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-white/10 pb-2">
        <button
          type="button"
          onClick={() => setSettingsTab("general")}
          className={`pb-1.5 text-sm font-semibold uppercase tracking-wider transition-colors cursor-pointer ${
            settingsTab === "general"
              ? "border-b-2 border-purple-500 text-purple-400"
              : "text-gray-400 hover:text-white border-b-2 border-transparent"
          }`}
        >
          General
        </button>
        <button
          type="button"
          onClick={() => setSettingsTab("render")}
          className={`pb-1.5 text-sm font-semibold uppercase tracking-wider transition-colors cursor-pointer ${
            settingsTab === "render"
              ? "border-b-2 border-purple-500 text-purple-400"
              : "text-gray-400 hover:text-white border-b-2 border-transparent"
          }`}
        >
          Render: Video &amp; Output
        </button>
        <button
          type="button"
          onClick={() => setSettingsTab("render_appearance")}
          className={`pb-1.5 text-sm font-semibold uppercase tracking-wider transition-colors cursor-pointer ${
            settingsTab === "render_appearance"
              ? "border-b-2 border-purple-500 text-purple-400"
              : "text-gray-400 hover:text-white border-b-2 border-transparent"
          }`}
        >
          Render: Chat &amp; Events
        </button>
      </div>

      <form onSubmit={onSaveConfig} className="space-y-5">
        {settingsTab === "general" && (
          <>
            <div className="bg-blue-500/10 border border-blue-500/20 p-4 rounded-xl flex gap-3.5">
              <Key className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-bold text-blue-400">
                  How to get your OAuth Token
                </h4>
                <p className="text-sm text-blue-200/70 mt-1 leading-relaxed">
                  1. Go to Twitch.tv and log in.
                  <br />
                  2. Press F12 to open Developer Tools, go to the <b>Application</b> tab (or Storage).
                  <br />
                  3. Under <b>Cookies</b>, find the cookie named <code>auth-token</code> and paste its value below.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Browser OAuth Token
                </label>
                <div className="relative">
                  <input
                    type={showOAuthToken ? "text" : "password"}
                    value={config.browserOAuthToken || ""}
                    onChange={(e) =>
                      onUpdateDraftConfig({ ...config, browserOAuthToken: e.target.value })
                    }
                    className="w-full bg-[#141416] border border-white/10 rounded-lg pl-3 pr-10 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                    placeholder="e.g. a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5 (30-char auth-token)"
                  />
                  <button
                    type="button"
                    onClick={() => setShowOAuthToken((prev) => !prev)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white p-1 rounded cursor-pointer"
                    title={showOAuthToken ? "Hide OAuth token" : "Show OAuth token"}
                  >
                    {showOAuthToken ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
                <p className="text-xs text-gray-500">
                  Raw 30-character alphanumeric value from your Twitch{" "}
                  <code>auth-token</code> cookie.
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Browser Client ID
                </label>
                <input
                  type="text"
                  value={config.browserClientId || ""}
                  onChange={(e) =>
                    onUpdateDraftConfig({ ...config, browserClientId: e.target.value })
                  }
                  className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-gray-400"
                  placeholder="kimne78kx3ncx6brgo4mv6wki5h1ko"
                />
                <p className="text-xs text-gray-500">
                  Usually you don&apos;t need to change this.
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Default Channels (comma separated)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-semibold text-sm">
                  twitch.tv/
                </span>
                <input
                  type="text"
                  value={channelsInput}
                  onChange={(e) => {
                    onChannelsInputChange(e.target.value);
                    const parsed = e.target.value
                      .split(",")
                      .map(cleanChannel)
                      .filter(Boolean)
                      .slice(0, 2);
                    onUpdateDraftConfig({ ...config, channels: parsed });
                  }}
                  className="w-full bg-[#141416] border border-white/10 rounded-lg pl-24 pr-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                  placeholder="username1, username2"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Save Path
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={config.savePath || ""}
                    onChange={(e) =>
                      onUpdateDraftConfig({ ...config, savePath: e.target.value })
                    }
                    className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                    placeholder="downloads"
                  />
                  <button
                    type="button"
                    onClick={() => onOpenFolder(config.savePath)}
                    className="flex items-center gap-1.5 px-3 py-2.5 bg-white/5 hover:bg-white/10 text-gray-200 border border-white/10 rounded-lg text-xs font-semibold shrink-0 transition-colors cursor-pointer"
                    title="Open save path folder in OS file explorer"
                  >
                    <Folder className="w-4 h-4 text-purple-400" />
                    <span>Open</span>
                  </button>
                </div>
                <p className="text-xs text-gray-500">
                  Relative to program root folder (default: downloads), or an absolute path.
                </p>
              </div>
              <div className="space-y-2.5 flex flex-col justify-end pb-1">
                <label className="flex items-center gap-2.5 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={config.autoStartMonitoring ?? true}
                    onChange={(e) =>
                      onUpdateDraftConfig({
                        ...config,
                        autoStartMonitoring: e.target.checked,
                      })
                    }
                    className="w-4.5 h-4.5 rounded border-white/20 bg-[#141416] text-purple-600 focus:ring-0 focus:ring-offset-0"
                  />
                  <span className="text-sm text-gray-300 font-medium group-hover:text-white transition-colors">
                    Start monitoring automatically on launch
                  </span>
                </label>
                <label className="flex items-center gap-2.5 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={config.autoRenderChat ?? false}
                    onChange={(e) =>
                      onUpdateDraftConfig({
                        ...config,
                        autoRenderChat: e.target.checked,
                      })
                    }
                    className="w-4.5 h-4.5 rounded border-white/20 bg-[#141416] text-purple-600 focus:ring-0 focus:ring-offset-0"
                  />
                  <span className="text-sm text-gray-300 font-medium group-hover:text-white transition-colors">
                    Auto-render chat segments by default (game switches, backfills &amp; stream end)
                  </span>
                </label>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Clock className="w-4 h-4 text-purple-400" /> Game Switch Buffer (Minutes)
                </label>
                <p className="text-xs text-gray-500">
                  Time buffered before and after a mid-stream game switch or long-broadcast splice
                </p>
                <input
                  type="number"
                  min="0"
                  max="60"
                  value={config.gameSwitchBufferMins ?? 5}
                  onChange={(e) =>
                    onUpdateDraftConfig({
                      ...config,
                      gameSwitchBufferMins: e.target.value as any,
                    })
                  }
                  onBlur={(e) => {
                    const parsed = parseInt(e.target.value, 10);
                    const cleanVal = Number.isFinite(parsed)
                      ? Math.max(0, Math.min(60, parsed))
                      : 5;
                    onUpdateDraftConfig({
                      ...config,
                      gameSwitchBufferMins: cleanVal,
                    });
                  }}
                  className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Clock className="w-4 h-4 text-purple-400" /> Reconnect Grace Period (Minutes)
                </label>
                <p className="text-xs text-gray-500">
                  Time to keep session alive during streamer disconnects before finalizing
                </p>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={config.offlineGracePeriodMins ?? 5}
                  onChange={(e) =>
                    onUpdateDraftConfig({
                      ...config,
                      offlineGracePeriodMins: e.target.value as any,
                    })
                  }
                  onBlur={(e) => {
                    const parsed = parseInt(e.target.value, 10);
                    const cleanVal = Number.isFinite(parsed)
                      ? Math.max(1, Math.min(60, parsed))
                      : 5;
                    onUpdateDraftConfig({
                      ...config,
                      offlineGracePeriodMins: cleanVal,
                    });
                  }}
                  className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                />
              </div>
            </div>

            {/* Extended Stream / Single Game Autosplice */}
            <div className="bg-[#141416] border border-white/10 rounded-xl p-4 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="autosplice-toggle"
                    className="text-sm font-semibold text-white flex items-center gap-2 cursor-pointer"
                  >
                    <Scissors className="w-4 h-4 text-purple-400" />
                    Extended Stream / Single Game Autosplice
                  </label>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    Automatically splices broadcasts that stay on the same game for an extended duration into manageable video segments, then triggers stitching and chat rendering.
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-0.5">
                  <input
                    id="autosplice-toggle"
                    type="checkbox"
                    checked={config.longGameAutospliceEnabled ?? true}
                    onChange={(e) =>
                      onUpdateDraftConfig({
                        ...config,
                        longGameAutospliceEnabled: e.target.checked,
                      })
                    }
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600" />
                </label>
              </div>

              {(config.longGameAutospliceEnabled ?? true) && (
                <div className="pt-3 border-t border-white/5 space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-purple-400" /> Trigger Threshold (Hours)
                      </label>
                      <p className="text-xs text-gray-500">
                        Duration on the same game before triggering a splice (0.25h steps)
                      </p>
                      <input
                        type="number"
                        step="0.25"
                        min="0.25"
                        max="72"
                        value={config.longGameAutospliceTriggerHours ?? 9}
                        onChange={(e) =>
                          onUpdateDraftConfig({
                            ...config,
                            longGameAutospliceTriggerHours: e.target.value as any,
                          })
                        }
                        onBlur={(e) => {
                          const parsed = parseFloat(e.target.value);
                          const val = Number.isFinite(parsed)
                            ? Math.max(0.25, Math.min(72, parsed))
                            : 9;
                          const curCut =
                            parseFloat(String(config.longGameAutospliceCutHours ?? 8)) || 8;
                          onUpdateDraftConfig({
                            ...config,
                            longGameAutospliceTriggerHours: val,
                            longGameAutospliceCutHours: curCut > val ? val : curCut,
                          });
                        }}
                        className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                        <Scissors className="w-3.5 h-3.5 text-purple-400" /> Splice Cut Point (Hours)
                      </label>
                      <p className="text-xs text-gray-500">
                        Timestamp where segment is cut (must be &le; trigger threshold)
                      </p>
                      <input
                        type="number"
                        step="0.25"
                        min="0.25"
                        max={config.longGameAutospliceTriggerHours ?? 9}
                        value={config.longGameAutospliceCutHours ?? 8}
                        onChange={(e) =>
                          onUpdateDraftConfig({
                            ...config,
                            longGameAutospliceCutHours: e.target.value as any,
                          })
                        }
                        onBlur={(e) => {
                          const trigger =
                            parseFloat(String(config.longGameAutospliceTriggerHours ?? 9)) || 9;
                          const parsed = parseFloat(e.target.value);
                          const rawVal = Number.isFinite(parsed) ? Math.max(0.25, parsed) : 8;
                          const val = Math.min(trigger, rawVal);
                          onUpdateDraftConfig({
                            ...config,
                            longGameAutospliceCutHours: val,
                          });
                        }}
                        className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                      />
                    </div>
                  </div>

                  <div className="px-3 py-2 bg-purple-500/10 border border-purple-500/20 rounded-lg text-xs text-purple-300 flex items-center gap-2 tabular-nums">
                    <Clock className="w-4 h-4 shrink-0 text-purple-400" />
                    <span>
                      Active Policy: When a stream stays on one game for{" "}
                      <strong>{config.longGameAutospliceTriggerHours ?? 9}h</strong>, a splice is cut at the{" "}
                      <strong>{config.longGameAutospliceCutHours ?? 8}h</strong> mark (with{" "}
                      <strong>{config.gameSwitchBufferMins ?? 5} min</strong> buffer on both sides).
                    </span>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {settingsTab === "render" && (
          <div className="space-y-6">
            {/* Binary Path */}
            <div className="bg-[#141416] border border-white/10 rounded-xl p-4 space-y-3">
              <div>
                <h4 className="text-sm font-bold text-white uppercase tracking-wider">
                  Renderer Binary Path
                </h4>
                <p className="text-xs text-gray-400 mt-0.5">
                  Supports both <code className="text-purple-300">ChatRenderCLI.exe</code>{" "}
                  (high-speed v2.0-extended renderer) and legacy{" "}
                  <code className="text-gray-300">TwitchDownloaderCLI.exe</code>. If both exist in the same folder,{" "}
                  <code className="text-purple-300">ChatRenderCLI.exe</code> is preferred automatically.
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  ChatRenderCLI / TwitchDownloaderCLI Path
                </label>
                <input
                  type="text"
                  value={config.tdPath || ""}
                  onChange={(e) =>
                    onUpdateDraftConfig({ ...config, tdPath: e.target.value })
                  }
                  className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                  placeholder="TwitchDownloader\ChatRenderCLI.exe (or absolute path)"
                />
              </div>
            </div>

            {/* Video Dimensions & Encoding */}
            <div className="bg-[#141416] border border-white/10 rounded-xl p-4 space-y-4">
              <div>
                <h4 className="text-sm font-bold text-white uppercase tracking-wider">
                  Video Dimensions &amp; Encoding
                </h4>
                <p className="text-xs text-gray-400 mt-0.5">
                  Canvas dimensions are automatically rounded to even pixel multiples for planar YUV420p / YUVA420p encoding compatibility.
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Default Width (px)
                  </label>
                  <input
                    type="number"
                    min="100"
                    max="7680"
                    step="2"
                    value={cr.width ?? 350}
                    onChange={(e) => updateChatRenderField({ width: e.target.value })}
                    onBlur={(e) => {
                      const parsed = parseInt(e.target.value, 10);
                      const rawVal =
                        Number.isFinite(parsed) && parsed > 0
                          ? Math.max(100, Math.min(7680, parsed))
                          : 350;
                      const cleanVal = rawVal % 2 !== 0 ? rawVal + 1 : rawVal;
                      updateChatRenderField({ width: cleanVal });
                    }}
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Default Height (px)
                  </label>
                  <input
                    type="number"
                    min="100"
                    max="7680"
                    step="2"
                    value={cr.height ?? 800}
                    onChange={(e) => updateChatRenderField({ height: e.target.value })}
                    onBlur={(e) => {
                      const parsed = parseInt(e.target.value, 10);
                      const rawVal =
                        Number.isFinite(parsed) && parsed > 0
                          ? Math.max(100, Math.min(7680, parsed))
                          : 800;
                      const cleanVal = rawVal % 2 !== 0 ? rawVal + 1 : rawVal;
                      updateChatRenderField({ height: cleanVal });
                    }}
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Framerate (FPS)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="240"
                    value={cr.framerate ?? 60}
                    onChange={(e) => updateChatRenderField({ framerate: e.target.value })}
                    onBlur={(e) => {
                      const parsed = parseInt(e.target.value, 10);
                      const cleanVal =
                        Number.isFinite(parsed) && parsed > 0
                          ? Math.max(1, Math.min(240, parsed))
                          : 60;
                      updateChatRenderField({ framerate: cleanVal });
                    }}
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    File Format
                  </label>
                  <select
                    value={cr.format || "mp4"}
                    onChange={(e) => updateChatRenderField({ format: e.target.value })}
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white cursor-pointer"
                  >
                    <option value="mp4">MP4 (.mp4)</option>
                    <option value="webm">WEBM (.webm) - Transparent for VP9</option>
                    <option value="mov">MOV (.mov) - Transparent for ProRes</option>
                    <option value="mkv">MKV (.mkv)</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Codec
                  </label>
                  <select
                    value={cr.codec || "h264"}
                    onChange={(e) => {
                      const newCodec = e.target.value;
                      let newFormat = cr.format || "mp4";
                      if (
                        (newCodec === "vp9" || newCodec === "vp8") &&
                        newFormat !== "webm" &&
                        newFormat !== "mkv"
                      ) {
                        newFormat = "webm";
                      } else if (
                        newCodec === "prores" &&
                        newFormat !== "mov" &&
                        newFormat !== "mkv"
                      ) {
                        newFormat = "mov";
                      }
                      updateChatRenderField({ codec: newCodec, format: newFormat });
                    }}
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white cursor-pointer"
                  >
                    <option value="vp9">VP9 (Transparent, ~98% Smaller WebM)</option>
                    <option value="prores">ProRes (Transparent, Master MOV)</option>
                    <option value="h264">H264 (Standard)</option>
                    <option value="hevc">HEVC / H265</option>
                    <option value="vp8">VP8</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Update Rate (seconds)
                  </label>
                  <input
                    type="number"
                    step="0.05"
                    min="0"
                    value={cr.updateRate ?? 0.2}
                    onChange={(e) => updateChatRenderField({ updateRate: e.target.value })}
                    onBlur={(e) => {
                      const parsed = parseFloat(e.target.value);
                      const cleanVal =
                        Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.2;
                      updateChatRenderField({ updateRate: cleanVal });
                    }}
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                  />
                  <p className="text-xs text-gray-500">
                    Time in seconds between chat scroll frame updates (`0` = every frame).
                  </p>
                </div>
              </div>

              {/* Per-Game Chat Render Resolution Profiles */}
              <div className="pt-4 border-t border-white/10 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <h5 className="text-xs font-bold text-purple-300 uppercase tracking-wider flex items-center gap-1.5">
                      <Gamepad2 className="w-3.5 h-3.5 text-purple-400" />
                      Per-Game Resolution Profiles
                    </h5>
                    <p className="text-xs text-gray-400 mt-0.5">
                      Override `Default Width × Default Height` for specific games (case-insensitive exact match). You can also click any live game badge on the Livestream Monitor to set its profile on the fly.
                    </p>
                  </div>
                </div>

                {Array.isArray(cr.gameProfiles) && cr.gameProfiles.length > 0 ? (
                  <div className="space-y-2">
                    {(cr.gameProfiles as GameResolutionProfile[]).map((prof, pIdx) => (
                      <div
                        key={`${prof.gameName}-${pIdx}`}
                        className="bg-[#0a0a0c] border border-white/10 rounded-lg p-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <Gamepad2 className="w-4 h-4 text-purple-400 shrink-0" />
                          <input
                            type="text"
                            value={prof.gameName}
                            onChange={(e) => {
                              const next = [...(cr.gameProfiles || [])];
                              next[pIdx] = { ...next[pIdx], gameName: e.target.value };
                              updateChatRenderField({ gameProfiles: next });
                            }}
                            className="bg-[#141416] border border-white/10 rounded px-2.5 py-1 text-xs sm:text-sm font-semibold text-white focus:outline-none focus:border-purple-500/50 w-full max-w-xs"
                          />
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] text-gray-400 uppercase font-mono">
                              W
                            </span>
                            <input
                              type="number"
                              min="100"
                              max="7680"
                              step="2"
                              value={prof.width}
                              onChange={(e) => {
                                const next = [...(cr.gameProfiles || [])];
                                next[pIdx] = {
                                  ...next[pIdx],
                                  width: e.target.value as any,
                                };
                                updateChatRenderField({ gameProfiles: next });
                              }}
                              onBlur={(e) => {
                                const parsed = parseInt(e.target.value, 10);
                                const rawVal =
                                  Number.isFinite(parsed) && parsed > 0
                                    ? Math.max(100, Math.min(7680, parsed))
                                    : 350;
                                const cleanVal = rawVal % 2 !== 0 ? rawVal + 1 : rawVal;
                                const next = [...(cr.gameProfiles || [])];
                                next[pIdx] = { ...next[pIdx], width: cleanVal };
                                updateChatRenderField({ gameProfiles: next });
                              }}
                              className="w-20 bg-[#141416] border border-white/10 rounded px-2 py-1 text-xs sm:text-sm font-mono tabular-nums text-white focus:outline-none focus:border-purple-500/50"
                            />
                          </div>
                          <span className="text-gray-500 font-mono">×</span>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] text-gray-400 uppercase font-mono">
                              H
                            </span>
                            <input
                              type="number"
                              min="100"
                              max="7680"
                              step="2"
                              value={prof.height}
                              onChange={(e) => {
                                const next = [...(cr.gameProfiles || [])];
                                next[pIdx] = {
                                  ...next[pIdx],
                                  height: e.target.value as any,
                                };
                                updateChatRenderField({ gameProfiles: next });
                              }}
                              onBlur={(e) => {
                                const parsed = parseInt(e.target.value, 10);
                                const rawVal =
                                  Number.isFinite(parsed) && parsed > 0
                                    ? Math.max(100, Math.min(7680, parsed))
                                    : 800;
                                const cleanVal = rawVal % 2 !== 0 ? rawVal + 1 : rawVal;
                                const next = [...(cr.gameProfiles || [])];
                                next[pIdx] = { ...next[pIdx], height: cleanVal };
                                updateChatRenderField({ gameProfiles: next });
                              }}
                              className="w-20 bg-[#141416] border border-white/10 rounded px-2 py-1 text-xs sm:text-sm font-mono tabular-nums text-white focus:outline-none focus:border-purple-500/50"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const next = (cr.gameProfiles || []).filter(
                                (_: unknown, i: number) => i !== pIdx
                              );
                              updateChatRenderField({ gameProfiles: next });
                            }}
                            className="p-1.5 rounded hover:bg-red-500/15 text-gray-400 hover:text-red-400 transition-colors cursor-pointer"
                            title="Remove game profile"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-gray-500 bg-[#0a0a0c] border border-dashed border-white/10 rounded-lg px-3 py-2.5 tabular-nums">
                    No per-game resolution profiles configured yet. All games currently use Default Width × Default Height ({cr.width ?? 350}×{cr.height ?? 800}).
                  </div>
                )}

                {/* Add New Game Profile Row */}
                <div className="bg-[#0a0a0c] border border-white/10 rounded-lg p-3 flex flex-col sm:flex-row sm:items-end gap-3">
                  <div className="flex-1 space-y-1">
                    <label className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                      Game / Category Name
                    </label>
                    <input
                      type="text"
                      value={newProfileGameName}
                      onChange={(e) => setNewProfileGameName(e.target.value)}
                      placeholder="e.g. Just Chatting, VALORANT, League of Legends"
                      className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-1.5 text-xs sm:text-sm text-white placeholder-gray-600 focus:outline-none focus:border-purple-500/50"
                    />
                  </div>
                  <div className="w-24 space-y-1">
                    <label className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                      Width
                    </label>
                    <input
                      type="number"
                      min="100"
                      max="7680"
                      step="2"
                      value={newProfileWidth}
                      onChange={(e) => setNewProfileWidth(e.target.value)}
                      className="w-full bg-[#141416] border border-white/10 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-mono tabular-nums text-white focus:outline-none focus:border-purple-500/50"
                    />
                  </div>
                  <div className="w-24 space-y-1">
                    <label className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                      Height
                    </label>
                    <input
                      type="number"
                      min="100"
                      max="7680"
                      step="2"
                      value={newProfileHeight}
                      onChange={(e) => setNewProfileHeight(e.target.value)}
                      className="w-full bg-[#141416] border border-white/10 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-mono tabular-nums text-white focus:outline-none focus:border-purple-500/50"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const trimmed = newProfileGameName.trim();
                      if (!trimmed) {
                        onShowToast(
                          "Enter a Twitch game/category name first.",
                          "error",
                          "Game Profile"
                        );
                        return;
                      }
                      const rawW = parseInt(newProfileWidth, 10) || 350;
                      const rawH = parseInt(newProfileHeight, 10) || 800;
                      const clampedW = Math.max(100, Math.min(7680, rawW));
                      const clampedH = Math.max(100, Math.min(7680, rawH));
                      const evenW = clampedW % 2 !== 0 ? clampedW + 1 : clampedW;
                      const evenH = clampedH % 2 !== 0 ? clampedH + 1 : clampedH;
                      const existing: GameResolutionProfile[] = Array.isArray(
                        cr.gameProfiles
                      )
                        ? [...cr.gameProfiles]
                        : [];
                      const idx = existing.findIndex(
                        (p) =>
                          p.gameName.trim().toLowerCase() === trimmed.toLowerCase()
                      );
                      if (idx >= 0) {
                        existing[idx] = {
                          gameName: trimmed,
                          width: evenW,
                          height: evenH,
                        };
                      } else {
                        existing.push({
                          gameName: trimmed,
                          width: evenW,
                          height: evenH,
                        });
                      }
                      updateChatRenderField({ gameProfiles: existing });
                      setNewProfileGameName("");
                    }}
                    className="flex items-center justify-center gap-1.5 px-3.5 py-1.5 bg-purple-600/20 hover:bg-purple-600 text-purple-300 hover:text-white border border-purple-500/30 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add / Update</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Parallel Pipeline & Memory */}
            <div className="bg-[#141416] border border-white/10 rounded-xl p-4 space-y-4">
              <div>
                <h4 className="text-sm font-bold text-white uppercase tracking-wider">
                  Parallel Pipeline &amp; Memory (`ChatRenderCLI`)
                </h4>
                <p className="text-xs text-gray-400 mt-0.5">
                  Controls multi-FFmpeg segmented rendering (`-j / --jobs`) and decoded sprite/GIF frame memory budget (`--image-cache-mb`).
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Parallel Render Jobs (-j / --jobs)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="16"
                    value={cr.jobs ?? 0}
                    onChange={(e) => updateChatRenderField({ jobs: e.target.value })}
                    onBlur={(e) => {
                      const parsed = parseInt(e.target.value, 10);
                      const cleanVal = Number.isFinite(parsed)
                        ? Math.max(0, Math.min(16, parsed))
                        : 0;
                      updateChatRenderField({ jobs: cleanVal });
                    }}
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                  />
                  <p className="text-xs text-gray-500">
                    `0` = Auto-scale by CPU core count (`1`–`4` parallel FFmpeg workers). Set `1`–`16` to override.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Image &amp; GIF Cache Budget (MB)
                  </label>
                  <input
                    type="number"
                    min="64"
                    max="8192"
                    step="64"
                    value={cr.imageCacheMb ?? 256}
                    onChange={(e) =>
                      updateChatRenderField({ imageCacheMb: e.target.value })
                    }
                    onBlur={(e) => {
                      const parsed = parseInt(e.target.value, 10);
                      const cleanVal = Number.isFinite(parsed)
                        ? Math.max(64, Math.min(8192, parsed))
                        : 256;
                      updateChatRenderField({ imageCacheMb: cleanVal });
                    }}
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                  />
                  <p className="text-xs text-gray-500">
                    Memory cap (`64`–`8192` MB, default: `256` MB) for decoded animated emotes &amp; Giphy GIFs before LRU eviction.
                  </p>
                </div>
              </div>
            </div>

            {/* Timeline Sync, Smoothing & Output Flags */}
            <div className="bg-[#141416] border border-white/10 rounded-xl p-4 space-y-4">
              <div>
                <h4 className="text-sm font-bold text-white uppercase tracking-wider">
                  Timeline Sync, Smoothing &amp; Output Flags
                </h4>
                <p className="text-xs text-gray-400 mt-0.5">
                  Compensates for broadcaster encoder latency, integer VOD timestamp clumping, and multi-hour subathon clock drift.
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Chat Sync - H.264 / 1080p (s)
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    value={cr.syncOffset ?? -2.5}
                    onChange={(e) =>
                      updateChatRenderField({ syncOffset: e.target.value })
                    }
                    onBlur={(e) => {
                      const parsed = parseFloat(e.target.value);
                      const cleanVal = Number.isFinite(parsed) ? parsed : -2.5;
                      updateChatRenderField({ syncOffset: cleanVal });
                    }}
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                  />
                  <p className="text-xs text-gray-500">
                    Default: `-2.5s`. Negative shifts chat earlier.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Chat Sync - HEVC / 1440p (s)
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    value={cr.syncOffsetHevc ?? -7.5}
                    onChange={(e) =>
                      updateChatRenderField({ syncOffsetHevc: e.target.value })
                    }
                    onBlur={(e) => {
                      const parsed = parseFloat(e.target.value);
                      const cleanVal = Number.isFinite(parsed) ? parsed : -7.5;
                      updateChatRenderField({ syncOffsetHevc: cleanVal });
                    }}
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                  />
                  <p className="text-xs text-gray-500">
                    Default: `-7.5s` for Enhanced Broadcasts.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Dispersion (Message Smoothing)
                  </label>
                  <select
                    value={
                      cr.dispersion === true || cr.dispersion === "on"
                        ? "on"
                        : cr.dispersion === false || cr.dispersion === "off"
                        ? "off"
                        : "smart"
                    }
                    onChange={(e) =>
                      updateChatRenderField({ dispersion: e.target.value })
                    }
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white cursor-pointer"
                  >
                    <option value="smart">Smart (VOD Chat Only)</option>
                    <option value="on">On (Always)</option>
                    <option value="off">Off (Never)</option>
                  </select>
                  <p className="text-xs text-gray-500">
                    Spreads out whole-second VOD chat timestamps.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-white/10">
                {[
                  {
                    key: "autoCompensateClockDrift",
                    label: "Auto-Compensate Clock Drift (10+ hr streams)",
                    def: true,
                  },
                  {
                    key: "generateMask",
                    label: "Generate Separate Alpha Mask (--generate-mask)",
                    def: false,
                  },
                  {
                    key: "sharpening",
                    label: "Sub-Pixel Text Sharpening (--sharpening)",
                    def: false,
                  },
                  {
                    key: "offline",
                    label: "Offline Mode - Never Fetch Missing Assets (--offline)",
                    def: false,
                  },
                ].map((opt) => (
                  <label
                    key={opt.key}
                    className="flex items-center gap-2.5 cursor-pointer group"
                  >
                    <input
                      type="checkbox"
                      checked={cr[opt.key] ?? opt.def}
                      onChange={(e) =>
                        updateChatRenderField({ [opt.key]: e.target.checked })
                      }
                      className="w-4.5 h-4.5 rounded border-white/20 bg-[#0a0a0c] text-purple-600 focus:ring-0 focus:ring-offset-0"
                    />
                    <span className="text-sm text-gray-300 font-medium group-hover:text-white transition-colors">
                      {opt.label}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Manual Chat Render Launcher */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-purple-950/20 border border-purple-500/20 rounded-xl p-4">
              <div>
                <h4 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Film className="w-4 h-4 text-purple-400" />
                  Manual Chat Render
                </h4>
                <p className="text-xs text-gray-400 mt-0.5">
                  Select or provide any downloaded chat JSON to test your rendering pipeline and output settings.
                </p>
              </div>
              <button
                type="button"
                onClick={onOpenManualRenderModal}
                className="flex items-center justify-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-semibold transition-colors cursor-pointer shrink-0 shadow-sm"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                Manual Render...
              </button>
            </div>
          </div>
        )}

        {settingsTab === "render_appearance" && (
          <div className="space-y-6">
            {/* Live Broadcast Overlays */}
            <div className="bg-[#141416] border border-white/10 rounded-xl p-4 space-y-4">
              <div>
                <h4 className="text-sm font-bold text-white uppercase tracking-wider">
                  Live Broadcast Overlays (`v2.0-extended`)
                </h4>
                <p className="text-xs text-gray-400 mt-0.5">
                  Choose how real-time Hermes channel overlays are rendered by{" "}
                  <code className="text-purple-300">ChatRenderCLI</code>: pinned at the top of the video canvas (
                  <code className="text-purple-300">StickyTop</code>), inline in the scrolling chat (
                  <code className="text-gray-300">ChatScroll</code>), or disabled (
                  <code className="text-gray-300">Off</code>).
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  {
                    key: "predictionMode",
                    label: "Predictions (--prediction-mode)",
                    desc: "Live odds, points & winning outcome",
                  },
                  {
                    key: "pollMode",
                    label: "Polls (--poll-mode)",
                    desc: "Vote bars, percentages & winner",
                  },
                  {
                    key: "pinnedChatMode",
                    label: "Pinned Chat (--pinned-chat-mode)",
                    desc: "Mod-pinned messages & Hype pins",
                  },
                  {
                    key: "hypeTrainMode",
                    label: "Hype Train (--hype-train-mode)",
                    desc: "Level progress bar & goal %",
                  },
                ].map((item) => (
                  <div key={item.key} className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      {item.label}
                    </label>
                    <select
                      value={
                        cr[item.key] ||
                        (item.key === "hypeTrainMode" ? "ChatScroll" : "StickyTop")
                      }
                      onChange={(e) =>
                        updateChatRenderField({ [item.key]: e.target.value })
                      }
                      className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white cursor-pointer"
                    >
                      <option value="StickyTop">StickyTop (Pinned Card)</option>
                      <option value="ChatScroll">ChatScroll (Inline Notice)</option>
                      <option value="Off">Off (Hidden)</option>
                    </select>
                    <p className="text-xs text-gray-500">{item.desc}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Enriched Chat & Broadcast Events */}
            <div className="bg-[#141416] border border-white/10 rounded-xl p-4 space-y-4">
              <div>
                <h4 className="text-sm font-bold text-white uppercase tracking-wider">
                  Enriched Chat &amp; Broadcast Events (`v2.0-extended`)
                </h4>
                <p className="text-xs text-gray-400 mt-0.5">
                  Toggle rich visual cards, reply headers, highlights, and Bits Power-Ups captured from Twitch IRCv3 and Hermes.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {[
                  { key: "subMessages", label: "Sub, Resub & Gift Notices (--sub-messages)" },
                  { key: "replies", label: "Threaded Reply Headers (--replies)" },
                  { key: "firstChatter", label: "First-Time / Returning Chatter (--first-chatter)" },
                  { key: "announcements", label: "Moderator Announcements (--announcements)" },
                  { key: "raids", label: "Incoming & Outgoing Raids (--raids)" },
                  { key: "channelPoints", label: "Channel Point Redemptions (--channel-points)" },
                  { key: "hypeChat", label: "Paid Hype Chat Currency Pills (--hype-chat)" },
                  { key: "powerUps", label: "Bits Power-Ups & Giant Emotes (--power-ups)" },
                  { key: "sharedChatBadge", label: "Shared Chat Source Badges (--shared-chat-badge)" },
                ].map((opt) => (
                  <label
                    key={opt.key}
                    className="flex items-center gap-2.5 cursor-pointer group"
                  >
                    <input
                      type="checkbox"
                      checked={cr[opt.key] ?? true}
                      onChange={(e) =>
                        updateChatRenderField({ [opt.key]: e.target.checked })
                      }
                      className="w-4.5 h-4.5 rounded border-white/20 bg-[#0a0a0c] text-purple-600 focus:ring-0 focus:ring-offset-0"
                    />
                    <span className="text-sm text-gray-300 font-medium group-hover:text-white transition-colors">
                      {opt.label}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Moderation, Roomstate & User Filtering */}
            <div className="bg-[#141416] border border-white/10 rounded-xl p-4 space-y-4">
              <div>
                <h4 className="text-sm font-bold text-white uppercase tracking-wider">
                  Moderation, Roomstate &amp; User Highlighting
                </h4>
                <p className="text-xs text-gray-400 mt-0.5">
                  Configure how timeouts, bans, deleted messages (`CLEARMSG`), `/clear`, room mode changes, and highlighted chatters are displayed.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Moderated Message Mode (--moderation-mode)
                  </label>
                  <select
                    value={cr.moderationMode || "Strikethrough"}
                    onChange={(e) =>
                      updateChatRenderField({ moderationMode: e.target.value })
                    }
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white cursor-pointer"
                  >
                    <option value="Strikethrough">
                      Strikethrough (Dim + Red Strikethrough after ban/delete)
                    </option>
                    <option value="ReplaceDeleted">
                      ReplaceDeleted (&lt;message deleted&gt;)
                    </option>
                    <option value="Hide">Hide (Remove from scroll when moderated)</option>
                    <option value="Off">Off (Leave messages untouched)</option>
                  </select>
                  <p className="text-xs text-gray-500">
                    Messages appear normally until the exact timestamp the moderator times out, bans, or deletes them.
                  </p>
                </div>

                <div className="space-y-2.5 flex flex-col justify-center pt-1">
                  {[
                    {
                      key: "moderationNotices",
                      label: "Show Timeout / Ban System Lines in Scroll (--moderation-notices)",
                    },
                    {
                      key: "roomstateNotices",
                      label: "Show Roomstate Mode Notices (Sub/Emote/Slow) (--roomstate-notices)",
                    },
                    {
                      key: "clearAll",
                      label: "Wipe Active Screen on Mod /clear (--clear-all)",
                    },
                  ].map((opt) => (
                    <label
                      key={opt.key}
                      className="flex items-center gap-2.5 cursor-pointer group"
                    >
                      <input
                        type="checkbox"
                        checked={cr[opt.key] ?? true}
                        onChange={(e) =>
                          updateChatRenderField({ [opt.key]: e.target.checked })
                        }
                        className="w-4.5 h-4.5 rounded border-white/20 bg-[#0a0a0c] text-purple-600 focus:ring-0 focus:ring-offset-0"
                      />
                      <span className="text-sm text-gray-300 font-medium group-hover:text-white transition-colors">
                        {opt.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-white/10">
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      Highlight Users (comma separated)
                    </label>
                    {config.channels && config.channels.length > 0 && (
                      <span className="text-[11px] font-mono text-purple-300 bg-purple-500/15 border border-purple-500/30 px-2 py-0.5 rounded">
                        Auto-included: {config.channels.map((c) => `@${c}`).join(", ")}
                      </span>
                    )}
                  </div>
                  <input
                    type="text"
                    value={cr.highlightUsers || ""}
                    onChange={(e) =>
                      updateChatRenderField({ highlightUsers: e.target.value })
                    }
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                    placeholder="moderator1, vip_friend, streamer_alt"
                  />
                  <p className="text-xs text-gray-500">
                    The broadcaster of the monitored/rendered channel is included automatically. Add any extra usernames here (`--highlight-users`).
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Highlight User Color (Hex)
                  </label>
                  <input
                    type="text"
                    value={cr.highlightUserColor || "#3D1A52"}
                    onChange={(e) =>
                      updateChatRenderField({ highlightUserColor: e.target.value })
                    }
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                    placeholder="#3D1A52"
                  />
                  <p className="text-xs text-gray-500">
                    Background tint for highlighted users (`--highlight-user-color`, default: `#3D1A52`).
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Ignore Users (comma separated)
                  </label>
                  <input
                    type="text"
                    value={cr.ignoreUsers || ""}
                    onChange={(e) =>
                      updateChatRenderField({ ignoreUsers: e.target.value })
                    }
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                    placeholder="nightbot, streamelements, fossabot"
                  />
                  <p className="text-xs text-gray-500">
                    Excludes messages sent by these accounts (`--ignore-users`).
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Banned Words (comma separated)
                  </label>
                  <input
                    type="text"
                    value={cr.bannedWords || ""}
                    onChange={(e) =>
                      updateChatRenderField({ bannedWords: e.target.value })
                    }
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                    placeholder="spoiler1, word2"
                  />
                  <p className="text-xs text-gray-500">
                    Hides any message containing these substrings (`--banned-words`).
                  </p>
                </div>
              </div>
            </div>

            {/* Colors & Typography */}
            <div className="bg-[#141416] border border-white/10 rounded-xl p-4 space-y-4">
              <div>
                <h4 className="text-sm font-bold text-white uppercase tracking-wider">
                  Colors &amp; Typography
                </h4>
                <p className="text-xs text-gray-400 mt-0.5">
                  Customize background colors (supports `#RRGGBB` or `#AARRGGBB` alpha), font family, font weights, and outline rendering.
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Background Color (Hex)
                  </label>
                  <input
                    type="text"
                    value={cr.backgroundColor || "#111111"}
                    onChange={(e) =>
                      updateChatRenderField({ backgroundColor: e.target.value })
                    }
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                    placeholder="#111111 or #00000000"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Alt Background Color (Hex)
                  </label>
                  <input
                    type="text"
                    value={cr.altBackgroundColor || "#191919"}
                    onChange={(e) =>
                      updateChatRenderField({ altBackgroundColor: e.target.value })
                    }
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                    placeholder="#191919"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Message Color (Hex)
                  </label>
                  <input
                    type="text"
                    value={cr.messageColor || "#ffffff"}
                    onChange={(e) =>
                      updateChatRenderField({ messageColor: e.target.value })
                    }
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                    placeholder="#ffffff"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Font Family
                  </label>
                  <input
                    type="text"
                    value={cr.font || "Inter Embedded"}
                    onChange={(e) => updateChatRenderField({ font: e.target.value })}
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                    placeholder="Inter Embedded"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Font Size
                  </label>
                  <input
                    type="number"
                    value={cr.fontSize ?? 24}
                    onChange={(e) => updateChatRenderField({ fontSize: e.target.value })}
                    onBlur={(e) => {
                      const parsed = parseInt(e.target.value, 10);
                      const cleanVal =
                        Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
                      updateChatRenderField({ fontSize: cleanVal });
                    }}
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Outline Size
                  </label>
                  <input
                    type="number"
                    value={cr.outlineSize ?? 4}
                    onChange={(e) =>
                      updateChatRenderField({ outlineSize: e.target.value })
                    }
                    onBlur={(e) => {
                      const parsed = parseFloat(e.target.value);
                      const cleanVal =
                        Number.isFinite(parsed) && parsed >= 0 ? parsed : 4;
                      updateChatRenderField({ outlineSize: cleanVal });
                    }}
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Username Font Style
                  </label>
                  <select
                    value={cr.usernameFontStyle || "bold"}
                    onChange={(e) =>
                      updateChatRenderField({ usernameFontStyle: e.target.value })
                    }
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white cursor-pointer"
                  >
                    <option value="normal">Normal</option>
                    <option value="bold">Bold</option>
                    <option value="italic">Italic</option>
                    <option value="bolditalic">Bold Italic</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Message Font Style
                  </label>
                  <select
                    value={cr.messageFontStyle || "normal"}
                    onChange={(e) =>
                      updateChatRenderField({ messageFontStyle: e.target.value })
                    }
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white cursor-pointer"
                  >
                    <option value="normal">Normal</option>
                    <option value="bold">Bold</option>
                    <option value="italic">Italic</option>
                    <option value="bolditalic">Bold Italic</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Emoji Vendor
                  </label>
                  <select
                    value={cr.emojiVendor || "notocolor"}
                    onChange={(e) =>
                      updateChatRenderField({ emojiVendor: e.target.value })
                    }
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white cursor-pointer"
                  >
                    <option value="notocolor">Google Noto Color (notocolor)</option>
                    <option value="twemoji">Twitter Twemoji (twemoji)</option>
                    <option value="system">OS System Font (system)</option>
                    <option value="none">None (none)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-3 border-t border-white/10">
                {[
                  {
                    key: "readableColors",
                    label: "Readable Username Colors (--readable-colors)",
                    def: true,
                  },
                  {
                    key: "alternateBackgrounds",
                    label: "Alternating Row Backgrounds (--alternate-backgrounds)",
                    def: false,
                  },
                  {
                    key: "outline",
                    label: "Text Drop-Shadow / Outline (--outline)",
                    def: false,
                  },
                ].map((opt) => (
                  <label
                    key={opt.key}
                    className="flex items-center gap-2.5 cursor-pointer group"
                  >
                    <input
                      type="checkbox"
                      checked={cr[opt.key] ?? opt.def}
                      onChange={(e) =>
                        updateChatRenderField({ [opt.key]: e.target.checked })
                      }
                      className="w-4.5 h-4.5 rounded border-white/20 bg-[#0a0a0c] text-purple-600 focus:ring-0 focus:ring-offset-0"
                    />
                    <span className="text-sm text-gray-300 font-medium group-hover:text-white transition-colors">
                      {opt.label}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Emotes, Badges, Avatars & Giphy GIFs */}
            <div className="bg-[#141416] border border-white/10 rounded-xl p-4 space-y-4">
              <div>
                <h4 className="text-sm font-bold text-white uppercase tracking-wider">
                  Emotes, Badges, Avatars &amp; Giphy GIFs
                </h4>
                <p className="text-xs text-gray-400 mt-0.5">
                  Control 3rd-party emote providers, Giphy GIF scaling, profile avatars, and badge bitmask filtering.
                </p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { key: "stv", label: "7TV Emotes", def: true },
                  { key: "bttv", label: "BTTV Emotes", def: true },
                  { key: "ffz", label: "FFZ Emotes", def: true },
                  { key: "allowUnlistedEmotes", label: "Allow Unlisted Emotes", def: true },
                  { key: "giphy", label: "Giphy GIFs (--giphy)", def: true },
                  { key: "badges", label: "Chat Badges (--badges)", def: true },
                  { key: "avatars", label: "User Avatars (--avatars)", def: false },
                ].map((opt) => (
                  <label
                    key={opt.key}
                    className="flex items-center gap-2.5 cursor-pointer group"
                  >
                    <input
                      type="checkbox"
                      checked={cr[opt.key] ?? opt.def}
                      onChange={(e) =>
                        updateChatRenderField({ [opt.key]: e.target.checked })
                      }
                      className="w-4.5 h-4.5 rounded border-white/20 bg-[#0a0a0c] text-purple-600 focus:ring-0 focus:ring-offset-0"
                    />
                    <span className="text-sm text-gray-300 font-medium group-hover:text-white transition-colors">
                      {opt.label}
                    </span>
                  </label>
                ))}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-3 border-t border-white/10">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Max GIF Height (% of Chat Height)
                  </label>
                  <input
                    type="number"
                    min="5"
                    max="100"
                    value={cr.gifMaxHeightPercent ?? 33}
                    onChange={(e) =>
                      updateChatRenderField({ gifMaxHeightPercent: e.target.value })
                    }
                    onBlur={(e) => {
                      const parsed = parseInt(e.target.value, 10);
                      const cleanVal = Number.isFinite(parsed)
                        ? Math.max(5, Math.min(100, parsed))
                        : 33;
                      updateChatRenderField({ gifMaxHeightPercent: cleanVal });
                    }}
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                  />
                  <p className="text-xs text-gray-500">
                    Caps Giphy GIF height (`5`–`100%`, default: `33%`).
                  </p>
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Chat Badge Filter Bitmask (--badge-filter)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={cr.badgeFilter ?? 0}
                    onChange={(e) =>
                      updateChatRenderField({ badgeFilter: e.target.value })
                    }
                    onBlur={(e) => {
                      const parsed = parseInt(e.target.value, 10);
                      const cleanVal =
                        Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
                      updateChatRenderField({ badgeFilter: cleanVal });
                    }}
                    className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                  />
                  <p className="text-xs text-gray-500">
                    Bitmask of badge types to HIDE (`0` = Show All, `1` = Other, `2` = Broadcaster, `4` = Moderator, `8` = VIP, `16` = Subscriber, `32` = Predictions, `64` = NoAudio/NoVideo, `128` = Prime Gaming). Sum values to combine.
                  </p>
                </div>
              </div>
            </div>

            {/* Fine-Grained Layout & Element Scaling */}
            <div className="bg-[#141416] border border-white/10 rounded-xl p-4 space-y-4">
              <div>
                <h4 className="text-sm font-bold text-white uppercase tracking-wider">
                  Fine-Grained Layout &amp; Element Scaling
                </h4>
                <p className="text-xs text-gray-400 mt-0.5">
                  Multipliers applied relative to Font Size (`1.0` = 100%). Includes `--scale-username` for independent username sizing.
                </p>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {[
                  { key: "scaleUsername", label: "Scale Username" },
                  { key: "scaleEmote", label: "Scale Emote" },
                  { key: "scaleBadge", label: "Scale Badge" },
                  { key: "scaleEmoji", label: "Scale Emoji" },
                  { key: "scaleAvatar", label: "Scale Avatar" },
                  { key: "scaleVertical", label: "Scale Vertical" },
                  { key: "scaleSidePadding", label: "Scale Side Padding" },
                  { key: "scaleSectionHeight", label: "Scale Section Height" },
                  { key: "scaleWordSpace", label: "Scale Word Space" },
                  { key: "scaleEmoteSpace", label: "Scale Emote Space" },
                  { key: "scaleHighlightStroke", label: "Scale Highlight Stroke" },
                  { key: "scaleHighlightIndent", label: "Scale Highlight Indent" },
                ].map((opt) => (
                  <div key={opt.key} className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      {opt.label}
                    </label>
                    <input
                      type="number"
                      step="0.05"
                      value={cr[opt.key] ?? (opt.key === "scaleVertical" ? 0.5 : 1.0)}
                      onChange={(e) =>
                        updateChatRenderField({ [opt.key]: e.target.value })
                      }
                      onBlur={(e) => {
                        const defVal = opt.key === "scaleVertical" ? 0.5 : 1.0;
                        const parsed = parseFloat(e.target.value);
                        const cleanVal =
                          Number.isFinite(parsed) && parsed > 0 ? parsed : defVal;
                        updateChatRenderField({ [opt.key]: cleanVal });
                      }}
                      className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap justify-end items-center gap-4 mt-6 pt-6 border-t border-white/10">
          <div className="flex flex-wrap items-center gap-3">
            {isConfigDirty && (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs font-semibold">
                  <AlertCircle className="w-3.5 h-3.5" />
                  Unsaved changes
                </span>
                <button
                  type="button"
                  onClick={onDiscardChanges}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white border border-white/10 transition-colors cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Discard
                </button>
              </div>
            )}
            {saveStatusMessage && (
              <div
                className={`flex items-center gap-2 text-sm font-semibold ${
                  saveStatusMessage.type === "success"
                    ? "text-emerald-400"
                    : "text-red-400"
                }`}
              >
                {saveStatusMessage.type === "success" && (
                  <Check className="w-4 h-4" />
                )}
                {saveStatusMessage.text}
              </div>
            )}
            <button
              type="submit"
              disabled={isSavingConfig}
              className={`flex items-center gap-2 bg-purple-600 hover:bg-purple-500 text-white px-6 py-2.5 rounded-lg text-sm font-semibold uppercase tracking-wider transition-all shadow-md shadow-purple-900/30 cursor-pointer ${
                isSavingConfig ? "opacity-75 cursor-wait" : ""
              }`}
            >
              {isSavingConfig && <RefreshCw className="w-4 h-4 animate-spin" />}
              {isSavingConfig ? "Saving..." : "Save Configuration"}
            </button>
          </div>
        </div>
      </form>

      {/* Emergency Reset Card */}
      <div className="bg-red-950/15 border border-red-500/20 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h4 className="text-sm font-bold text-red-400 uppercase tracking-wider flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            Emergency Reset
          </h4>
          <p className="text-xs text-gray-400 mt-1">
            Immediately aborts all active FFmpeg stitches, chat renders, and recording sessions, and clears the task queue.
          </p>
        </div>
        <button
          type="button"
          disabled={isResetting}
          onClick={onRequestReboot}
          className={`flex items-center justify-center gap-2 bg-red-500/10 text-red-400 border border-red-500/30 px-4 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-red-600 hover:text-white transition-all cursor-pointer shrink-0 ${
            isResetting ? "opacity-75 cursor-wait" : ""
          }`}
        >
          {isResetting && <RefreshCw className="w-4 h-4 animate-spin" />}
          {isResetting ? "Rebooting..." : "Reboot Program"}
        </button>
      </div>
    </motion.div>
  );
};
