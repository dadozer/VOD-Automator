import React from "react";
import { AlertCircle, CheckCircle2, RefreshCw, Wrench, X } from "lucide-react";
import type { RecentFolderItem } from "../../types";

interface RecoverFolderModalProps {
  isOpen: boolean;
  recentFolders: RecentFolderItem[];
  isLoadingRecent: boolean;
  folderPath: string;
  isStarting: boolean;
  statusMsg: { type: "success" | "error"; text: string } | null;
  onChangePath: (path: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}

export const RecoverFolderModal: React.FC<RecoverFolderModalProps> = ({
  isOpen,
  recentFolders,
  isLoadingRecent,
  folderPath,
  isStarting,
  statusMsg,
  onChangePath,
  onClose,
  onSubmit,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#141416] border border-white/15 rounded-2xl w-full max-w-lg p-6 shadow-2xl space-y-5">
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-2.5">
            <Wrench className="w-5 h-5 text-purple-400" />
            <h3 className="text-lg font-bold text-white tracking-tight">
              Recover Folder Video
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
          <p className="text-xs text-gray-400 leading-relaxed">
            Scans a recording session directory for uncompiled live (
            <code>seq_*.ts</code>) and VOD backfill (<code>vod_seq_*.ts</code>)
            chunks and stitches them into standalone MP4 videos with paired chat JSON files.
          </p>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider block">
              Select Recent Session Folder
            </label>
            <select
              value={folderPath}
              onChange={(e) => onChangePath(e.target.value)}
              disabled={isLoadingRecent}
              className="w-full bg-[#1c1c1f] border border-white/10 rounded-lg px-3 py-2 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-purple-500/50 cursor-pointer"
            >
              <option value="">
                {isLoadingRecent
                  ? "Scanning downloads directory..."
                  : "-- Select a session folder --"}
              </option>
              {recentFolders.map((folder) => (
                <option key={folder.folderPath} value={folder.folderPath}>
                  {folder.name} ({folder.liveChunkCount} live chunks,{" "}
                  {folder.vodChunkCount} VOD chunks, {folder.mp4Files.length} MP4s)
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider block">
              Or Enter Folder Path Manually
            </label>
            <input
              type="text"
              value={folderPath}
              onChange={(e) => onChangePath(e.target.value)}
              placeholder="e.g. downloads/streamer_2026-10-18_123456"
              className="w-full bg-[#1c1c1f] border border-white/10 rounded-lg px-3.5 py-2.5 text-sm font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white placeholder-gray-600 shadow-inner"
            />
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
            disabled={isStarting || !folderPath.trim()}
            className={`flex items-center gap-2 px-5 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-semibold uppercase tracking-wider transition-colors shadow-md shadow-purple-900/30 cursor-pointer ${
              isStarting || !folderPath.trim()
                ? "opacity-75 cursor-not-allowed"
                : ""
            }`}
          >
            {isStarting && <RefreshCw className="w-4 h-4 animate-spin" />}
            {isStarting ? "Recovering..." : "Recover Video"}
          </button>
        </div>
      </div>
    </div>
  );
};
