import React from "react";
import { Gamepad2, RefreshCw, X } from "lucide-react";

export interface QuickGameProfileModalState {
  gameName: string;
  width: number | string;
  height: number | string;
  hasExistingProfile: boolean;
}

interface QuickGameProfileModalProps {
  modalState: QuickGameProfileModalState | null;
  isSaving: boolean;
  onChange: (next: QuickGameProfileModalState) => void;
  onClose: () => void;
  onSave: (remove: boolean) => void;
}

export const QuickGameProfileModal: React.FC<QuickGameProfileModalProps> = ({
  modalState,
  isSaving,
  onChange,
  onClose,
  onSave,
}) => {
  if (!modalState) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#141416] border border-white/15 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-5">
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <Gamepad2 className="w-5 h-5 text-purple-400 shrink-0" />
            <div className="min-w-0">
              <h3 className="text-base font-bold text-white tracking-tight truncate">
                Game Render Resolution
              </h3>
              <p className="text-xs text-purple-300 font-medium truncate">
                {modalState.gameName}
              </p>
            </div>
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
            Set a dedicated chat render resolution (`Width × Height`) for{" "}
            <strong className="text-white">{modalState.gameName}</strong>. Used automatically when Auto-Render or Manual Render processes segments for this game.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Width (px)
              </label>
              <input
                type="number"
                min="100"
                max="7680"
                step="2"
                value={modalState.width}
                onChange={(e) =>
                  onChange({ ...modalState, width: e.target.value })
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
                min="100"
                max="7680"
                step="2"
                value={modalState.height}
                onChange={(e) =>
                  onChange({ ...modalState, height: e.target.value })
                }
                className="w-full bg-[#1c1c1f] border border-white/10 rounded-lg px-3 py-2 text-sm font-mono tabular-nums focus:outline-none focus:border-purple-500/50 transition-colors text-white"
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 pt-3 border-t border-white/10">
          {modalState.hasExistingProfile ? (
            <button
              type="button"
              disabled={isSaving}
              onClick={() => onSave(true)}
              className="px-3 py-2 text-xs font-semibold text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer"
            >
              Reset to Default
            </button>
          ) : (
            <div />
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isSaving}
              onClick={onClose}
              className="px-3.5 py-2 text-xs font-semibold text-gray-400 hover:text-white rounded-lg transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isSaving}
              onClick={() => onSave(false)}
              className="flex items-center gap-1.5 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs font-semibold uppercase tracking-wider transition-colors shadow-md shadow-purple-900/30 cursor-pointer"
            >
              {isSaving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              <span>Save Profile</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
