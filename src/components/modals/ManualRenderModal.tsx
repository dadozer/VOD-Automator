import React from "react";
import { AlertCircle, CheckCircle2, Film, RefreshCw, X } from "lucide-react";
import type { RecentFolderItem } from "../../types";

interface ManualRenderModalProps {
  isOpen: boolean;
  recentFolders: RecentFolderItem[];
  filePath: string;
  width: number | string;
  height: number | string;
  defaultWidth: number;
  defaultHeight: number;
  matchedProfile: string | null;
  isStarting: boolean;
  statusMsg: { type: "success" | "error"; text: string } | null;
  onChangePath: (path: string) => void;
  onBlurOrSelectPath: (path: string) => void;
  onChangeWidth: (width: number | string) => void;
  onChangeHeight: (height: number | string) => void;
  onClose: () => void;
  onSubmit: () => void;
}

export const ManualRenderModal: React.FC<ManualRenderModalProps> = ({
  isOpen,
  recentFolders,
  filePath,
  width,
  height,
  defaultWidth,
  defaultHeight,
  matchedProfile,
  isStarting,
  statusMsg,
  onChangePath,
  onBlurOrSelectPath,
  onChangeWidth,
  onChangeHeight,
  onClose,
  onSubmit,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#141416] border border-white/15 rounded-2xl w-full max-w-lg p-6 shadow-2xl space-y-5">
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-2.5">
            <Film className="w-5 h-5 text-purple-400" />
            <h3 className="text-lg font-bold text-white tracking-tight">
              Manual Chat Render
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          {recentFolders.some((f) => f.chatFiles.length > 0) && (
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider block">
                Quick Select Recent Chat JSON
              </label>
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) {
                    onChangePath(e.target.value);
                    onBlurOrSelectPath(e.target.value);
                  }
                }}
                className="w-full bg-[#1c1c1f] border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-purple-500/50 cursor-pointer"
              >
                <option value="">
                  -- Choose a downloaded chat file from recent sessions --
                </option>
                {recentFolders.map((folder) =>
                  folder.chatFiles.map((cf) => {
                    const sep = folder.folderPath.includes("\\") ? "\\" : "/";
                    const fullFile = `${folder.folderPath}${sep}${cf}`;
                    return (
                      <option key={fullFile} value={fullFile}>
                        {folder.name} / {cf}
                      </option>
                    );
                  })
                )}
              </select>
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider block">
                Chat JSON File Path
              </label>
              {matchedProfile && (
                <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  Matched Profile: {matchedProfile}
                </span>
              )}
            </div>
            <input
              type="text"
              value={filePath}
              onChange={(e) => onChangePath(e.target.value)}
              onBlur={(e) => onBlurOrSelectPath(e.target.value)}
              placeholder="e.g. downloads/channel_2026-10-18/chat.json (or full path)"
              className="w-full bg-[#1c1c1f] border border-white/10 rounded-lg px-3.5 py-2.5 text-sm font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white placeholder-gray-600 shadow-inner"
            />
            <p className="text-xs text-gray-500">
              Select a file above or paste the path to any chat JSON file. Dimensions auto-fill if the game matches a saved profile.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Width (px)
              </label>
              <input
                type="number"
                value={width ?? ""}
                onChange={(e) => onChangeWidth(e.target.value)}
                onBlur={(e) =>
                  onChangeWidth(parseInt(e.target.value, 10) || defaultWidth)
                }
                className="w-full bg-[#1c1c1f] border border-white/10 rounded-lg px-3 py-2 text-sm font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Height (px)
              </label>
              <input
                type="number"
                value={height ?? ""}
                onChange={(e) => onChangeHeight(e.target.value)}
                onBlur={(e) =>
                  onChangeHeight(parseInt(e.target.value, 10) || defaultHeight)
                }
                className="w-full bg-[#1c1c1f] border border-white/10 rounded-lg px-3 py-2 text-sm font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
              />
            </div>
          </div>

          {statusMsg && (
            <div
              className={`p-3 rounded-lg text-xs flex items-center gap-2 ${
                statusMsg.type === "success"
                  ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
                  : "bg-red-500/10 border border-red-500/20 text-red-400"
              }`}
            >
              {statusMsg.type === "success" ? (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0" />
              )}
              <span>{statusMsg.text}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10">
          <button
            type="button"
            onClick={onClose}
            disabled={isStarting}
            className="px-4 py-2 text-sm font-semibold text-gray-400 hover:text-white rounded-lg transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={isStarting || !filePath.trim()}
            className={`flex items-center gap-2 px-5 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-semibold uppercase tracking-wider transition-colors shadow-md shadow-purple-900/30 cursor-pointer ${
              isStarting || !filePath.trim()
                ? "opacity-75 cursor-not-allowed"
                : ""
            }`}
          >
            {isStarting && <RefreshCw className="w-4 h-4 animate-spin" />}
            {isStarting ? "Starting..." : "Start Render"}
          </button>
        </div>
      </div>
    </div>
  );
};
