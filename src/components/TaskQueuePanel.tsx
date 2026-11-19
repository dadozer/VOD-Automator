import React, { useEffect, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  Folder,
  Gamepad2,
  Layers,
  MessageSquare,
  Play,
  RefreshCw,
  Scissors,
  X,
} from "lucide-react";
import type { ActiveTask } from "../types";

interface TaskQueuePanelProps {
  activeTasks: ActiveTask[];
  pendingTaskActions: Record<string, string>;
  isDismissingCompleted: boolean;
  onTaskAction: (taskId: string, action: string) => void;
  onConfirmCancelRender: (task: ActiveTask) => void;
  onDismissCompleted: () => void;
}

export const TaskQueuePanel: React.FC<TaskQueuePanelProps> = ({
  activeTasks,
  pendingTaskActions,
  isDismissingCompleted,
  onTaskAction,
  onConfirmCancelRender,
  onDismissCompleted,
}) => {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const hasExpiringTasks = activeTasks.some(
    (t) => Boolean(t.expiresAt && t.expiresAt > nowMs)
  );

  useEffect(() => {
    if (!hasExpiringTasks) return;
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [hasExpiringTasks]);

  if (!activeTasks || activeTasks.length === 0) {
    return null;
  }

  const totalCount = activeTasks.length;
  const completedCount = activeTasks.filter(
    (t) =>
      t.status === "success" ||
      (!t.actionRequired && t.status !== "running") ||
      (t.actions &&
        t.actions.some((a) => a.value === "dismiss") &&
        t.status !== "running")
  ).length;
  const actionRequiredCount = activeTasks.filter(
    (t) =>
      t.actionRequired &&
      t.status !== "success" &&
      t.status !== "running" &&
      !t.id.startsWith("render_")
  ).length;

  return (
    <div className="bg-[#111113] border border-white/10 rounded-xl overflow-hidden shadow-md">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/5 bg-white/[0.02] flex items-center justify-between flex-wrap gap-2.5">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
            <Layers className="w-4 h-4 text-purple-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-white tracking-tight">
                Activity &amp; Task Queue
              </h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-gray-300 font-mono tabular-nums">
                {totalCount}
              </span>
              {actionRequiredCount > 0 && (
                <span className="text-xs px-2.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 font-medium tabular-nums">
                  {actionRequiredCount} action{actionRequiredCount > 1 ? "s" : ""} needed
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              Live background exports, segment stitching, and chat processing
            </p>
          </div>
        </div>

        {completedCount > 0 && (
          <button
            type="button"
            onClick={onDismissCompleted}
            disabled={isDismissingCompleted}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold bg-white/5 hover:bg-white/10 text-gray-300 border border-white/10 hover:border-white/20 transition-all cursor-pointer tabular-nums"
            title="Clear all completed tasks"
          >
            {isDismissingCompleted ? (
              <RefreshCw className="w-4 h-4 animate-spin text-purple-400" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            )}
            <span>Dismiss Completed ({completedCount})</span>
          </button>
        )}
      </div>

      {/* Task List */}
      <div className="divide-y divide-white/5">
        {activeTasks.map((task) => {
          const isPending = Boolean(pendingTaskActions[task.id]);
          const isSuccess = task.status === "success";
          const isError = task.status === "error";
          const isRunning = task.status === "running";
          const isActionReq = Boolean(
            task.actionRequired &&
              task.status !== "success" &&
              !isRunning &&
              !task.id.startsWith("render_")
          );

          const percentMatch = task.progressText?.match(/(\d+(?:\.\d+)?)%/);
          const percentVal = percentMatch
            ? Math.min(100, Math.max(0, parseFloat(percentMatch[1])))
            : null;

          return (
            <div
              key={task.id}
              className={`px-4 py-3.5 transition-colors ${
                isActionReq
                  ? "bg-amber-500/[0.03] hover:bg-amber-500/[0.06]"
                  : isSuccess
                  ? "bg-emerald-500/[0.02] hover:bg-emerald-500/[0.04]"
                  : isError
                  ? "bg-red-500/[0.02] hover:bg-red-500/[0.04]"
                  : "hover:bg-white/[0.02]"
              }`}
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                {/* Left details */}
                <div className="space-y-1.5 min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {isRunning && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-purple-500/10 border border-purple-500/20 text-purple-300 text-xs font-semibold uppercase tracking-wider">
                        <RefreshCw className="w-3.5 h-3.5 animate-spin text-purple-400" />
                        {task.name.toLowerCase().includes("stitch")
                          ? "Stitching"
                          : task.name.toLowerCase().includes("render")
                          ? "Rendering"
                          : task.name.toLowerCase().includes("backfill")
                          ? "Backfilling"
                          : "Processing"}
                      </span>
                    )}
                    {isActionReq && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs font-semibold uppercase tracking-wider">
                        <AlertCircle className="w-3.5 h-3.5" />
                        Action Required
                      </span>
                    )}
                    {isSuccess && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-semibold uppercase tracking-wider">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Completed
                      </span>
                    )}
                    {isError && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-red-500/15 border border-red-500/30 text-red-300 text-xs font-semibold uppercase tracking-wider">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        Error
                      </span>
                    )}

                    {task.channelLogin && (
                      <span className="text-sm font-mono font-medium text-gray-300 bg-white/5 px-2.5 py-0.5 rounded border border-white/5">
                        @{task.channelLogin}
                      </span>
                    )}

                    <h4 className="text-base font-bold text-white tracking-tight truncate">
                      {task.name}
                    </h4>
                  </div>

                  <p className="text-sm text-gray-400 font-mono tabular-nums flex flex-wrap items-center gap-2">
                    <span>{task.progressText}</span>
                    {task.expiresAt && task.expiresAt > nowMs && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono tabular-nums font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 animate-pulse">
                        <Clock className="w-3 h-3" />
                        Auto-selecting in {Math.max(1, Math.round((task.expiresAt - nowMs) / 1000))}s
                      </span>
                    )}
                  </p>

                  {isRunning && percentVal !== null && (
                    <div className="pt-1 max-w-md">
                      <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-purple-500 to-purple-400 rounded-full transition-all duration-300"
                          style={{ width: `${percentVal}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Action Buttons */}
                {task.actions && task.actions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 self-start md:self-center shrink-0">
                    {task.actions.map((action) => {
                      const isActionPending = pendingTaskActions[task.id] === action.value;
                      const isPrimary =
                        action.value === "render_chat" ||
                        action.value === "yes" ||
                        action.value === "retry_stitch" ||
                        action.value === "backfill_full" ||
                        action.value === "resume_vod_backfill";
                      const isHighlight =
                        action.value === "backfill_current_game" ||
                        action.value === "resume_stitch_gap";
                      const isCancel =
                        action.value === "cancel_render" || action.value === "cancel";
                      const isDismiss =
                        action.value === "dismiss" ||
                        action.value === "close" ||
                        action.value === "no" ||
                        action.value === "backfill_none";
                      const isOpenFolder = action.value === "open_folder";

                      return (
                        <button
                          key={action.value}
                          type="button"
                          disabled={isPending}
                          onClick={() => {
                            if (
                              action.value === "cancel_render" ||
                              (action.value === "cancel" && task.id.startsWith("render_"))
                            ) {
                              onConfirmCancelRender(task);
                            } else {
                              onTaskAction(task.id, action.value);
                            }
                          }}
                          className={`flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg transition-all border cursor-pointer ${
                            isPrimary
                              ? "bg-purple-600 hover:bg-purple-500 text-white border-purple-500/40 shadow-md shadow-purple-900/20"
                              : isHighlight
                              ? "bg-purple-500/20 hover:bg-purple-500/30 text-purple-200 border-purple-500/40"
                              : isCancel
                              ? "bg-red-500/10 hover:bg-red-500/20 text-red-300 hover:text-red-200 border-red-500/30"
                              : isDismiss
                              ? "bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white border-white/10"
                              : "bg-white/5 hover:bg-white/10 text-gray-300 border-white/10"
                          } ${isPending ? "opacity-60 cursor-not-allowed" : ""}`}
                        >
                          {isActionPending ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                          ) : action.value === "backfill_full" ||
                            action.value === "resume_vod_backfill" ? (
                            <Download className="w-4 h-4" />
                          ) : action.value === "backfill_current_game" ? (
                            <Gamepad2 className="w-4 h-4" />
                          ) : action.value === "resume_stitch_gap" ? (
                            <Scissors className="w-4 h-4" />
                          ) : isPrimary && action.value === "render_chat" ? (
                            <MessageSquare className="w-4 h-4" />
                          ) : isPrimary && action.value === "yes" ? (
                            <Play className="w-4 h-4 fill-current" />
                          ) : isPrimary && action.value === "retry_stitch" ? (
                            <RefreshCw className="w-4 h-4" />
                          ) : isOpenFolder ? (
                            <Folder className="w-4 h-4" />
                          ) : isCancel || isDismiss ? (
                            <X className="w-4 h-4" />
                          ) : null}
                          <span>{action.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {(!task.actions || task.actions.length === 0) && !isRunning && (
                  <button
                    type="button"
                    onClick={() => onTaskAction(task.id, "dismiss")}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white border border-white/10 self-start md:self-center shrink-0 transition-all cursor-pointer"
                    title="Dismiss task"
                  >
                    <X className="w-4 h-4" />
                    <span>Dismiss</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
