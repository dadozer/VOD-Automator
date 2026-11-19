import React, { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Edit2,
  Film,
  Folder,
  Gamepad2,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Scissors,
  Square,
  Trash2,
  Tv,
  Users,
  Wrench,
} from "lucide-react";
import type { ActiveTask, CaptureMode, Config, Status } from "../types";
import {
  cleanChannel,
  formatDuration,
  formatGraceCountdown,
  resolveClientGameProfile,
} from "../utils/formatters";
import { TaskQueuePanel } from "./TaskQueuePanel";

interface LivestreamMonitorViewProps {
  config: Config | null;
  status: Status | null;
  togglingChannelMap: Record<string, boolean>;
  forceStitchingChannels: Record<string, boolean>;
  isOverridingBuffer: Record<string, boolean>;
  isManualSplicing: Record<string, boolean>;
  pendingTaskActions: Record<string, string>;
  isDismissingCompleted: boolean;
  onOpenRecoverFolderModal: () => void;
  onOpenManualRenderModal: () => void;
  onOpenFolder: (folderPath?: string) => void;
  onAssignOrRenameChannel: (slotIndex: number, rawName: string) => Promise<void>;
  onClearChannelSlot: (slotIndex: number) => Promise<void>;
  onToggleChannelMonitoring: (channel: string) => void;
  onOpenQuickGameProfile: (gameName: string) => void;
  onForceStitch: (channel: string) => void;
  onOverrideBuffer: (channel: string, gameIndex?: number) => void;
  onToggleAutoRender: (channel: string, currentVal: boolean) => void;
  onSetCaptureMode: (channel: string, mode: CaptureMode) => void;
  onOpenSpliceModal: (channel: string) => void;
  onTaskAction: (taskId: string, action: string) => void;
  onConfirmCancelRender: (task: ActiveTask) => void;
  onDismissCompletedTasks: () => void;
}

