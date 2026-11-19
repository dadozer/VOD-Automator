import React from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Folder,
  RefreshCw,
  X,
} from "lucide-react";
import type { ActiveSessionView, ActiveTask, Config } from "../../types";
import type { AppTab } from "../Sidebar";
import { cleanChannel } from "../../utils/formatters";

interface UnsavedSettingsModalProps {
  pendingTab: AppTab | null;
  onStay: () => void;
  onDiscardAndLeave: (dest: AppTab) => void;
  onSaveAndLeave: (dest: AppTab) => void;
}

export const UnsavedSettingsModal: React.FC<UnsavedSettingsModalProps> = ({
  pendingTab,
  onStay,
  onDiscardAndLeave,
  onSaveAndLeave,
}) => {
  if (!pendingTab) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#141416] border border-amber-500/30 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-center justify-center shrink-0">
            <AlertCircle className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white tracking-tight">
              Unsaved Settings Changes
            </h3>
            <p className="text-xs text-gray-400">
              You have modified settings that haven&apos;t been saved yet
            </p>
          </div>
        </div>

        <p className="text-sm text-gray-300 leading-relaxed">
          Would you like to save your configuration changes before leaving the Settings tab, or discard them?
        </p>

        <div className="flex flex-wrap items-center justify-end gap-2.5 pt-3 border-t border-white/10">
          <button
            type="button"
            onClick={onStay}
            className="px-3.5 py-2 rounded-lg text-xs font-semibold text-gray-400 hover:text-white transition-colors cursor-pointer"
          >
            Stay Here
          </button>
          <button
            type="button"
            onClick={() => onDiscardAndLeave(pendingTab)}
            className="px-3.5 py-2 rounded-lg text-xs font-semibold text-gray-300 bg-white/5 hover:bg-white/10 border border-white/10 transition-colors cursor-pointer"
          >
            Discard &amp; Leave
          </button>
          <button
            type="button"
            onClick={() => onSaveAndLeave(pendingTab)}
            className="px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-wider text-white bg-purple-600 hover:bg-purple-500 transition-colors shadow-md shadow-purple-900/30 cursor-pointer"
          >
            Save &amp; Leave
          </button>
        </div>
      </div>
    </div>
  );
};

interface StopRecordingModalProps {
  channel: string | null;
  activeSessions: ActiveSessionView[];
  config: Config | null;
  onCancel: () => void;
  onConfirmStop: (channel: string) => void;
}

export const StopRecordingModal: React.FC<StopRecordingModalProps> = ({
  channel,
  activeSessions,
  config,
  onCancel,
  onConfirmStop,
}) => {
  if (!channel) return null;

  const cleaned = cleanChannel(channel);
  const stopSession = activeSessions.find(
    (s) => cleanChannel(s.channel) === cleaned
  );
  const stopMode =
    stopSession?.captureMode ||
    config?.channelCaptureModes?.[cleaned] ||
    "both";
  const stopAutoRender = stopSession
    ? Boolean(stopSession.autoRenderChat)
    : Boolean(config?.channelAutoRender?.[cleaned] ?? config?.autoRenderChat);
  const stopActionText =
    stopMode === "video_only"
      ? "segment video stitching"
      : stopMode === "chat_only"
      ? stopAutoRender
        ? "chat segment slicing and chat rendering"
        : "chat segment slicing"
      : stopAutoRender
      ? "segment stitching, chat slicing, and automatic chat rendering"
      : "segment video stitching and chat slicing";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#141416] border border-red-500/30 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/25 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white tracking-tight">
              Stop Live Recording?
            </h3>
            <p className="text-xs text-gray-400 font-mono">
              @{channel} is actively recording
            </p>
          </div>
        </div>

        <p className="text-sm text-gray-300 leading-relaxed">
          Stream @{channel} is actively recording! Stopping monitoring now will conclude recording and immediately trigger {stopActionText}.
        </p>

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-400 hover:text-white transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirmStop(channel)}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-red-600 hover:bg-red-500 transition-colors shadow-md shadow-red-900/30 cursor-pointer"
          >
            Stop Recording
          </button>
        </div>
      </div>
    </div>
  );
};

