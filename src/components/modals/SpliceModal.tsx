import React, { useEffect, useState } from "react";
import { Scissors, X } from "lucide-react";
import type { ActiveSessionView, Config } from "../../types";
import { cleanChannel } from "../../utils/formatters";

export type SpliceActionType =
  | "append_previous"
  | "extract_clip"
  | "split_new_part"
  | "await_next_game";

export type ClipScopeType = "whole_game" | "custom_duration";

interface SpliceModalProps {
  channel: string | null;
  activeSession?: ActiveSessionView;
  config: Config | null;
  onClose: () => void;
  onExecute: (
    channel: string,
    action: SpliceActionType,
    scope: ClipScopeType,
    clipMinutes: number,
    leadingBufferMinutes: number
  ) => void;
}

export const SpliceModal: React.FC<SpliceModalProps> = ({
  channel,
  activeSession,
  config,
  onClose,
  onExecute,
}) => {
  const defaultBufMins = config?.gameSwitchBufferMins ?? 5;
  const [spliceAction, setSpliceAction] = useState<SpliceActionType>("split_new_part");
  const [clipScope, setClipScope] = useState<ClipScopeType>("custom_duration");
  const [clipMinutes, setClipMinutes] = useState<number>(5.0);
  const [awaitLeadingBufferInput, setAwaitLeadingBufferInput] = useState<string>(
    String(defaultBufMins * 2)
  );

  useEffect(() => {
    if (channel) {
      setSpliceAction("split_new_part");
      setAwaitLeadingBufferInput(String((config?.gameSwitchBufferMins ?? 5) * 2));
    }
  }, [channel, config?.gameSwitchBufferMins]);

  if (!channel) return null;

  const sessionCaptureMode =
    activeSession?.captureMode ||
    config?.channelCaptureModes?.[cleanChannel(channel)] ||
    "both";
  const isChatOnlyMode = sessionCaptureMode === "chat_only";
  const isVideoOnlyMode = sessionCaptureMode === "video_only";
  const mediaNoun = isChatOnlyMode
    ? "chat log"
    : isVideoOnlyMode
    ? "video"
    : "video and chat";
  const games = activeSession?.games || [];
  const hasPrevious = games.length > 1;
  const previousGameName = hasPrevious ? games[games.length - 2].gameName : null;
  const currentGameName =
    activeSession?.currentGame ||
    (games.length > 0 ? games[games.length - 1].gameName : "Current Game");
  const currentGameDurationSec = Math.max(
    0,
    (activeSession?.videoDurationSeconds || 0) -
      (games[games.length - 1]?.startTimeOffset || 0)
  );
  const currentGameDurationMins = Math.max(
    0.1,
    currentGameDurationSec / 60
  ).toFixed(1);

  const lastSegmentName =
    games.length > 0 ? games[games.length - 1].gameName : currentGameName;
  const partMatch = lastSegmentName.match(/^(.*?)\s+Part\s+(\d+)$/i);
  const fallbackNextName = partMatch
    ? `${partMatch[1]} Part ${parseInt(partMatch[2], 10) + 1}`
    : `${lastSegmentName} Part 2`;
  const parsedLeadMins = parseFloat(awaitLeadingBufferInput);
  const effectiveLeadMins =
    Number.isFinite(parsedLeadMins) && parsedLeadMins >= 0
      ? parsedLeadMins
      : defaultBufMins * 2;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-[#141416] border border-purple-500/30 rounded-2xl w-full max-w-xl p-6 shadow-2xl space-y-5 my-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/25 flex items-center justify-center shrink-0">
              <Scissors className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white tracking-tight">
                Manual Stream Splice &amp; Clip
              </h3>
              <p className="text-xs text-purple-300 font-mono">
                @{channel} • Playing {currentGameName}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-xs text-gray-400 leading-relaxed">
          Choose what to do with the {mediaNoun} recorded up to this moment:
        </p>

        <div className="space-y-3">
          {/* Option 1: Append to Previous Game */}
          <label
            className={`block p-3.5 rounded-xl border transition-all cursor-pointer ${
              !hasPrevious
                ? "opacity-40 border-white/5 bg-white/[0.02] cursor-not-allowed"
                : spliceAction === "append_previous"
                ? "border-purple-500/70 bg-purple-950/25 shadow-sm shadow-purple-500/10"
                : "border-white/10 bg-white/[0.03] hover:border-white/20"
            }`}
          >
            <div className="flex items-start gap-3">
              <input
                type="radio"
                name="splice_action"
                value="append_previous"
                disabled={!hasPrevious}
                checked={spliceAction === "append_previous"}
                onChange={() => setSpliceAction("append_previous")}
                className="mt-1 text-purple-600 focus:ring-0 cursor-pointer disabled:cursor-not-allowed"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-white">
                    Append Extension to Previous Game
                  </span>
                  {hasPrevious ? (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 truncate max-w-[150px]">
                      {previousGameName}
                    </span>
                  ) : (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/5 text-gray-400 border border-white/10">
                      Unavailable: 1st segment
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                  {isChatOnlyMode
                    ? `Slices chat recorded up to now as a standalone extension file for ${
                        previousGameName || "the previous game"
                      } and shifts ${currentGameName}'s start point to now.`
                    : isVideoOnlyMode
                    ? `Slices video recorded up to now and stitches it as a seamless extension file to ${
                        previousGameName || "the previous game"
                      }. Shifts ${currentGameName}'s start point to now.`
                    : `Slices footage recorded up to now and stitches it as a seamless extension file to ${
                        previousGameName || "the previous game"
                      } with matching chat. Shifts ${currentGameName}'s start point to now.`}
                </p>
              </div>
            </div>
          </label>

          {/* Option 2: Extract Standalone Highlight / Clip */}
          <label
            className={`block p-3.5 rounded-xl border transition-all cursor-pointer ${
              spliceAction === "extract_clip"
                ? "border-purple-500/70 bg-purple-950/25 shadow-sm shadow-purple-500/10"
                : "border-white/10 bg-white/[0.03] hover:border-white/20"
            }`}
          >
            <div className="flex items-start gap-3">
              <input
                type="radio"
                name="splice_action"
                value="extract_clip"
                checked={spliceAction === "extract_clip"}
                onChange={() => setSpliceAction("extract_clip")}
                className="mt-1 text-purple-600 focus:ring-0 cursor-pointer"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-white">
                    Extract Standalone Highlight / Clip
                  </span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
                    Non-destructive
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                  {isChatOnlyMode
                    ? "Exports a standalone chat clip right now. The ongoing broadcast recording continues completely untouched without splitting the master game segment."
                    : isVideoOnlyMode
                    ? "Remuxes a standalone video clip right now. The ongoing broadcast recording continues completely untouched without splitting the master game VOD."
                    : "Remuxes a standalone video and chat clip right now. The ongoing broadcast recording continues completely untouched without splitting the master game VOD."}
                </p>

                {spliceAction === "extract_clip" && (
                  <div className="mt-3 pt-3 border-t border-white/10 space-y-2.5">
                    <div className="flex items-center gap-4 text-xs">
                      <label className="flex items-center gap-1.5 cursor-pointer text-gray-300 hover:text-white tabular-nums">
                        <input
                          type="radio"
                          name="clip_scope"
                          value="whole_game"
                          checked={clipScope === "whole_game"}
                          onChange={() => setClipScope("whole_game")}
                          className="text-purple-600 focus:ring-0"
                        />
                        <span>
                          Whole game until now (~{currentGameDurationMins} min)
                        </span>
                      </label>

                      <label className="flex items-center gap-1.5 cursor-pointer text-gray-300 hover:text-white">
                        <input
                          type="radio"
                          name="clip_scope"
                          value="custom_duration"
                          checked={clipScope === "custom_duration"}
                          onChange={() => setClipScope("custom_duration")}
                          className="text-purple-600 focus:ring-0"
                        />
                        <span>Last X minutes</span>
                      </label>
                    </div>

                    {clipScope === "custom_duration" && (
                      <div className="flex items-center gap-2 pt-1">
                        <span className="text-xs text-gray-400">Duration:</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            setClipMinutes((prev) =>
                              Math.max(0.5, Number((prev - 0.5).toFixed(1)))
                            );
                          }}
                          className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white font-mono tabular-nums text-xs font-bold transition-colors cursor-pointer"
                        >
                          -0.5m
                        </button>
                        <input
                          type="number"
                          min="0.5"
                          max="180"
                          step="0.5"
                          value={clipMinutes}
                          onChange={(e) =>
                            setClipMinutes(
                              Math.max(
                                0.5,
                                Math.min(180, parseFloat(e.target.value) || 0.5)
                              )
                            )
                          }
                          className="w-20 px-2.5 py-1 text-xs text-center rounded bg-black/40 border border-white/20 text-white font-mono tabular-nums focus:outline-none focus:border-purple-500"
                        />
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            setClipMinutes((prev) =>
                              Math.min(180, Number((prev + 0.5).toFixed(1)))
                            );
                          }}
                          className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white font-mono tabular-nums text-xs font-bold transition-colors cursor-pointer"
                        >
                          +0.5m
                        </button>
                        <span className="text-[11px] text-gray-400 font-mono tabular-nums">
                          ({Math.round(clipMinutes * 60)}s
                          {!isChatOnlyMode
                            ? ` • ~${Math.round(clipMinutes * 30)} chunks`
                            : ""}
                          )
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </label>

          {/* Option 3: Split into New Part */}
          <label
            className={`block p-3.5 rounded-xl border transition-all cursor-pointer ${
              spliceAction === "split_new_part"
                ? "border-purple-500/70 bg-purple-950/25 shadow-sm shadow-purple-500/10"
                : "border-white/10 bg-white/[0.03] hover:border-white/20"
            }`}
          >
            <div className="flex items-start gap-3">
              <input
                type="radio"
                name="splice_action"
                value="split_new_part"
                checked={spliceAction === "split_new_part"}
                onChange={() => setSpliceAction("split_new_part")}
                className="mt-1 text-purple-600 focus:ring-0 cursor-pointer"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-white">
                    Split Game into New Part / Chapter
                  </span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    New segment
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                  Finalizes the current segment now for{" "}
                  {isChatOnlyMode ? "chat slicing" : "stitching"} and starts the
                  next part immediately, preserving the transition buffer.
                </p>
              </div>
            </div>
          </label>

          {/* Option 4: End Current Game & Await Next Twitch Category Switch */}
          <label
            className={`block p-3.5 rounded-xl border transition-all cursor-pointer ${
              spliceAction === "await_next_game"
                ? "border-purple-500/70 bg-purple-950/25 shadow-sm shadow-purple-500/10"
                : "border-white/10 bg-white/[0.03] hover:border-white/20"
            }`}
          >
            <div className="flex items-start gap-3">
              <input
                type="radio"
                name="splice_action"
                value="await_next_game"
                checked={spliceAction === "await_next_game"}
                onChange={() => setSpliceAction("await_next_game")}
                className="mt-1 text-purple-600 focus:ring-0 cursor-pointer"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-white">
                    End Current Game &amp; Await Next Category Switch
                  </span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                    Late category update
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                  Immediately ends and {isChatOnlyMode ? "slices" : "stitches"}{" "}
                  <strong>{lastSegmentName}</strong>, then records upcoming{" "}
                  {isChatOnlyMode ? "chat" : "footage"} into the next game
                  segment (temporarily labeled{" "}
                  <strong>{fallbackNextName}</strong> until the broadcaster
                  updates their Twitch category).
                </p>

                {spliceAction === "await_next_game" && (
                  <div className="mt-3 pt-3 border-t border-white/10 space-y-2">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="text-xs text-gray-300 font-medium">
                        Leading Buffer Override (minutes):
                      </span>
                      <input
                        type="number"
                        min="0"
                        max="120"
                        step="0.5"
                        value={awaitLeadingBufferInput}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setAwaitLeadingBufferInput(e.target.value)}
                        onBlur={(e) => {
                          const v = parseFloat(e.target.value);
                          const clamped = Number.isFinite(v)
                            ? Math.max(0, Math.min(120, v))
                            : defaultBufMins * 2;
                          setAwaitLeadingBufferInput(String(clamped));
                        }}
                        className="w-24 px-2.5 py-1 text-xs text-center rounded bg-black/40 border border-white/20 text-white font-mono tabular-nums focus:outline-none focus:border-purple-500"
                      />
                      <span className="text-[11px] text-gray-400 font-mono tabular-nums">
                        (Default: {defaultBufMins * 2}m = 2x {defaultBufMins}m buffer
                        {!isChatOnlyMode
                          ? ` • ~${Math.round(effectiveLeadMins * 30)} chunks`
                          : ""}
                        )
                      </span>
                    </div>
                    <p className="text-[11px] text-gray-400 leading-relaxed tabular-nums">
                      Includes the last{" "}
                      <strong>{effectiveLeadMins} minutes</strong> before now as
                      leading {isChatOnlyMode ? "chat" : "footage"} for the new
                      game so early activity before you clicked splice is retained.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </label>
        </div>

        {/* Live Preview Summary */}
        <div className="p-3 rounded-xl bg-purple-950/30 border border-purple-500/20 text-xs text-purple-200 flex items-start gap-2 tabular-nums">
          <span className="font-bold text-purple-400 shrink-0">Summary:</span>
          <div className="leading-relaxed">
            {spliceAction === "append_previous" && (
              <span>
                {isChatOnlyMode ? (
                  <>
                    Will slice extra chat up to now as an extension file for{" "}
                    <strong>{previousGameName}</strong>, then advance{" "}
                    <strong>{currentGameName}</strong>&apos;s start point.
                  </>
                ) : isVideoOnlyMode ? (
                  <>
                    Will stitch extra video up to now as an extension file for{" "}
                    <strong>{previousGameName}</strong>, then advance{" "}
                    <strong>{currentGameName}</strong>&apos;s start point.
                  </>
                ) : (
                  <>
                    Will stitch extra footage up to now as an extension file for{" "}
                    <strong>{previousGameName}</strong> with matching chat, then
                    advance <strong>{currentGameName}</strong>&apos;s start point.
                  </>
                )}
              </span>
            )}
            {spliceAction === "extract_clip" && clipScope === "whole_game" && (
              <span>
                Will export a standalone ~
                <strong>{currentGameDurationMins}m</strong> {mediaNoun} clip of{" "}
                <strong>{currentGameName}</strong> up to now. The live recording
                continues without interruption.
              </span>
            )}
            {spliceAction === "extract_clip" &&
              clipScope === "custom_duration" && (
                <span>
                  Will extract a standalone <strong>{clipMinutes}m</strong>{" "}
                  {mediaNoun} clip of <strong>{currentGameName}</strong> ending
                  now. The live recording continues without interruption.
                </span>
              )}
            {spliceAction === "split_new_part" && (
              <span>
                Will finalize <strong>{currentGameName}</strong> (Segment{" "}
                {games.length || 1}) and immediately begin Part {games.length + 1}{" "}
                with leading buffer preserved.
              </span>
            )}
            {spliceAction === "await_next_game" && (
              <span>
                Will finalize and {isChatOnlyMode ? "slice" : "stitch"}{" "}
                <strong>{lastSegmentName}</strong> now, retain a{" "}
                <strong>{effectiveLeadMins}m</strong> leading buffer for the new
                segment (labeled <strong>{fallbackNextName}</strong>), and
                automatically rename it when the Twitch game category updates.
              </span>
            )}
          </div>
        </div>

        {/* Modal Actions */}
        <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-400 hover:text-white transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onExecute(
                channel,
                spliceAction,
                clipScope,
                clipMinutes,
                effectiveLeadMins
              );
            }}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-purple-600 hover:bg-purple-500 transition-colors shadow-md shadow-purple-900/30 cursor-pointer"
          >
            Execute Splice
          </button>
        </div>
      </div>
    </div>
  );
};
