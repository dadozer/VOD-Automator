import React from "react";
import { RefreshCw } from "lucide-react";

export interface RenderDialogFileItem {
  filename: string;
  width: number | string;
  height: number | string;
  enabled?: boolean;
  gameName?: string;
  matchedProfile?: string;
  isCustomProfile?: boolean;
}

export interface RenderDialogState {
  taskId: string;
  channelLogin: string;
  folderPath: string;
  width: number | string;
  height: number | string;
  files?: RenderDialogFileItem[];
}

interface TaskRenderModalProps {
  renderDialog: RenderDialogState | null;
  defaultWidth: number;
  defaultHeight: number;
  isSubmitting: boolean;
  onChange: (next: RenderDialogState) => void;
  onClose: () => void;
  onSubmit: () => void;
}

export const TaskRenderModal: React.FC<TaskRenderModalProps> = ({
  renderDialog,
  defaultWidth,
  defaultHeight,
  isSubmitting,
  onChange,
  onClose,
  onSubmit,
}) => {
  if (!renderDialog) return null;

  const noFilesSelected = Boolean(
    renderDialog.files &&
      renderDialog.files.length > 0 &&
      renderDialog.files.filter((f) => f.enabled !== false).length === 0
  );

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-[#141416] border border-white/10 p-6 rounded-xl max-w-md w-full space-y-4 max-h-[85vh] overflow-y-auto shadow-2xl">
        <div>
          <h3 className="text-lg font-bold text-white tracking-tight">
            Render Chat Video
          </h3>
          <p className="text-sm text-gray-400 mt-0.5">
            Configure dimensions for {renderDialog.channelLogin}
          </p>
        </div>

        {!renderDialog.files || renderDialog.files.length === 0 ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Width
              </label>
              <input
                type="number"
                value={renderDialog.width ?? ""}
                onChange={(e) =>
                  onChange({ ...renderDialog, width: e.target.value })
                }
                onBlur={(e) =>
                  onChange({
                    ...renderDialog,
                    width: parseInt(e.target.value, 10) || defaultWidth,
                  })
                }
                className="w-full bg-[#1c1c1f] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Height
              </label>
              <input
                type="number"
                value={renderDialog.height ?? ""}
                onChange={(e) =>
                  onChange({ ...renderDialog, height: e.target.value })
                }
                onBlur={(e) =>
                  onChange({
                    ...renderDialog,
                    height: parseInt(e.target.value, 10) || defaultHeight,
                  })
                }
                className="w-full bg-[#1c1c1f] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {renderDialog.files.map((file, idx) => (
              <div
                key={idx}
                className={`bg-[#1c1c1f] p-3.5 rounded-lg border ${
                  file.enabled === false
                    ? "border-red-500/30 opacity-50"
                    : "border-white/5"
                } space-y-3 transition-opacity`}
              >
                <div className="flex items-center justify-between gap-2.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <input
                      type="checkbox"
                      checked={file.enabled !== false}
                      onChange={(e) => {
                        const newFiles = [...renderDialog.files!];
                        newFiles[idx] = { ...newFiles[idx], enabled: e.target.checked };
                        onChange({ ...renderDialog, files: newFiles });
                      }}
                      className="w-4 h-4 rounded text-purple-500 bg-[#242428] border-white/10 shrink-0"
                    />
                    <p
                      className="text-sm font-medium text-white truncate"
                      title={file.filename}
                    >
                      {file.filename}
                    </p>
                  </div>
                  {file.isCustomProfile && (
                    <span
                      className="text-[11px] font-mono px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 shrink-0"
                      title={`Matched Per-Game Profile: ${
                        file.matchedProfile || file.gameName
                      }`}
                    >
                      {file.matchedProfile || file.gameName} Profile
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      Width
                    </label>
                    <input
                      type="number"
                      value={file.width ?? ""}
                      onChange={(e) => {
                        const newFiles = [...renderDialog.files!];
                        newFiles[idx] = { ...newFiles[idx], width: e.target.value };
                        onChange({ ...renderDialog, files: newFiles });
                      }}
                      onBlur={(e) => {
                        const newFiles = [...renderDialog.files!];
                        newFiles[idx] = {
                          ...newFiles[idx],
                          width: parseInt(e.target.value, 10) || defaultWidth,
                        };
                        onChange({ ...renderDialog, files: newFiles });
                      }}
                      className="w-full bg-[#242428] border border-white/10 rounded-lg px-3 py-2 text-sm font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      Height
                    </label>
                    <input
                      type="number"
                      value={file.height ?? ""}
                      onChange={(e) => {
                        const newFiles = [...renderDialog.files!];
                        newFiles[idx] = { ...newFiles[idx], height: e.target.value };
                        onChange({ ...renderDialog, files: newFiles });
                      }}
                      onBlur={(e) => {
                        const newFiles = [...renderDialog.files!];
                        newFiles[idx] = {
                          ...newFiles[idx],
                          height: parseInt(e.target.value, 10) || defaultHeight,
                        };
                        onChange({ ...renderDialog, files: newFiles });
                      }}
                      className="w-full bg-[#242428] border border-white/10 rounded-lg px-3 py-2 text-sm font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-3.5 border-t border-white/10">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm font-semibold text-gray-400 hover:text-white rounded-lg transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={isSubmitting || noFilesSelected}
            className={`flex items-center gap-2 px-4.5 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-semibold uppercase tracking-wider transition-colors shadow-md shadow-purple-900/30 cursor-pointer ${
              isSubmitting || noFilesSelected ? "opacity-50 cursor-not-allowed" : ""
            }`}
          >
            {isSubmitting && <RefreshCw className="w-4 h-4 animate-spin" />}
            {isSubmitting ? "Starting..." : "Start Render"}
          </button>
        </div>
      </div>
    </div>
  );
};