interface RebootConfirmModalProps {
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const RebootConfirmModal: React.FC<RebootConfirmModalProps> = ({
  isOpen,
  onCancel,
  onConfirm,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#141416] border border-red-500/30 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/25 flex items-center justify-center shrink-0">
            <RefreshCw className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white tracking-tight">
              Reboot Program?
            </h3>
            <p className="text-xs text-gray-400">Cancel all tasks and reset state</p>
          </div>
        </div>

        <p className="text-sm text-gray-300 leading-relaxed">
          Are you sure you want to reboot the program? This will cancel all active background tasks, terminate active chat renders, and reset stream monitoring.
        </p>

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-400 hover:text-white transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-red-600 hover:bg-red-500 transition-colors shadow-md shadow-red-900/30 cursor-pointer"
          >
            Reboot Program
          </button>
        </div>
      </div>
    </div>
  );
};

interface CancelRenderModalProps {
  task: ActiveTask | null;
  onCancel: () => void;
  onConfirmCancel: (taskId: string) => void;
}

export const CancelRenderModal: React.FC<CancelRenderModalProps> = ({
  task,
  onCancel,
  onConfirmCancel,
}) => {
  if (!task) return null;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-[#141416] border border-red-500/30 p-6 rounded-xl max-w-md w-full space-y-4 shadow-2xl">
        <div className="flex items-center gap-3 text-red-400">
          <div className="w-10 h-10 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-white tracking-tight">
              Cancel Chat Render?
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">{task.name}</p>
          </div>
        </div>
        <p className="text-sm text-gray-300 leading-relaxed">
          Are you sure you want to cancel this chat render? The render process will terminate and any partial render progress will be discarded.
        </p>
        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 bg-white/5 hover:bg-white/10 text-gray-300 rounded-lg text-sm font-semibold transition-colors border border-white/10 cursor-pointer"
          >
            Keep Rendering
          </button>
          <button
            type="button"
            onClick={() => onConfirmCancel(task.id)}
            className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-semibold transition-colors shadow-md shadow-red-900/30 cursor-pointer"
          >
            Yes, Cancel Render
          </button>
        </div>
      </div>
    </div>
  );
};

export interface ToastMessageState {
  text: string;
  type: "success" | "info" | "error";
  title?: string;
}

export const ToastBanner: React.FC<{
  toast: ToastMessageState | null;
  onDismiss: () => void;
}> = ({ toast, onDismiss }) => {
  if (!toast) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 max-w-md animate-in fade-in slide-in-from-bottom-3 duration-200">
      <div
        className={`p-4 rounded-xl shadow-2xl border flex items-start gap-3 ${
          toast.type === "error"
            ? "bg-red-950/95 border-red-500/40 text-red-200"
            : toast.type === "success"
            ? "bg-emerald-950/95 border-emerald-500/40 text-emerald-200"
            : "bg-zinc-900/95 border-purple-500/40 text-gray-200"
        }`}
      >
        {toast.type === "error" ? (
          <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
        ) : toast.type === "success" ? (
          <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
        ) : (
          <Folder className="w-5 h-5 text-purple-400 shrink-0 mt-0.5" />
        )}
        <div className="flex-1 min-w-0">
          <p
            className={`text-xs font-semibold uppercase tracking-wider ${
              toast.type === "error"
                ? "text-red-300"
                : toast.type === "success"
                ? "text-emerald-300"
                : "text-purple-300"
            }`}
          >
            {toast.title ||
              (toast.type === "error"
                ? "Error"
                : toast.type === "success"
                ? "Success"
                : "File Manager")}
          </p>
          <p className="text-sm mt-0.5 break-words font-mono">{toast.text}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-gray-400 hover:text-white p-1 rounded hover:bg-white/10 cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