export const LivestreamMonitorView: React.FC<LivestreamMonitorViewProps> = ({
  config,
  status,
  togglingChannelMap,
  forceStitchingChannels,
  isOverridingBuffer,
  isManualSplicing,
  pendingTaskActions,
  isDismissingCompleted,
  onOpenRecoverFolderModal,
  onOpenManualRenderModal,
  onOpenFolder,
  onAssignOrRenameChannel,
  onClearChannelSlot,
  onToggleChannelMonitoring,
  onOpenQuickGameProfile,
  onForceStitch,
  onOverrideBuffer,
  onToggleAutoRender,
  onSetCaptureMode,
  onOpenSpliceModal,
  onTaskAction,
  onConfirmCancelRender,
  onDismissCompletedTasks,
}) => {
  const [editingChannelIndex, setEditingChannelIndex] = useState<number | null>(null);
  const [tempChannelName, setTempChannelName] = useState<string>("");
  const [timeSinceCheck, setTimeSinceCheck] = useState<number>(0);

  useEffect(() => {
    const computeSeconds = () => {
      if (status?.lastCheckTime) {
        setTimeSinceCheck(Math.max(0, Math.floor((Date.now() - status.lastCheckTime) / 1000)));
      } else {
        setTimeSinceCheck(0);
      }
    };
    computeSeconds();
    const timer = setInterval(computeSeconds, 1000);
    return () => clearInterval(timer);
  }, [status?.lastCheckTime]);

  const monitoredChannelsList = useMemo(
    () => (status?.monitoredChannels || []).map(cleanChannel),
    [status?.monitoredChannels]
  );

  const channelsToDisplay = useMemo(() => {
    const configured = (config?.channels || []).map(cleanChannel).filter(Boolean);
    const result: (string | null)[] = [configured[0] || null, configured[1] || null];
    if (status?.activeSessions) {
      for (const s of status.activeSessions) {
        const cleaned = cleanChannel(s.channel);
        if (cleaned && !result.includes(cleaned)) {
          result.push(cleaned);
        }
      }
    }
    return result;
  }, [config?.channels, status?.activeSessions]);

  const configuredSlotsCount = useMemo(
    () => channelsToDisplay.filter((c): c is string => Boolean(c)).length,
    [channelsToDisplay]
  );

  const startEditingChannel = (index: number, currentName: string) => {
    setEditingChannelIndex(index);
    setTempChannelName(currentName);
  };

  const commitChannelName = async (index: number) => {
    const nameToCommit = tempChannelName;
    setEditingChannelIndex(null);
    setTempChannelName("");
    if (cleanChannel(nameToCommit)) {
      await onAssignOrRenameChannel(index, nameToCommit);
    }
  };

  return (
    <motion.div
      key="dashboard"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="space-y-6"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-3xl font-bold text-white tracking-tight">
            Livestream Monitor
          </h2>
          <p className="text-sm text-gray-400 mt-0.5">
            Livestream video and chat recording
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onOpenRecoverFolderModal}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-white/5 hover:bg-white/10 text-gray-200 border border-white/10 hover:border-purple-500/30 transition-all cursor-pointer"
            title="Stitch uncompiled raw .ts segments in an existing recording folder"
          >
            <Wrench className="w-3.5 h-3.5 text-purple-400" />
            <span>Recover Folder Video</span>
          </button>
          <button
            type="button"
            onClick={onOpenManualRenderModal}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-white/5 hover:bg-white/10 text-gray-200 border border-white/10 hover:border-purple-500/30 transition-all cursor-pointer"
            title="Render any downloaded chat JSON file with ChatRenderCLI / TwitchDownloaderCLI"
          >
            <Film className="w-3.5 h-3.5 text-purple-400" />
            <span>Manual Chat Render</span>
          </button>
          <button
            type="button"
            onClick={() => onOpenFolder()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-white/5 hover:bg-white/10 text-gray-200 border border-white/10 hover:border-white/20 transition-all cursor-pointer"
            title="Open root downloads folder in OS file explorer"
          >
            <Folder className="w-3.5 h-3.5 text-purple-400" />
            <span>Open Downloads</span>
          </button>
        </div>
      </div>

      {/* Per-Stream Monitor Cards */}
      <div className="space-y-3.5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-white tracking-tight flex items-center gap-2 tabular-nums">
              <Tv className="w-4.5 h-4.5 text-purple-400" />
              Monitored Streams ({configuredSlotsCount}/2)
            </h3>
            <p className="text-sm text-gray-400 mt-0.5">
              Configure capture mode prior to broadcast, or pause monitoring to rename or clear a channel slot
            </p>
          </div>
        </div>

        {channelsToDisplay.map((channelName, idx) => {
          if (!channelName) {
            const isEditingThisSlot = editingChannelIndex === idx;
            return (
              <div
                key={`empty-slot-${idx}`}
                className="bg-[#111113]/80 border border-dashed border-white/15 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-all hover:border-purple-500/30"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
                    <Plus className="w-4 h-4 text-purple-400" />
                  </div>
                  <div className="min-w-0">
                    {isEditingThisSlot ? (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-purple-400 font-bold text-sm">@</span>
                        <input
                          type="text"
                          autoFocus
                          value={tempChannelName}
                          onChange={(e) => setTempChannelName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitChannelName(idx);
                            if (e.key === "Escape") {
                              setEditingChannelIndex(null);
                              setTempChannelName("");
                            }
                          }}
                          placeholder="twitch_username"
                          className="bg-black/60 border border-purple-500/60 rounded-lg px-3 py-1.5 text-sm font-bold text-white focus:outline-none w-48"
                        />
                        <button
                          type="button"
                          onClick={() => commitChannelName(idx)}
                          className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs font-semibold uppercase tracking-wider cursor-pointer"
                        >
                          Save Slot
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingChannelIndex(null);
                            setTempChannelName("");
                          }}
                          className="px-2.5 py-1.5 bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white rounded-lg text-xs font-semibold cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-bold text-gray-200 tracking-tight">
                            Unassigned Stream Slot #{idx + 1}
                          </h4>
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/5 text-gray-400 border border-white/10 uppercase tracking-wider font-semibold">
                            Empty
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Assign a Twitch channel handle to monitor a{" "}
                          {idx === 0 ? "primary" : "second"} broadcast slot.
                        </p>
                      </>
                    )}
                  </div>
                </div>

                {!isEditingThisSlot && (
                  <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                    <button
                      type="button"
                      onClick={() => startEditingChannel(idx, "")}
                      className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold uppercase tracking-wider bg-purple-600/20 hover:bg-purple-600 text-purple-300 hover:text-white border border-purple-500/30 transition-all cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Assign Channel</span>
                    </button>
                  </div>
                )}
              </div>
            );
          }

          const cleaned = cleanChannel(channelName);
          const isChannelMonitored = monitoredChannelsList.includes(cleaned);
          const activeSession = (status?.activeSessions || []).find(
            (s) => cleanChannel(s.channel) === cleaned
          );
          const isLive = Boolean(activeSession);
          const isRunning = isChannelMonitored || isLive;
          const isToggling = Boolean(
            togglingChannelMap[channelName] || togglingChannelMap[cleaned]
          );

          return (
            <div
              key={idx}
              className={`bg-[#111113] border rounded-xl overflow-hidden shadow-md transition-all ${
                isLive
                  ? "border-red-500/30"
                  : isRunning
                  ? "border-purple-500/20"
                  : "border-white/10 opacity-85"
              }`}
            >
              {/* Top Bar */}
              <div className="px-4 py-3 bg-white/[0.02] border-b border-white/5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                      isLive
                        ? "bg-red-500 animate-ping"
                        : isRunning
                        ? "bg-emerald-400 animate-pulse"
                        : "bg-gray-600"
                    }`}
                  />

                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {!isRunning ? (
                        editingChannelIndex === idx ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-purple-400 font-bold text-sm">@</span>
                            <input
                              type="text"
                              autoFocus
                              value={tempChannelName}
                              onChange={(e) => setTempChannelName(e.target.value)}
                              onBlur={() => commitChannelName(idx)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitChannelName(idx);
                                if (e.key === "Escape") setEditingChannelIndex(null);
                              }}
                              className="bg-black/60 border border-purple-500/60 rounded px-2.5 py-1 text-sm font-bold text-white focus:outline-none w-36"
                            />
                            <button
                              type="button"
                              onClick={() => commitChannelName(idx)}
                              className="p-1 hover:bg-white/10 rounded text-emerald-400 cursor-pointer"
                              title="Save name"
                            >
                              <Check className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => startEditingChannel(idx, channelName)}
                              className="group flex items-center gap-1.5 px-2 py-0.5 rounded-lg hover:bg-white/5 border border-transparent hover:border-white/10 transition-colors cursor-pointer"
                              title="Click to rename stream"
                            >
                              <h4 className="text-base font-bold text-white tracking-tight">
                                @{channelName}
                              </h4>
                              <Edit2 className="w-3.5 h-3.5 text-gray-500 group-hover:text-purple-400 transition-colors" />
                            </button>
                            {idx < 2 && (
                              <button
                                type="button"
                                onClick={() => {
                                  if (editingChannelIndex === idx) {
                                    setEditingChannelIndex(null);
                                    setTempChannelName("");
                                  }
                                  onClearChannelSlot(idx);
                                }}
                                className="p-1 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                                title="Clear this channel slot"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        )
                      ) : (
                        <h4 className="text-base font-bold text-white tracking-tight">
                          @{channelName}
                        </h4>
                      )}

                      {isLive ? (
                        <>
                          <span className="text-xs px-2.5 py-0.5 rounded-full bg-red-500/10 text-red-400 font-bold border border-red-500/25 uppercase tracking-wider animate-pulse flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                            Recording Live
                          </span>
                          {activeSession && (
                            <span className="text-xs px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-gray-300 font-mono tabular-nums font-medium flex items-center gap-1.5">
                              <Clock className="w-3 h-3 text-purple-400" />
                              Started{" "}
                              {new Date(activeSession.startTime).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          )}
                        </>
                      ) : isRunning ? (
                        <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-bold border border-emerald-500/20 uppercase tracking-wider">
                          Monitoring Active
                        </span>
                      ) : (
                        <span className="text-xs px-2.5 py-0.5 rounded-full bg-white/5 text-gray-400 font-bold border border-white/10 uppercase tracking-wider">
                          Paused
                        </span>
                      )}

                      {isLive && activeSession && (
                        <div className="flex items-center gap-2 text-sm flex-wrap">
                          {activeSession.currentGame && (() => {
                            const gameProfile = resolveClientGameProfile(
                              config,
                              activeSession.currentGame
                            );
                            return (
                              <button
                                type="button"
                                onClick={() =>
                                  onOpenQuickGameProfile(activeSession.currentGame!)
                                }
                                className="group inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 hover:border-purple-500/40 text-purple-300 font-medium transition-all cursor-pointer"
                                title={`Click to set or edit chat render resolution profile for "${activeSession.currentGame}" (Currently ${gameProfile.width}×${gameProfile.height}${
                                  gameProfile.isCustomProfile ? " custom profile" : " default"
                                })`}
                              >
                                <Gamepad2 className="w-3.5 h-3.5 text-purple-400" />
                                <span>{activeSession.currentGame}</span>
                                <span
                                  className={`text-[11px] font-mono tabular-nums px-1.5 py-0.2 rounded ${
                                    gameProfile.isCustomProfile
                                      ? "bg-purple-500/30 text-purple-200 border border-purple-400/40"
                                      : "bg-black/40 text-gray-400 group-hover:text-gray-200"
                                  }`}
                                >
                                  {gameProfile.width}×{gameProfile.height}
                                </span>
                                <Edit2 className="w-3 h-3 text-purple-400/60 group-hover:text-purple-300 transition-colors" />
                              </button>
                            );
                          })()}
                          {activeSession.viewersCount !== undefined &&
                            activeSession.viewersCount > 0 && (
                              <span className="inline-flex items-center gap-1.5 text-gray-300 bg-black/40 px-2.5 py-0.5 rounded-md border border-white/5 font-mono tabular-nums">
                                <Users className="w-3.5 h-3.5 text-red-400" />
                                {activeSession.viewersCount.toLocaleString()}
                              </span>
                            )}
                          {(() => {
                            const activeMode =
                              activeSession.captureMode ||
                              config?.channelCaptureModes?.[cleaned] ||
                              "both";
                            const modeLabel =
                              activeMode === "video_only"
                                ? "Video Only"
                                : activeMode === "chat_only"
                                ? "Chat Only"
                                : "Video + Chat";
                            return (
                              <span
                                className="inline-flex items-center gap-1 text-[11px] font-mono font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md bg-white/5 text-gray-300 border border-white/10"
                                title="Capture mode is locked while a broadcast is actively recording"
                              >
                                {modeLabel}
                              </span>
                            );
                          })()}
                        </div>
                      )}
                    </div>

                    <p className="text-xs text-gray-500 mt-0.5 font-mono tabular-nums">
                      {isLive
                        ? activeSession?.captureMode === "chat_only"
                          ? "Live IRC + Hermes overlay capture • Click game badge to set render resolution"
                          : "Source resolution • Click game badge to set render resolution"
                        : isRunning
                        ? `Last check: ${timeSinceCheck}s ago`
                        : "Monitoring paused • Click handle above to edit"}
                    </p>
                  </div>
                </div>

                {/* Individual Channel Controls */}
                <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                  <button
                    type="button"
                    onClick={() => onOpenFolder(activeSession?.folderPath)}
                    className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white border border-white/10 transition-colors cursor-pointer"
                    title={
                      activeSession?.folderPath
                        ? `Open session folder (${activeSession.folderPath})`
                        : "Open downloads folder"
                    }
                  >
                    <Folder className="w-4 h-4 text-purple-400" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleChannelMonitoring(channelName)}
                    disabled={isToggling}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold uppercase tracking-wider transition-all cursor-pointer ${
                      isToggling ? "opacity-75 cursor-wait " : ""
                    }${
                      isRunning
                        ? "bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25"
                        : "bg-purple-600 text-white hover:bg-purple-500 shadow-md shadow-purple-900/30"
                    }`}
                  >
                    {isToggling ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>{isRunning ? "Stopping..." : "Starting..."}</span>
                      </>
                    ) : isRunning ? (
                      <>
                        <Square className="w-3.5 h-3.5 fill-current" />
                        <span>Stop</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>Start</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Card Body */}
              {isLive && activeSession ? (
                <div className="p-4 space-y-3.5">
                  {(() => {
                    const activeMode =
                      activeSession.captureMode ||
                      config?.channelCaptureModes?.[cleaned] ||
                      "both";
                    return (
                      <div className="grid grid-cols-3 gap-2.5">
                        <div className="bg-black/30 border border-white/5 rounded-lg px-3 py-2 flex items-center justify-between">
                          <span className="text-xs text-gray-400 uppercase tracking-wider font-semibold">
                            Video Segments
                          </span>
                          {activeMode === "chat_only" ? (
                            <span className="text-xs font-mono text-gray-500 uppercase">
                              Off (Chat Only)
                            </span>
                          ) : (
                            <span className="text-sm sm:text-base font-bold text-white font-mono tabular-nums">
                              {activeSession.chunksDownloaded?.toLocaleString() || "0"}
                            </span>
                          )}
                        </div>
                        <div className="bg-black/30 border border-white/5 rounded-lg px-3 py-2 flex items-center justify-between">
                          <span className="text-xs text-gray-400 uppercase tracking-wider font-semibold">
                            Duration
                          </span>
                          <span className="text-sm sm:text-base font-bold text-white font-mono tabular-nums">
                            {formatDuration(activeSession.videoDurationSeconds || 0)}
                          </span>
                        </div>
                        <div className="bg-black/30 border border-white/5 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
                          <span className="text-xs text-gray-400 uppercase tracking-wider font-semibold flex items-center gap-1.5">
                            <MessageSquare className="w-3.5 h-3.5 text-purple-400" />
                            <span>Chat &amp; Events</span>
                            {activeMode !== "video_only" && (
                              <span
                                className={`w-2 h-2 rounded-full shrink-0 ${
                                  activeSession.ircConnected && activeSession.hermesConnected
                                    ? "bg-emerald-400"
                                    : activeSession.ircConnected ||
                                      activeSession.hermesConnected
                                    ? "bg-amber-400"
                                    : "bg-gray-500"
                                }`}
                                title={`Live Sockets — IRC: ${
                                  activeSession.ircConnected ? "Connected" : "Reconnecting"
                                } • Hermes Overlays: ${
                                  activeSession.hermesConnected ? "Subscribed" : "Reconnecting"
                                }`}
                              />
                            )}
                          </span>
                          {activeMode === "video_only" ? (
                            <span className="text-xs font-mono text-gray-500 uppercase">
                              Off (Video Only)
                            </span>
                          ) : (
                            <div className="flex items-center gap-1.5 font-mono tabular-nums">
                              <span
                                className="text-sm sm:text-base font-bold text-white"
                                title="Chat Messages & Notices"
                              >
                                {(activeSession.commentsWritten || 0).toLocaleString()}
                              </span>
                              {(activeSession.eventsWritten || 0) > 0 && (
                                <span
                                  className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30"
                                  title="Captured Broadcast & Moderation Events via Hermes & IRC (Predictions, Polls, Pins, Redemptions, Hype Trains, Raids, Moderation)"
                                >
                                  +{(activeSession.eventsWritten || 0).toLocaleString()}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Offline Grace Warning */}
                  {activeSession.missingCount !== undefined &&
                    activeSession.missingCount > 0 && (
                      <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg flex flex-wrap items-center justify-between gap-3 text-sm">
                        <div className="flex items-center gap-2.5 text-amber-400">
                          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
                          <div>
                            <span className="font-bold text-white">
                              Stream offline detected.{" "}
                            </span>
                            <span className="text-amber-200/90">
                              Grace period:{" "}
                              <span className="font-mono tabular-nums font-semibold text-amber-300">
                                {formatGraceCountdown(
                                  activeSession.offlineGraceRemainingSeconds
                                )}
                              </span>{" "}
                              remaining before automatic finalization.
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={Boolean(forceStitchingChannels[activeSession.channel])}
                          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg border transition-all border-amber-500/40 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 hover:text-white cursor-pointer shadow-sm ${
                            forceStitchingChannels[activeSession.channel]
                              ? "opacity-75 cursor-wait"
                              : ""
                          }`}
                          onClick={() => onForceStitch(activeSession.channel)}
                          title="Immediately conclude this broadcast and finalize recording now"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>
                            {forceStitchingChannels[activeSession.channel]
                              ? "Finalizing..."
                              : "Finalize Recording"}
                          </span>
                        </button>
                      </div>
                    )}

                  {/* Interactive Game Switch Notification Banner */}
                  {activeSession.pendingGameSwitch && (
                    <div className="p-3 bg-purple-500/10 border border-purple-500/30 rounded-lg flex flex-wrap items-center justify-between gap-3 text-sm">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-purple-500/20 border border-purple-500/30 flex items-center justify-center shrink-0">
                          <Scissors className="w-4 h-4 text-purple-400" />
                        </div>
                        <div>
                          <div className="font-semibold text-white flex items-center gap-2">
                            <span>Game Switch Detected:</span>
                            <span className="text-gray-400 line-through text-xs sm:text-sm">
                              {activeSession.pendingGameSwitch.previousGame}
                            </span>
                            <span className="text-purple-400">&rarr;</span>
                            <span className="text-purple-300 font-bold text-xs sm:text-sm">
                              {activeSession.pendingGameSwitch.currentGame}
                            </span>
                          </div>
                          <p className="text-xs text-purple-300/80 mt-0.5 tabular-nums">
                            Buffering transition (
                            {activeSession.pendingGameSwitch.secondsRemaining}s remaining
                            before automatic splice)
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={Boolean(isOverridingBuffer[activeSession.channel])}
                        onClick={() =>
                          onOverrideBuffer(
                            activeSession.channel,
                            activeSession.pendingGameSwitch?.gameIndex
                          )
                        }
                        className={`flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs font-bold uppercase tracking-wider transition-all shadow-md shadow-purple-900/30 cursor-pointer ${
                          isOverridingBuffer[activeSession.channel]
                            ? "opacity-75 cursor-wait"
                            : ""
                        }`}
                        title="Override buffer and immediately trigger game segment splice"
                      >
                        <Scissors className="w-3.5 h-3.5" />
                        <span>
                          {isOverridingBuffer[activeSession.channel]
                            ? "Splicing..."
                            : "Splice Immediately"}
                        </span>
                      </button>
                    </div>
                  )}

                  {/* Awaiting Twitch Category Update Banner */}
                  {(() => {
                    const latestGame =
                      activeSession.games && activeSession.games.length > 0
                        ? activeSession.games[activeSession.games.length - 1]
                        : null;
                    if (!latestGame?.isAwaitingNextGame) return null;
                    const effectiveLeadMins =
                      latestGame.customLeadingBufferMins ??
                      (config?.gameSwitchBufferMins ?? 5) * 2;
                    return (
                      <div className="p-3 bg-cyan-500/10 border border-cyan-500/30 rounded-lg flex flex-wrap items-center justify-between gap-3 text-sm">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-lg bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center shrink-0">
                            <Clock className="w-4 h-4 text-cyan-400 animate-pulse" />
                          </div>
                          <div>
                            <div className="font-semibold text-white flex items-center gap-2 flex-wrap">
                              <span>Awaiting Twitch Category Update</span>
                              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                                Fallback: {latestGame.gameName}
                              </span>
                              <span className="text-[11px] font-mono tabular-nums px-2 py-0.5 rounded bg-white/5 text-gray-300 border border-white/10">
                                {effectiveLeadMins}m lead buffer
                              </span>
                            </div>
                            <p className="text-xs text-cyan-200/80 mt-0.5">
                              Recording into next game segment. Will automatically adopt the new game name as soon as the broadcaster updates their Twitch category.
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Stream Options & Actions Footer */}
                  <div className="pt-2.5 flex flex-wrap items-center justify-between gap-3 text-sm border-t border-white/5">
                    {(() => {
                      const isVideoOnly =
                        (activeSession.captureMode ||
                          config?.channelCaptureModes?.[cleaned] ||
                          "both") === "video_only";
                      const isChecked = activeSession
                        ? activeSession.autoRenderChat || false
                        : config?.channelAutoRender?.[cleaned] ??
                          config?.autoRenderChat ??
                          false;
                      return (
                        <label
                          className={`flex items-center gap-2.5 transition-opacity ${
                            isVideoOnly
                              ? "opacity-40 cursor-not-allowed text-gray-500"
                              : "cursor-pointer text-gray-400 hover:text-gray-300"
                          }`}
                          title={
                            isVideoOnly
                              ? "Chat capture and rendering are disabled in Video Only mode"
                              : "Automatically render chat video when each game segment, VOD backfill, clip, or broadcast finishes"
                          }
                        >
                          <input
                            type="checkbox"
                            disabled={isVideoOnly}
                            checked={isChecked}
                            onChange={() => {
                              if (!isVideoOnly) {
                                onToggleAutoRender(channelName, isChecked);
                              }
                            }}
                            className="w-4 h-4 rounded border-white/20 bg-black/40 text-purple-600 focus:ring-0 disabled:cursor-not-allowed"
                          />
                          <span className="text-sm">Auto-render chat segments</span>
                        </label>
                      );
                    })()}

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={Boolean(isManualSplicing[activeSession.channel])}
                        onClick={() => onOpenSpliceModal(activeSession.channel)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white border border-white/10 hover:border-purple-500/40 transition-all cursor-pointer ${
                          isManualSplicing[activeSession.channel]
                            ? "opacity-75 cursor-wait"
                            : ""
                        }`}
                        title="Cut game segment, extract a standalone highlight clip, or append to previous game"
                      >
                        <Scissors className="w-3.5 h-3.5 text-purple-400" />
                        <span>
                          {isManualSplicing[activeSession.channel]
                            ? "Cutting..."
                            : "Splice Game Segment"}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                /* Offline / Idle State */
                <div className="px-4 py-3 bg-black/20 flex flex-wrap items-center justify-between gap-3 text-sm">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="w-2 h-2 rounded-full bg-gray-500 shrink-0" />
                    <span className="font-semibold text-gray-300">Stream Offline.</span>
                    <span className="text-gray-400">
                      Recording will start when broadcast begins.
                    </span>
                    {!isChannelMonitored && (
                      <span className="text-xs text-purple-400 font-mono ml-1">
                        (Click handle above to edit)
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-3 ml-auto">
                    {(() => {
                      const currentMode =
                        config?.channelCaptureModes?.[cleaned] || "both";
                      const isVideoOnly = currentMode === "video_only";
                      const isChecked =
                        config?.channelAutoRender?.[cleaned] ??
                        config?.autoRenderChat ??
                        false;
                      return (
                        <>
                          <div
                            className="inline-flex items-center bg-[#18181b] border border-white/10 rounded-lg p-0.5"
                            title="Select what to record for this channel before the broadcast begins"
                          >
                            {(
                              [
                                { id: "both", label: "Video + Chat" },
                                { id: "video_only", label: "Video Only" },
                                { id: "chat_only", label: "Chat Only" },
                              ] as const
                            ).map((opt) => (
                              <button
                                key={opt.id}
                                type="button"
                                onClick={() => onSetCaptureMode(channelName, opt.id)}
                                className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                                  currentMode === opt.id
                                    ? "bg-purple-600 text-white shadow-sm"
                                    : "text-gray-400 hover:text-white"
                                }`}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>

                          <label
                            className={`flex items-center gap-2 shrink-0 transition-opacity ${
                              isVideoOnly
                                ? "opacity-40 cursor-not-allowed text-gray-500"
                                : "cursor-pointer text-gray-400 hover:text-gray-300"
                            }`}
                            title={
                              isVideoOnly
                                ? "Chat capture and rendering are disabled in Video Only mode"
                                : "Automatically render chat video when each game segment, VOD backfill, clip, or broadcast finishes"
                            }
                          >
                            <input
                              type="checkbox"
                              disabled={isVideoOnly}
                              checked={isChecked}
                              onChange={() => {
                                if (!isVideoOnly) {
                                  onToggleAutoRender(channelName, isChecked);
                                }
                              }}
                              className="w-4 h-4 rounded border-white/20 bg-black/40 text-purple-600 focus:ring-0 disabled:cursor-not-allowed"
                            />
                            <span className="text-xs sm:text-sm">
                              Auto-render chat segments
                            </span>
                          </label>
                        </>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Unified Activity & Task Queue */}
      <TaskQueuePanel
        activeTasks={status?.activeTasks || []}
        pendingTaskActions={pendingTaskActions}
        isDismissingCompleted={isDismissingCompleted}
        onTaskAction={onTaskAction}
        onConfirmCancelRender={onConfirmCancelRender}
        onDismissCompleted={onDismissCompletedTasks}
      />
    </motion.div>
  );
};
