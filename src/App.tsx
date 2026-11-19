import React, { useCallback, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { RefreshCw } from "lucide-react";
import { vodApi } from "./api/client";
import { useTelemetryStream } from "./hooks/useTelemetryStream";
import { cleanChannel, resolveClientGameProfile } from "./utils/formatters";
import { Sidebar, type AppTab } from "./components/Sidebar";
import { LivestreamMonitorView } from "./components/LivestreamMonitorView";
import { SettingsView } from "./components/SettingsView";
import { SystemLogView } from "./components/SystemLogView";
import {
  TaskRenderModal,
  type RenderDialogState,
} from "./components/modals/TaskRenderModal";
import { ManualRenderModal } from "./components/modals/ManualRenderModal";
import {
  QuickGameProfileModal,
  type QuickGameProfileModalState,
} from "./components/modals/QuickGameProfileModal";
import { RecoverFolderModal } from "./components/modals/RecoverFolderModal";
import {
  SpliceModal,
  type ClipScopeType,
  type SpliceActionType,
} from "./components/modals/SpliceModal";
import {
  CancelRenderModal,
  RebootConfirmModal,
  StopRecordingModal,
  ToastBanner,
  UnsavedSettingsModal,
  type ToastMessageState,
} from "./components/modals/ConfirmModals";
import type {
  ActiveTask,
  CaptureMode,
  Config,
  RecentFolderItem,
} from "./types";

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [channelsInput, setChannelsInput] = useState<string>("");
  const [isConfigDirty, setIsConfigDirty] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<AppTab>("dashboard");
  const [pendingTabSwitch, setPendingTabSwitch] = useState<AppTab | null>(null);

  const [isSavingConfig, setIsSavingConfig] = useState<boolean>(false);
  const [saveStatusMessage, setSaveStatusMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [isResetting, setIsResetting] = useState<boolean>(false);

  const [togglingChannelMap, setTogglingChannelMap] = useState<Record<string, boolean>>({});
  const [forceStitchingChannels, setForceStitchingChannels] = useState<Record<string, boolean>>({});
  const [isManualSplicing, setIsManualSplicing] = useState<Record<string, boolean>>({});
  const [isOverridingBuffer, setIsOverridingBuffer] = useState<Record<string, boolean>>({});
  const [pendingTaskActions, setPendingTaskActions] = useState<Record<string, string>>({});
  const [isDismissingCompleted, setIsDismissingCompleted] = useState<boolean>(false);

  // Modal states
  const [renderDialog, setRenderDialog] = useState<RenderDialogState | null>(null);
  const [isSubmittingRender, setIsSubmittingRender] = useState<boolean>(false);

  const [manualRenderDialog, setManualRenderDialog] = useState<boolean>(false);
  const [manualRenderPath, setManualRenderPath] = useState<string>("");
  const [manualRenderWidth, setManualRenderWidth] = useState<number | string>(350);
  const [manualRenderHeight, setManualRenderHeight] = useState<number | string>(800);
  const [manualRenderMatchedProfile, setManualRenderMatchedProfile] = useState<string | null>(null);
  const [isStartingManualRender, setIsStartingManualRender] = useState<boolean>(false);
  const [manualRenderMsg, setManualRenderMsg] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const [quickGameProfileModal, setQuickGameProfileModal] =
    useState<QuickGameProfileModalState | null>(null);
  const [isSavingQuickGameProfile, setIsSavingQuickGameProfile] = useState<boolean>(false);

  const [recentFolders, setRecentFolders] = useState<RecentFolderItem[]>([]);
  const [isLoadingRecentFolders, setIsLoadingRecentFolders] = useState<boolean>(false);
  const [recoverFolderDialog, setRecoverFolderDialog] = useState<boolean>(false);
  const [recoverFolderPath, setRecoverFolderPath] = useState<string>("");
  const [isStartingRecovery, setIsStartingRecovery] = useState<boolean>(false);
  const [recoverFolderMsg, setRecoverFolderMsg] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const [stopConfirmChannel, setStopConfirmChannel] = useState<string | null>(null);
  const [showRebootConfirm, setShowRebootConfirm] = useState<boolean>(false);
  const [manualSpliceChannel, setManualSpliceChannel] = useState<string | null>(null);
  const [cancelRenderConfirmTask, setCancelRenderConfirmTask] = useState<ActiveTask | null>(null);

  const [toastMessage, setToastMessage] = useState<ToastMessageState | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const syncDraftFromServerConfig = useCallback((nextConfig: Config) => {
    setConfig(nextConfig);
    setChannelsInput(nextConfig.channels ? nextConfig.channels.join(", ") : "");
    setIsConfigDirty(false);
  }, []);

  const {
    status,
    setStatus,
    loading,
    sseConnected,
    refreshStatus,
    refreshConfig,
  } = useTelemetryStream({
    isConfigDirty,
    onServerConfigSynced: syncDraftFromServerConfig,
  });

  const showToast = useCallback(
    (
      text: string,
      type: "success" | "info" | "error" = "info",
      title?: string
    ) => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
      setToastMessage({ text, type, title });
      toastTimerRef.current = setTimeout(() => {
        setToastMessage(null);
        toastTimerRef.current = null;
      }, 4000);
    },
    []
  );

  const updateDraftConfig = (nextConfig: Config) => {
    setConfig(nextConfig);
    setIsConfigDirty(true);
  };

  const handleTabSelect = (targetTab: AppTab) => {
    if (activeTab === "settings" && isConfigDirty && targetTab !== "settings") {
      setPendingTabSwitch(targetTab);
      return;
    }
    setActiveTab(targetTab);
  };

  const saveConfigInternal = async (): Promise<boolean> => {
    if (!config || isSavingConfig) return false;
    setIsSavingConfig(true);
    setSaveStatusMessage(null);
    try {
      const parsedChannels = channelsInput
        .split(",")
        .map(cleanChannel)
        .filter(Boolean)
        .slice(0, 2);

      const updatedConfig = await vodApi.saveConfig({
        ...config,
        channels: parsedChannels,
      });
      syncDraftFromServerConfig(updatedConfig);
      setSaveStatusMessage({
        type: "success",
        text: "Settings saved successfully!",
      });
      await refreshStatus();
      setTimeout(() => setSaveStatusMessage(null), 3000);
      return true;
    } catch {
      setSaveStatusMessage({
        type: "error",
        text: "Failed to save settings.",
      });
      return false;
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    await saveConfigInternal();
  };

  const handleOpenFolder = async (folderPath?: string) => {
    try {
      const res = await vodApi.openFolder(folderPath);
      const targetFolder = res?.folderPath || folderPath || "Downloads";
      if (navigator.clipboard && targetFolder) {
        navigator.clipboard.writeText(targetFolder).catch(() => {});
      }
      showToast(
        `Opening folder: ${targetFolder} (path copied to clipboard)`,
        "info",
        "File Manager"
      );
    } catch (err: any) {
      showToast(
        `Could not open folder: ${err?.message || "unknown error"}`,
        "error",
        "File Manager"
      );
    }
  };

  const handleAssignOrRenameChannel = async (slotIndex: number, rawName: string) => {
    const trimmed = cleanChannel(rawName);
    if (!trimmed || !config) return;

    const currentList = (config.channels || []).map(cleanChannel).filter(Boolean);
    const slots: (string | null)[] = [currentList[0] || null, currentList[1] || null];
    slots[slotIndex] = trimmed;
    const filtered = Array.from(
      new Set(slots.filter((c): c is string => Boolean(c)))
    ).slice(0, 2);

    const nextConfig = { ...config, channels: filtered };
    setConfig(nextConfig);
    setChannelsInput(filtered.join(", "));

    try {
      const saved = await vodApi.saveConfig(nextConfig);
      setConfig(saved);
      setChannelsInput((saved.channels || []).join(", "));
      await refreshStatus();
    } catch (err) {
      console.error("Failed to persist updated channels", err);
    }
  };

  const handleClearChannelSlot = async (slotIndex: number) => {
    if (!config) return;
    const currentList = (config.channels || []).map(cleanChannel).filter(Boolean);
    const slots: (string | null)[] = [currentList[0] || null, currentList[1] || null];
    const removedChannel = slots[slotIndex];
    slots[slotIndex] = null;
    const filtered = slots.filter((c): c is string => Boolean(c));

    const nextConfig = { ...config, channels: filtered };
    setConfig(nextConfig);
    setChannelsInput(filtered.join(", "));

    try {
      const saved = await vodApi.saveConfig(nextConfig);
      setConfig(saved);
      setChannelsInput((saved.channels || []).join(", "));
      if (removedChannel) {
        showToast(
          `Removed @${removedChannel} from monitored slots.`,
          "info",
          "Channel Removed"
        );
      }
      await refreshStatus();
    } catch (err) {
      console.error("Failed to clear channel slot", err);
    }
  };

  const executeToggleChannelMonitoring = async (channel: string) => {
    if (!config || !status || togglingChannelMap[channel]) return;
    const cleaned = cleanChannel(channel);
    if (!cleaned) return;

    const monitoredList = (status.monitoredChannels || []).map(cleanChannel);
    const activeSession = status.activeSessions?.find(
      (s) => cleanChannel(s.channel) === cleaned
    );
    const isLive = Boolean(activeSession);
    const isRunning = monitoredList.includes(cleaned) || isLive;

    setTogglingChannelMap((prev) => ({
      ...prev,
      [channel]: true,
      [cleaned]: true,
    }));

    try {
      if (isRunning) {
        await vodApi.stopMonitoring({ channel: cleaned });
      } else {
        await vodApi.startMonitoring({
          channel: cleaned,
          channels: config.channels,
        });
      }
      await refreshStatus();
    } catch (err: any) {
      showToast(err?.message || "Action failed", "error", "Stream Monitor");
      await refreshStatus();
    } finally {
      setTogglingChannelMap((prev) => {
        const copy = { ...prev };
        delete copy[channel];
        delete copy[cleaned];
        return copy;
      });
    }
  };

  const toggleChannelMonitoring = (channel: string) => {
    if (!config || !status || togglingChannelMap[channel]) return;
    const cleaned = cleanChannel(channel);
    if (!cleaned) return;

    const monitoredList = (status.monitoredChannels || []).map(cleanChannel);
    const activeSession = status.activeSessions?.find(
      (s) => cleanChannel(s.channel) === cleaned
    );
    const isLive = Boolean(activeSession);
    const isRunning = monitoredList.includes(cleaned) || isLive;

    if (isRunning && isLive) {
      setStopConfirmChannel(channel);
      return;
    }

    executeToggleChannelMonitoring(channel);
  };

  const forceStitch = async (channel: string) => {
    if (forceStitchingChannels[channel]) return;
    setForceStitchingChannels((prev) => ({ ...prev, [channel]: true }));
    try {
      await vodApi.forceStitch(channel);
      await refreshStatus();
    } catch (err) {
      console.error("Failed to force stitch:", err);
      await refreshStatus();
    } finally {
      setForceStitchingChannels((prev) => {
        const copy = { ...prev };
        delete copy[channel];
        return copy;
      });
    }
  };

  const toggleAutoRender = async (channel: string, currentVal: boolean) => {
    const cleaned = cleanChannel(channel);
    const newVal = !currentVal;

    setStatus((prev) =>
      prev
        ? {
            ...prev,
            activeSessions: prev.activeSessions.map((s) =>
              cleanChannel(s.channel) === cleaned
                ? { ...s, autoRenderChat: newVal }
                : s
            ),
          }
        : null
    );
    setConfig((prev) =>
      prev
        ? {
            ...prev,
            channelAutoRender: {
              ...(prev.channelAutoRender || {}),
              [cleaned]: newVal,
            },
          }
        : null
    );

    try {
      const res = await vodApi.toggleSessionAutoRender(cleaned, newVal);
      if (res.config && !isConfigDirty) {
        setConfig(res.config);
      }
      await refreshStatus();
    } catch (err) {
      console.error("Failed to toggle auto-render", err);
      await refreshStatus();
    }
  };

  const setChannelCaptureMode = async (
    channel: string,
    captureMode: CaptureMode
  ) => {
    const cleaned = cleanChannel(channel);
    if (!cleaned) return;

    setConfig((prev) =>
      prev
        ? {
            ...prev,
            channelCaptureModes: {
              ...(prev.channelCaptureModes || {}),
              [cleaned]: captureMode,
            },
          }
        : null
    );

    try {
      const res = await vodApi.setSessionCaptureMode(cleaned, captureMode);
      if (res.config && !isConfigDirty) {
        setConfig(res.config);
      }
      const modeLabel =
        captureMode === "video_only"
          ? "Video Only"
          : captureMode === "chat_only"
          ? "Chat Only"
          : "Video + Chat";
      showToast(
        `Capture mode for @${cleaned} set to ${modeLabel}.`,
        "info",
        "Capture Mode"
      );
      await refreshStatus();
    } catch (err: any) {
      showToast(
        err?.message || "Failed to update capture mode",
        "error",
        "Capture Mode"
      );
      await refreshConfig();
      await refreshStatus();
    }
  };

  const executeManualSplice = async (
    channel: string,
    action: SpliceActionType = "split_new_part",
    scope?: ClipScopeType,
    mins?: number,
    leadingBufferMinutes?: number
  ) => {
    setIsManualSplicing((prev) => ({ ...prev, [channel]: true }));
    try {
      const res = await vodApi.spliceGame({
        channel,
        action,
        clipScope: scope,
        clipMinutes: mins,
        leadingBufferMinutes,
      });
      if (res?.success) {
        showToast(
          action === "await_next_game"
            ? `Outgoing game ended for @${channel}. Recording into next game while awaiting Twitch category update.`
            : `Manual splice initiated for @${channel}.`,
          "success",
          "Video Splice"
        );
        await refreshStatus();
      }
    } catch (err: any) {
      showToast(
        err?.message || "Failed to trigger manual splice",
        "error",
        "Video Splice"
      );
    } finally {
      setIsManualSplicing((prev) => {
        const copy = { ...prev };
        delete copy[channel];
        return copy;
      });
    }
  };

  const handleOverrideBuffer = async (channel: string, gameIndex?: number) => {
    setIsOverridingBuffer((prev) => ({ ...prev, [channel]: true }));
    try {
      const res = await vodApi.overrideBuffer(channel, gameIndex);
      if (res?.success) {
        showToast(
          `Skipped transition buffer for @${channel}. Splicing now...`,
          "success",
          "Game Switch"
        );
        await refreshStatus();
      }
    } catch (err: any) {
      showToast(
        err?.message || "Failed to override buffer",
        "error",
        "Game Switch"
      );
    } finally {
      setIsOverridingBuffer((prev) => {
        const copy = { ...prev };
        delete copy[channel];
        return copy;
      });
    }
  };

  const handleTaskAction = async (taskId: string, action: string) => {
    if (pendingTaskActions[taskId]) return;

    if (action === "open_folder") {
      const task = status?.activeTasks.find((t) => t.id === taskId);
      handleOpenFolder(task?.folderPath);
      return;
    }

    if (action === "render_chat") {
      const task = status?.activeTasks.find((t) => t.id === taskId);
      if (task && task.folderPath) {
        const channelLogin = task.channelLogin || "stream";
        const defaultW = config?.chatRender?.width || 350;
        const defaultH = config?.chatRender?.height || 800;
        vodApi
          .getTaskChatFiles(taskId)
          .then((res) => {
            const fetchedFiles = res.files || [];
            const fileDetails = res.fileDetails || [];
            const mappedFiles =
              fileDetails.length > 0
                ? fileDetails.map((d) => ({
                    filename: d.filename,
                    width: d.width || defaultW,
                    height: d.height || defaultH,
                    enabled: true,
                    gameName: d.gameName,
                    matchedProfile: d.matchedProfile,
                    isCustomProfile: Boolean(d.isCustomProfile),
                  }))
                : fetchedFiles.map((f) => ({
                    filename: f,
                    width: defaultW,
                    height: defaultH,
                    enabled: true,
                  }));
            setRenderDialog({
              taskId,
              channelLogin,
              folderPath: task.folderPath!,
              width: mappedFiles[0]?.width || defaultW,
              height: mappedFiles[0]?.height || defaultH,
              files: mappedFiles,
            });
          })
          .catch(() => {
            setRenderDialog({
              taskId,
              channelLogin,
              folderPath: task.folderPath!,
              width: defaultW,
              height: defaultH,
            });
          });
      } else {
        showToast(
          "Task is missing its recording folder path.",
          "error",
          "Chat Render"
        );
      }
      return;
    }

    setPendingTaskActions((prev) => ({ ...prev, [taskId]: action }));

    if (action === "dismiss" || action === "no" || action === "close") {
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              activeTasks: prev.activeTasks.filter((t) => t.id !== taskId),
            }
          : null
      );
    }

    try {
      await vodApi.runTaskAction(taskId, { action });
      await refreshStatus();
    } catch (err: any) {
      showToast(
        err?.message || "Failed to execute task action",
        "error",
        "Task Queue"
      );
      await refreshStatus();
    } finally {
      setPendingTaskActions((prev) => {
        const copy = { ...prev };
        delete copy[taskId];
        return copy;
      });
    }
  };

  const handleDismissCompletedTasks = async () => {
    if (isDismissingCompleted) return;
    const completedTasks = (status?.activeTasks || []).filter(
      (t) =>
        t.status === "success" ||
        (!t.actionRequired && t.status !== "running") ||
        (t.actions &&
          t.actions.some((a) => a.value === "dismiss") &&
          t.status !== "running")
    );
    if (completedTasks.length === 0) return;

    setIsDismissingCompleted(true);
    setStatus((prev) =>
      prev
        ? {
            ...prev,
            activeTasks: prev.activeTasks.filter(
              (t) => !completedTasks.some((c) => c.id === t.id)
            ),
          }
        : null
    );

    try {
      await vodApi.dismissCompletedTasks();
      await refreshStatus();
    } catch {
      await refreshStatus();
    } finally {
      setIsDismissingCompleted(false);
    }
  };

  const submitRenderChat = async () => {
    if (!renderDialog || isSubmittingRender) return;
    if (
      renderDialog.files &&
      renderDialog.files.length > 0 &&
      renderDialog.files.filter((f) => f.enabled !== false).length === 0
    ) {
      showToast(
        "Please select at least one chat file to render.",
        "error",
        "Chat Render"
      );
      return;
    }
    setIsSubmittingRender(true);
    try {
      const activeSegments = renderDialog.files
        ? renderDialog.files
            .filter((f) => f.enabled !== false)
            .map((f) => ({
              filename: f.filename,
              width: parseInt(String(f.width), 10) || 350,
              height: parseInt(String(f.height), 10) || 800,
            }))
        : undefined;
      await vodApi.runTaskAction(renderDialog.taskId, {
        action: "render_chat",
        width: parseInt(String(renderDialog.width), 10) || 350,
        height: parseInt(String(renderDialog.height), 10) || 800,
        segments: activeSegments,
      });
      setRenderDialog(null);
      showToast(
        `Started chat render for @${renderDialog.channelLogin}.`,
        "success",
        "Chat Render"
      );
      await refreshStatus();
    } catch (err: any) {
      showToast(
        err?.message || "Failed to start chat render",
        "error",
        "Chat Render"
      );
    } finally {
      setIsSubmittingRender(false);
    }
  };

  const fetchRecentFolders = async () => {
    setIsLoadingRecentFolders(true);
    try {
      const res = await vodApi.getRecentFolders();
      if (res && Array.isArray(res.folders)) {
        setRecentFolders(res.folders);
      }
    } catch {
      // Ignore folder scan error
    } finally {
      setIsLoadingRecentFolders(false);
    }
  };

  const openQuickGameProfile = (gameName: string) => {
    const baseGameName =
      gameName.replace(/\s+Part\s+\d+$/i, "").trim() || gameName.trim();
    const resolved = resolveClientGameProfile(config, baseGameName);
    setQuickGameProfileModal({
      gameName: baseGameName,
      width: resolved.width,
      height: resolved.height,
      hasExistingProfile: resolved.isCustomProfile,
    });
  };

  const saveQuickGameProfile = async (remove = false) => {
    if (!quickGameProfileModal || isSavingQuickGameProfile) return;
    setIsSavingQuickGameProfile(true);
    try {
      const rawW =
        parseInt(String(quickGameProfileModal.width), 10) ||
        config?.chatRender?.width ||
        350;
      const rawH =
        parseInt(String(quickGameProfileModal.height), 10) ||
        config?.chatRender?.height ||
        800;
      const clampedW = Math.max(100, Math.min(7680, rawW));
      const clampedH = Math.max(100, Math.min(7680, rawH));
      const evenW = clampedW % 2 !== 0 ? clampedW + 1 : clampedW;
      const evenH = clampedH % 2 !== 0 ? clampedH + 1 : clampedH;

      const res = await vodApi.saveGameProfile({
        gameName: quickGameProfileModal.gameName,
        width: evenW,
        height: evenH,
        remove,
      });

      if (res && Array.isArray(res.gameProfiles)) {
        setConfig((prev) =>
          prev
            ? {
                ...prev,
                chatRender: {
                  ...prev.chatRender!,
                  gameProfiles: res.gameProfiles,
                },
              }
            : null
        );
      }

      if (remove) {
        showToast(
          `Reset "${quickGameProfileModal.gameName}" to default chat render dimensions.`,
          "info",
          "Game Profile"
        );
      } else {
        showToast(
          `Saved ${evenW}×${evenH} render profile for "${quickGameProfileModal.gameName}".`,
          "success",
          "Game Profile"
        );
      }
      setQuickGameProfileModal(null);
    } catch (err: any) {
      showToast(
        err?.message || "Failed to save game profile",
        "error",
        "Game Profile"
      );
    } finally {
      setIsSavingQuickGameProfile(false);
    }
  };

  const applyManualRenderProfileForPath = async (filePath: string) => {
    if (!filePath.trim()) {
      setManualRenderMatchedProfile(null);
      return;
    }
    try {
      const res = await vodApi.getChatFileProfile(filePath.trim());
      if (res && res.width && res.height) {
        setManualRenderWidth(res.width);
        setManualRenderHeight(res.height);
        setManualRenderMatchedProfile(
          res.isCustomProfile
            ? res.matchedProfile || res.gameName || "Custom Profile"
            : null
        );
      }
    } catch {
      setManualRenderMatchedProfile(null);
    }
  };

  const openManualRenderModal = () => {
    setManualRenderPath("");
    setManualRenderWidth(config?.chatRender?.width || 350);
    setManualRenderHeight(config?.chatRender?.height || 800);
    setManualRenderMatchedProfile(null);
    setManualRenderMsg(null);
    setManualRenderDialog(true);
    fetchRecentFolders();
  };

  const submitManualRender = async () => {
    if (!manualRenderPath.trim()) {
      setManualRenderMsg({
        type: "error",
        text: "Please enter or select a JSON file path.",
      });
      return;
    }
    setIsStartingManualRender(true);
    setManualRenderMsg(null);
    try {
      const res = await vodApi.startManualRender({
        filePath: manualRenderPath.trim(),
        width: parseInt(String(manualRenderWidth), 10) || 350,
        height: parseInt(String(manualRenderHeight), 10) || 800,
      });
      if (res?.success) {
        setManualRenderMsg({
          type: "success",
          text: res.message || "Render initiated!",
        });
        setTimeout(() => {
          setManualRenderDialog(false);
          setActiveTab("dashboard");
        }, 1200);
      } else {
        setManualRenderMsg({
          type: "error",
          text: res?.error || "Failed to start render",
        });
      }
      await refreshStatus();
    } catch (err: any) {
      setManualRenderMsg({
        type: "error",
        text: err?.message || "Error triggering manual render",
      });
    } finally {
      setIsStartingManualRender(false);
    }
  };

  const openRecoverFolderModal = () => {
    setRecoverFolderPath("");
    setRecoverFolderMsg(null);
    setRecoverFolderDialog(true);
    fetchRecentFolders();
  };

  const submitRecoverFolder = async () => {
    if (!recoverFolderPath.trim()) {
      setRecoverFolderMsg({
        type: "error",
        text: "Please select or enter a session folder path.",
      });
      return;
    }
    setIsStartingRecovery(true);
    setRecoverFolderMsg(null);
    try {
      const res = await vodApi.recoverFolderVideo(recoverFolderPath.trim());
      if (res?.success) {
        setRecoverFolderMsg({
          type: "success",
          text: `Recovery started for ${res.folderPath}`,
        });
        setTimeout(() => {
          setRecoverFolderDialog(false);
          setActiveTab("dashboard");
        }, 1000);
      } else {
        setRecoverFolderMsg({
          type: "error",
          text: res?.error || "Failed to start folder recovery",
        });
      }
      await refreshStatus();
    } catch (err: any) {
      setRecoverFolderMsg({
        type: "error",
        text: err?.message || "Failed to trigger folder video recovery",
      });
    } finally {
      setIsStartingRecovery(false);
    }
  };

  const executeReset = async () => {
    if (isResetting) return;
    setIsResetting(true);
    try {
      await vodApi.emergencyReset();
      showToast(
        "Program rebooted and all active background tasks cleared.",
        "success",
        "Emergency Reset"
      );
      await refreshStatus();
    } catch (err: any) {
      showToast(
        `Failed to reboot program: ${err?.message || "network error"}`,
        "error",
        "Emergency Reset"
      );
    } finally {
      setIsResetting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center">
        <RefreshCw className="animate-spin text-purple-500 w-8 h-8" />
      </div>
    );
  }

  const defaultRenderW = config?.chatRender?.width || 350;
  const defaultRenderH = config?.chatRender?.height || 800;
  const spliceActiveSession = manualSpliceChannel
    ? status?.activeSessions.find(
        (s) => cleanChannel(s.channel) === cleanChannel(manualSpliceChannel)
      )
    : undefined;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e0e0e0] font-sans selection:bg-purple-500/30">
      <Sidebar
        activeTab={activeTab}
        isConfigDirty={isConfigDirty}
        sseConnected={sseConnected}
        systemHealth={status?.systemHealth}
        onSelectTab={handleTabSelect}
      />

      <main className="ml-68 p-6 max-w-5xl mx-auto">
        <AnimatePresence>
          {activeTab === "dashboard" && (
            <LivestreamMonitorView
              config={config}
              status={status}
              togglingChannelMap={togglingChannelMap}
              forceStitchingChannels={forceStitchingChannels}
              isOverridingBuffer={isOverridingBuffer}
              isManualSplicing={isManualSplicing}
              pendingTaskActions={pendingTaskActions}
              isDismissingCompleted={isDismissingCompleted}
              onOpenRecoverFolderModal={openRecoverFolderModal}
              onOpenManualRenderModal={openManualRenderModal}
              onOpenFolder={handleOpenFolder}
              onAssignOrRenameChannel={handleAssignOrRenameChannel}
              onClearChannelSlot={handleClearChannelSlot}
              onToggleChannelMonitoring={toggleChannelMonitoring}
              onOpenQuickGameProfile={openQuickGameProfile}
              onForceStitch={forceStitch}
              onOverrideBuffer={handleOverrideBuffer}
              onToggleAutoRender={toggleAutoRender}
              onSetCaptureMode={setChannelCaptureMode}
              onOpenSpliceModal={(channel) => setManualSpliceChannel(channel)}
              onTaskAction={handleTaskAction}
              onConfirmCancelRender={(task) => setCancelRenderConfirmTask(task)}
              onDismissCompletedTasks={handleDismissCompletedTasks}
            />
          )}

          {activeTab === "settings" && (
            <SettingsView
              config={config}
              channelsInput={channelsInput}
              isConfigDirty={isConfigDirty}
              isSavingConfig={isSavingConfig}
              saveStatusMessage={saveStatusMessage}
              isResetting={isResetting}
              onChannelsInputChange={setChannelsInput}
              onUpdateDraftConfig={updateDraftConfig}
              onSaveConfig={handleSaveConfig}
              onDiscardChanges={() => refreshConfig()}
              onOpenFolder={handleOpenFolder}
              onOpenManualRenderModal={openManualRenderModal}
              onRequestReboot={() => setShowRebootConfirm(true)}
              onShowToast={showToast}
            />
          )}

          {activeTab === "logs" && (
            <SystemLogView logs={status?.logs || []} />
          )}
        </AnimatePresence>

        {/* Modals */}
        <TaskRenderModal
          renderDialog={renderDialog}
          defaultWidth={defaultRenderW}
          defaultHeight={defaultRenderH}
          isSubmitting={isSubmittingRender}
          onChange={setRenderDialog}
          onClose={() => setRenderDialog(null)}
          onSubmit={submitRenderChat}
        />

        <ManualRenderModal
          isOpen={manualRenderDialog}
          recentFolders={recentFolders}
          filePath={manualRenderPath}
          width={manualRenderWidth}
          height={manualRenderHeight}
          defaultWidth={defaultRenderW}
          defaultHeight={defaultRenderH}
          matchedProfile={manualRenderMatchedProfile}
          isStarting={isStartingManualRender}
          statusMsg={manualRenderMsg}
          onChangePath={(path) => {
            setManualRenderPath(path);
            setManualRenderMsg(null);
          }}
          onBlurOrSelectPath={applyManualRenderProfileForPath}
          onChangeWidth={setManualRenderWidth}
          onChangeHeight={setManualRenderHeight}
          onClose={() => setManualRenderDialog(false)}
          onSubmit={submitManualRender}
        />

        <QuickGameProfileModal
          modalState={quickGameProfileModal}
          isSaving={isSavingQuickGameProfile}
          onChange={setQuickGameProfileModal}
          onClose={() => setQuickGameProfileModal(null)}
          onSave={saveQuickGameProfile}
        />

        <RecoverFolderModal
          isOpen={recoverFolderDialog}
          recentFolders={recentFolders}
          isLoadingRecent={isLoadingRecentFolders}
          folderPath={recoverFolderPath}
          isStarting={isStartingRecovery}
          statusMsg={recoverFolderMsg}
          onChangePath={(path) => {
            setRecoverFolderPath(path);
            setRecoverFolderMsg(null);
          }}
          onClose={() => setRecoverFolderDialog(false)}
          onSubmit={submitRecoverFolder}
        />

        <SpliceModal
          channel={manualSpliceChannel}
          activeSession={spliceActiveSession}
          config={config}
          onClose={() => setManualSpliceChannel(null)}
          onExecute={(ch, act, sc, mins, leadMins) => {
            setManualSpliceChannel(null);
            executeManualSplice(ch, act, sc, mins, leadMins);
          }}
        />

        <UnsavedSettingsModal
          pendingTab={pendingTabSwitch}
          onStay={() => setPendingTabSwitch(null)}
          onDiscardAndLeave={(dest) => {
            setPendingTabSwitch(null);
            refreshConfig();
            setActiveTab(dest);
          }}
          onSaveAndLeave={async (dest) => {
            const saved = await saveConfigInternal();
            if (saved) {
              setPendingTabSwitch(null);
              setActiveTab(dest);
            }
          }}
        />

        <StopRecordingModal
          channel={stopConfirmChannel}
          activeSessions={status?.activeSessions || []}
          config={config}
          onCancel={() => setStopConfirmChannel(null)}
          onConfirmStop={(ch) => {
            setStopConfirmChannel(null);
            executeToggleChannelMonitoring(ch);
          }}
        />

        <RebootConfirmModal
          isOpen={showRebootConfirm}
          onCancel={() => setShowRebootConfirm(false)}
          onConfirm={() => {
            setShowRebootConfirm(false);
            executeReset();
          }}
        />

        <CancelRenderModal
          task={cancelRenderConfirmTask}
          onCancel={() => setCancelRenderConfirmTask(null)}
          onConfirmCancel={(taskId) => {
            setCancelRenderConfirmTask(null);
            handleTaskAction(taskId, "cancel_render");
          }}
        />

        <ToastBanner
          toast={toastMessage}
          onDismiss={() => setToastMessage(null)}
        />
      </main>
    </div>
  );
}
