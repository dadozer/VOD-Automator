import React, { useState, useEffect, useRef, useMemo } from "react";
import axios from "axios";
import { Settings, Play, Square, Activity, Terminal, Folder, Bell, RefreshCw, Clock, Key, Download, AlertTriangle, HardDrive, Cpu, Gamepad2, Users, Check, ArrowDown, Layers, MessageSquare, Trash2, X, CheckCircle2, AlertCircle, Film, Sparkles, Edit2, Plus, Tv, Scissors } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import type { Config, Status } from "./types";

function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatUptime(seconds: number) {
  const d = Math.floor(seconds / (3600*24));
  const h = Math.floor(seconds % (3600*24) / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(seconds % 60)}s`;
}

function cleanChannel(channel: string): string {
  if (!channel) return "";
  let cleaned = channel.toLowerCase().trim().replace(/^@/, "");
  try {
    const urlString = cleaned.startsWith("http") ? cleaned : `https://${cleaned}`;
    const url = new URL(urlString);
    if (url.hostname.includes("twitch.tv")) {
      cleaned = url.pathname.split("/").filter(Boolean)[0] || cleaned;
    }
  } catch (e) {}
  cleaned = cleaned.replace(/^(https?:\/\/)?(www\.)?twitch\.tv\//, "").split("?")[0].replace(/\/$/, "");
  return cleaned.trim();
}

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"dashboard" | "settings" | "logs">("dashboard");
  const [settingsTab, setSettingsTab] = useState<"general" | "render">("general");
  const [channelsInput, setChannelsInput] = useState<string>("");
  const [timeSinceCheck, setTimeSinceCheck] = useState<number>(0);
  const [renderDialog, setRenderDialog] = useState<{ taskId: string, channelLogin: string, folderPath: string, width: number, height: number, files?: {filename: string, width: number, height: number, enabled?: boolean}[] } | null>(null);
  const [isTogglingMonitoring, setIsTogglingMonitoring] = useState(false);
  const [pendingTaskActions, setPendingTaskActions] = useState<Record<string, string>>({});
  const [forceStitchingChannels, setForceStitchingChannels] = useState<Record<string, boolean>>({});
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [saveStatusMessage, setSaveStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [isSubmittingRender, setIsSubmittingRender] = useState(false);
  const [manualRenderDialog, setManualRenderDialog] = useState<boolean>(false);
  const [manualRenderPath, setManualRenderPath] = useState<string>("");
  const [manualRenderWidth, setManualRenderWidth] = useState<number>(350);
  const [manualRenderHeight, setManualRenderHeight] = useState<number>(800);
  const [isStartingManualRender, setIsStartingManualRender] = useState<boolean>(false);
  const [manualRenderMsg, setManualRenderMsg] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const [autoScrollLogs, setAutoScrollLogs] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const formatDuration = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h > 0 ? h + ':' : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const fetchConfig = async () => {
    try {
      const res = await fetch("/api/config");
      if (!res.ok) return;
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) return;
      const data = await res.json();
      if (data && typeof data === 'object') {
        setConfig(data);
        setChannelsInput(data.channels ? data.channels.join(', ') : "");
      }
    } catch (err) {
      console.warn("Failed to fetch configuration", err);
    }
  };

  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) return;
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) return;
      const data = await res.json();
      if (data && typeof data === 'object') {
        setStatus(data);
      }
    } catch (err) {
      console.warn("Failed to fetch status", err);
    }
  };

  useEffect(() => {
    const init = async () => {
      await fetchConfig();
      await fetchStatus();
      setLoading(false);
    };
    init();

    let interval: NodeJS.Timeout | null = setInterval(fetchStatus, 5000);

    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
      } else {
        fetchStatus();
        if (!interval) {
          interval = setInterval(fetchStatus, 5000);
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (interval) clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (status?.lastCheckTime) {
        setTimeSinceCheck(Math.floor((Date.now() - status.lastCheckTime) / 1000));
      } else {
        setTimeSinceCheck(0);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [status?.lastCheckTime]);

  useEffect(() => {
    // Only auto-scroll down if user is already at the bottom and autoScrollLogs is true
    if (autoScrollLogs && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [status?.logs, autoScrollLogs]);

  const handleLogScroll = () => {
    if (!logContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
    // If within 40px of bottom, consider user engaged in bottom view
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 40;
    setAutoScrollLogs(isAtBottom);
  };

  const scrollToBottomLogs = () => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      setAutoScrollLogs(true);
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!config || isSavingConfig) return;
    setIsSavingConfig(true);
    setSaveStatusMessage(null);
    try {
      const parsedChannels = channelsInput
        .split(',')
        .map(cleanChannel)
        .filter(Boolean)
        .slice(0, 2);

      const configToSave = {
        ...config,
        channels: parsedChannels
      };

      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(configToSave),
      });
      if (res.ok) {
        const updatedConfig = await res.json();
        setConfig(updatedConfig);
        setChannelsInput((updatedConfig.channels || []).join(', '));
        setSaveStatusMessage({ type: 'success', text: "Settings saved successfully!" });
        await fetchStatus();
        setTimeout(() => setSaveStatusMessage(null), 3000);
      } else {
        setSaveStatusMessage({ type: 'error', text: "Failed to save settings." });
      }
    } catch (err) {
      setSaveStatusMessage({ type: 'error', text: "Failed to save settings." });
    } finally {
      setIsSavingConfig(false);
    }
  };

  const executeReset = async () => {
    if (isResetting) return;
    setIsResetting(true);
    try {
      const res = await fetch("/api/reset", { method: "POST" });
      if (res.ok) {
        await fetchStatus();
      } else {
        alert("Failed to reboot program");
      }
    } catch (err) {
      alert("Failed to reboot program");
    } finally {
      setIsResetting(false);
    }
  };

  const [stopConfirmChannel, setStopConfirmChannel] = useState<string | null>(null);
  const [showRebootConfirm, setShowRebootConfirm] = useState<boolean>(false);
  const [manualSpliceChannel, setManualSpliceChannel] = useState<string | null>(null);
  const [spliceAction, setSpliceAction] = useState<'append_previous' | 'extract_clip' | 'split_new_part'>('split_new_part');
  const [clipScope, setClipScope] = useState<'whole_game' | 'custom_duration'>('custom_duration');
  const [clipMinutes, setClipMinutes] = useState<number>(5.0);
  const [isManualSplicing, setIsManualSplicing] = useState<Record<string, boolean>>({});
  const [isOverridingBuffer, setIsOverridingBuffer] = useState<Record<string, boolean>>({});
  const [editingChannelIndex, setEditingChannelIndex] = useState<number | null>(null);
  const [tempChannelName, setTempChannelName] = useState<string>("");
  const [togglingChannelMap, setTogglingChannelMap] = useState<Record<string, boolean>>({});
  const [cancelRenderConfirmTask, setCancelRenderConfirmTask] = useState<any>(null);
  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'info' | 'error' } | null>(null);

  const formatGraceCountdown = (sec?: number) => {
    if (sec === undefined || sec <= 0) return "0m 00s";
    const mins = Math.floor(sec / 60);
    const remainingSec = Math.floor(sec % 60);
    return `${mins}m ${String(remainingSec).padStart(2, '0')}s`;
  };

  const handleOpenFolder = async (folderPath?: string) => {
    try {
      const res = await axios.post('/api/open-folder', { folderPath });
      const targetFolder = res.data?.folderPath || folderPath || 'Downloads';
      
      if (navigator.clipboard && targetFolder) {
        navigator.clipboard.writeText(targetFolder).catch(() => {});
      }

      setToastMessage({
        text: `Opening folder: ${targetFolder} (path copied to clipboard)`,
        type: 'info'
      });
      setTimeout(() => setToastMessage(null), 4000);
    } catch (err: any) {
      console.error("Failed to open folder", err);
      setToastMessage({
        text: `Could not open folder: ${err.message}`,
        type: 'error'
      });
      setTimeout(() => setToastMessage(null), 4000);
    }
  };

  const executeManualSplice = async (
    channel: string,
    action: 'append_previous' | 'extract_clip' | 'split_new_part' = 'split_new_part',
    scope?: 'whole_game' | 'custom_duration',
    mins?: number
  ) => {
    setIsManualSplicing(prev => ({ ...prev, [channel]: true }));
    try {
      const res = await axios.post("/api/channels/splice-game", {
        channel,
        action,
        clipScope: scope,
        clipMinutes: mins
      });
      if (res.data?.success) {
        await fetchStatus();
      }
    } catch (err: any) {
      alert(err.response?.data?.error || err.message || "Failed to trigger manual splice");
    } finally {
      setIsManualSplicing(prev => {
        const copy = { ...prev };
        delete copy[channel];
        return copy;
      });
    }
  };

  const handleOverrideBuffer = async (channel: string, gameIndex?: number) => {
    setIsOverridingBuffer(prev => ({ ...prev, [channel]: true }));
    try {
      const res = await axios.post("/api/channels/override-buffer", { channel, gameIndex });
      if (res.data?.success) {
        await fetchStatus();
      }
    } catch (err: any) {
      alert(err.response?.data?.error || err.message || "Failed to override buffer");
    } finally {
      setIsOverridingBuffer(prev => {
        const copy = { ...prev };
        delete copy[channel];
        return copy;
      });
    }
  };

  const startEditingChannel = (index: number, currentName: string) => {
    setEditingChannelIndex(index);
    setTempChannelName(currentName);
  };

  const commitChannelName = async (index: number) => {
    const trimmed = cleanChannel(tempChannelName);
    if (trimmed && config) {
      const currentList = (config.channels || []).map(cleanChannel);
      const updated = [...currentList];
      while (updated.length <= index) {
        updated.push("");
      }
      updated[index] = trimmed;
      const filtered = updated.filter(Boolean).slice(0, 2);

      const newConfig = { ...config, channels: filtered };
      setConfig(newConfig);
      setChannelsInput(filtered.join(', '));
      setEditingChannelIndex(null);

      try {
        const res = await fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(newConfig),
        });
        if (res.ok) {
          const saved = await res.json();
          setConfig(saved);
          await fetchStatus();
        }
      } catch (err) {
        console.error("Failed to persist updated channels", err);
      }
    } else {
      setEditingChannelIndex(null);
    }
  };

  const executeToggleChannelMonitoring = async (channel: string) => {
    if (!config || !status || togglingChannelMap[channel]) return;

    const cleaned = cleanChannel(channel);
    const monitoredList = (status.monitoredChannels || []).map(cleanChannel);
    const activeSession = status.activeSessions?.find(
      s => cleanChannel(s.channel) === cleaned
    );
    const isLive = Boolean(activeSession);
    const isRunning = monitoredList.includes(cleaned) || isLive;

    setTogglingChannelMap(prev => ({ ...prev, [channel]: true, [cleaned]: true }));
    const endpoint = isRunning ? "/api/stop" : "/api/start";

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: cleaned, channels: config.channels })
      });

      if (res.ok) {
        await fetchStatus();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Action failed");
        await fetchStatus();
      }
    } catch (err: any) {
      alert("Action failed: " + (err?.message || "network error"));
      await fetchStatus();
    } finally {
      setTogglingChannelMap(prev => {
        const copy = { ...prev };
        delete copy[channel];
        delete copy[cleaned];
        return copy;
      });
    }
  };

  const toggleChannelMonitoring = async (channel: string) => {
    if (!config || !status || togglingChannelMap[channel]) return;

    const cleaned = cleanChannel(channel);
    const monitoredList = (status.monitoredChannels || []).map(cleanChannel);
    const activeSession = status.activeSessions?.find(
      s => cleanChannel(s.channel) === cleaned
    );
    const isLive = Boolean(activeSession);
    const isRunning = monitoredList.includes(cleaned) || isLive;

    // Only prompt confirmation if actively recording live
    if (isRunning && isLive) {
      setStopConfirmChannel(channel);
      return;
    }

    await executeToggleChannelMonitoring(channel);
  };

  const handleTaskAction = async (taskId: string, action: string) => {
    if (pendingTaskActions[taskId]) return;

    if (action === 'open_folder') {
      return;
    }

    if (action === 'render_chat') {
      const task = status?.activeTasks.find(t => t.id === taskId);
      if (task && (task as any).channelLogin && (task as any).folderPath) {
        axios.get(`/api/tasks/${taskId}/chat-files`).then(res => {
          const fetchedFiles = res.data.files || [];
          setRenderDialog({
            taskId,
            channelLogin: (task as any).channelLogin,
            folderPath: (task as any).folderPath,
            width: (config as any)?.chatRender?.width || 350,
            height: (config as any)?.chatRender?.height || 800,
            files: fetchedFiles.map((f: string) => ({
              filename: f,
              width: (config as any)?.chatRender?.width || 350,
              height: (config as any)?.chatRender?.height || 800,
              enabled: true
            }))
          });
        }).catch(err => {
          console.error("Failed to fetch chat files", err);
          setRenderDialog({
            taskId,
            channelLogin: (task as any).channelLogin,
            folderPath: (task as any).folderPath,
            width: (config as any)?.chatRender?.width || 350,
            height: (config as any)?.chatRender?.height || 800
          });
        });
      }
      return;
    }

    setPendingTaskActions(prev => ({ ...prev, [taskId]: action }));

    // Optimistically dismiss task card if user clicked dismiss, close, or no
    if (action === 'dismiss' || action === 'no' || action === 'close') {
      setStatus(prev => prev ? {
        ...prev,
        activeTasks: prev.activeTasks.filter(t => t.id !== taskId)
      } : null);
    }

    try {
      await axios.post(`/api/tasks/${taskId}/action`, { action });
      await fetchStatus();
    } catch (err) {
      console.error("Failed to send task action", err);
      await fetchStatus();
    } finally {
      setPendingTaskActions(prev => {
        const copy = { ...prev };
        delete copy[taskId];
        return copy;
      });
    }
  };

  const [isDismissingCompleted, setIsDismissingCompleted] = useState(false);

  const handleDismissCompletedTasks = async () => {
    if (isDismissingCompleted) return;
    const completedTasks = (status?.activeTasks || []).filter(t => 
      t.status === 'success' || (!t.actionRequired && t.status !== 'running') || (t.actions && t.actions.some(a => a.value === 'dismiss') && t.status !== 'running')
    );
    if (completedTasks.length === 0) return;

    setIsDismissingCompleted(true);
    // Optimistically remove from state
    setStatus(prev => prev ? {
      ...prev,
      activeTasks: prev.activeTasks.filter(t => !completedTasks.some(c => c.id === t.id))
    } : null);

    try {
      await axios.post('/api/tasks/dismiss-completed');
      await fetchStatus();
    } catch (err) {
      console.error("Failed to dismiss completed tasks", err);
      await fetchStatus();
    } finally {
      setIsDismissingCompleted(false);
    }
  };

  const forceStitch = async (channel: string) => {
    if (forceStitchingChannels[channel]) return;
    setForceStitchingChannels(prev => ({ ...prev, [channel]: true }));
    try {
      await axios.post("/api/force-stitch", { channel });
      await fetchStatus();
    } catch (err) {
      console.error("Failed to force stitch:", err);
      await fetchStatus();
    } finally {
      setForceStitchingChannels(prev => {
        const copy = { ...prev };
        delete copy[channel];
        return copy;
      });
    }
  };

  const toggleAutoRender = async (channel: string, currentVal: boolean) => {
    const cleaned = cleanChannel(channel);
    const newVal = !currentVal;
    
    // Optimistic toggle in status activeSessions
    setStatus(prev => prev ? {
      ...prev,
      activeSessions: prev.activeSessions.map(s => cleanChannel(s.channel) === cleaned ? { ...s, autoRenderChat: newVal } : s)
    } : null);

    // Optimistic toggle in config.channelAutoRender
    setConfig(prev => prev ? {
      ...prev,
      channelAutoRender: {
        ...(prev.channelAutoRender || {}),
        [cleaned]: newVal
      }
    } : null);

    try {
      const res = await axios.post(`/api/sessions/${cleaned}/auto-render`, { enabled: newVal });
      if (res.data && res.data.config) {
        setConfig(res.data.config);
      }
      await fetchStatus();
    } catch (err) {
      console.error("Failed to toggle auto-render", err);
      await fetchStatus();
    }
  };

  const submitRenderChat = async () => {
    if (!renderDialog || isSubmittingRender) return;
    setIsSubmittingRender(true);
    try {
      if (renderDialog.files && renderDialog.files.filter(f => f.enabled !== false).length === 0) {
        setRenderDialog(null);
        return;
      }
      const activeSegments = renderDialog.files ? renderDialog.files.filter(f => f.enabled !== false) : undefined;
      await axios.post(`/api/tasks/${renderDialog.taskId}/action`, { 
        action: 'render_chat', 
        width: renderDialog.width, 
        height: renderDialog.height,
        segments: activeSegments
      });
      setRenderDialog(null);
      await fetchStatus();
    } catch (err) {
      console.error("Failed to start chat render", err);
    } finally {
      setIsSubmittingRender(false);
    }
  };

  const openManualRenderModal = () => {
    setManualRenderPath("");
    setManualRenderWidth((config as any)?.chatRender?.width || 350);
    setManualRenderHeight((config as any)?.chatRender?.height || 800);
    setManualRenderMsg(null);
    setManualRenderDialog(true);
  };

  const submitManualRender = async () => {
    if (!manualRenderPath.trim()) {
      setManualRenderMsg({ type: 'error', text: 'Please enter or select a JSON file path.' });
      return;
    }
    setIsStartingManualRender(true);
    setManualRenderMsg(null);
    try {
      const res = await axios.post('/api/render/manual', {
        filePath: manualRenderPath.trim(),
        width: manualRenderWidth,
        height: manualRenderHeight
      });
      if (res.data && res.data.success) {
        setManualRenderMsg({ type: 'success', text: res.data.message || 'Render initiated!' });
        setTimeout(() => {
          setManualRenderDialog(false);
          setActiveTab("dashboard");
        }, 1200);
      } else {
        setManualRenderMsg({ type: 'error', text: res.data?.error || 'Failed to start render' });
      }
      await fetchStatus();
    } catch (err: any) {
      setManualRenderMsg({ type: 'error', text: err.response?.data?.error || err.message || 'Error triggering manual render' });
    } finally {
      setIsStartingManualRender(false);
    }
  };

  const monitoredChannelsList = (status?.monitoredChannels || []).map(cleanChannel);
  const channelsToDisplay = useMemo(() => {
    const configured = (config?.channels || []).map(cleanChannel).filter(Boolean);
    const result = [...configured];
    while (result.length < 2) {
      result.push(`channel${result.length + 1}`);
    }
    // Include active sessions if any are finishing up or orphaned
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

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center">
        <RefreshCw className="animate-spin text-purple-500 w-8 h-8" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e0e0e0] font-sans selection:bg-purple-500/30">
      <div className="fixed left-0 top-0 bottom-0 w-68 bg-[#111111] border-r border-white/5 flex flex-col">
        <div className="px-5 py-4 border-b border-white/5 relative">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-purple-600 rounded-lg flex items-center justify-center shadow-md shadow-purple-500/20">
              <Activity className="w-4.5 h-4.5 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-base tracking-tight text-white leading-tight">VOD Automator</h1>
              <p className="text-xs text-purple-400 font-mono font-medium">v4.8.5</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1.5 overflow-y-auto">
          <button onClick={() => setActiveTab("dashboard")} className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-semibold transition-all ${activeTab === "dashboard" ? "bg-purple-600/10 text-purple-400 border border-purple-500/20" : "text-gray-400 hover:bg-white/5 hover:text-white border border-transparent"}`}>
            <Tv className="w-4.5 h-4.5" />
            <span>Livestream Monitor</span>
          </button>
          <button onClick={() => setActiveTab("settings")} className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-semibold transition-all ${activeTab === "settings" ? "bg-purple-600/10 text-purple-400 border border-purple-500/20" : "text-gray-400 hover:bg-white/5 hover:text-white border border-transparent"}`}>
            <Settings className="w-4.5 h-4.5" />
            <span>Settings</span>
          </button>
          <button onClick={() => setActiveTab("logs")} className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-semibold transition-all ${activeTab === "logs" ? "bg-purple-600/10 text-purple-400 border border-purple-500/20" : "text-gray-400 hover:bg-white/5 hover:text-white border border-transparent"}`}>
            <Terminal className="w-4.5 h-4.5" />
            <span>System Log</span>
          </button>
        </nav>

        {/* System Health Relocated to Bottom Left Sidebar */}
        <div className="p-4 border-t border-white/5 bg-black/25 space-y-3 shrink-0">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
              <HardDrive className="w-4 h-4 text-purple-400" />
              System Health
            </span>
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              Online
            </span>
          </div>

          {status?.systemHealth ? (
            <div className="space-y-2.5 text-sm">
              {/* Storage */}
              <div className="bg-[#161618] border border-white/5 rounded-lg p-2.5">
                <div className="flex items-center justify-between text-gray-300 mb-1.5">
                  <span className="text-xs text-gray-400">Disk Free</span>
                  <span className="font-mono font-bold text-white text-xs">{formatBytes(status.systemHealth.diskFree)}</span>
                </div>
                {status.systemHealth.diskTotal > 0 && (
                  <div className="w-full bg-white/10 h-1.5 rounded-full overflow-hidden">
                    <div 
                      className={`h-full rounded-full ${
                        status.systemHealth.diskFree < 5 * 1024 * 1024 * 1024
                          ? 'bg-red-500'
                          : status.systemHealth.diskFree < 20 * 1024 * 1024 * 1024
                            ? 'bg-amber-500'
                            : 'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.max(0, 100 - (status.systemHealth.diskFree / status.systemHealth.diskTotal) * 100)}%` }}
                    />
                  </div>
                )}
              </div>

              {/* Memory & Uptime inline metrics */}
              <div className="grid grid-cols-2 gap-2 font-mono text-xs">
                <div className="bg-[#161618] border border-white/5 rounded-lg p-2">
                  <div className="text-[11px] text-gray-500 uppercase">Memory</div>
                  <div className="font-semibold text-gray-200 truncate mt-0.5">{formatBytes(status.systemHealth.memoryUsed)}</div>
                </div>
                <div className="bg-[#161618] border border-white/5 rounded-lg p-2">
                  <div className="text-[11px] text-gray-500 uppercase">Uptime</div>
                  <div className="font-semibold text-gray-200 truncate mt-0.5">{formatUptime(status.systemHealth.uptime)}</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-500 font-mono py-1">Telemetry loading...</div>
          )}
        </div>
      </div>

      <main className="ml-68 p-6 max-w-5xl mx-auto">
        <AnimatePresence>
          {activeTab === "dashboard" && (
            <motion.div key="dashboard" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-6">
              <div>
                <h2 className="text-3xl font-bold text-white tracking-tight">Livestream Monitor</h2>
                <p className="text-sm text-gray-400 mt-0.5">Livestream video and chat recording</p>
              </div>

              {/* ========================================================================= */}
              {/* PER-STREAM MONITOR CARDS (SINGLE-COLUMN STACK WITH IN-PLACE EDITING)       */}
              {/* ========================================================================= */}
              <div className="space-y-3.5">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
                      <Tv className="w-4.5 h-4.5 text-purple-400" />
                      Monitored Streams ({channelsToDisplay.length}/2)
                    </h3>
                    <p className="text-sm text-gray-400 mt-0.5">When monitoring is paused, click channel handle to change monitored stream</p>
                  </div>
                </div>

                {channelsToDisplay.map((channelName, idx) => {
                  const cleaned = cleanChannel(channelName);
                  const isChannelMonitored = monitoredChannelsList.includes(cleaned);
                  const activeSession = (status?.activeSessions || []).find(
                    s => cleanChannel(s.channel) === cleaned
                  );
                  const isLive = Boolean(activeSession);
                  const isRunning = isChannelMonitored || isLive;
                  const isToggling = Boolean(togglingChannelMap[channelName] || togglingChannelMap[cleaned]);

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
                      {/* Top Bar for Each Stream Card */}
                      <div className="px-4 py-3 bg-white/[0.02] border-b border-white/5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                            isLive 
                              ? "bg-red-500 animate-ping" 
                              : isRunning 
                              ? "bg-emerald-400 animate-pulse" 
                              : "bg-gray-600"
                          }`} />

                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              {/* In-place Editable Handle (only when monitoring is paused) */}
                              {!isRunning ? (
                                editingChannelIndex === idx ? (
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-purple-400 font-bold text-sm">@</span>
                                    <input
                                      type="text"
                                      autoFocus
                                      value={tempChannelName}
                                      onChange={e => setTempChannelName(e.target.value)}
                                      onBlur={() => commitChannelName(idx)}
                                      onKeyDown={e => {
                                        if (e.key === "Enter") commitChannelName(idx);
                                        if (e.key === "Escape") setEditingChannelIndex(null);
                                      }}
                                      className="bg-black/60 border border-purple-500/60 rounded px-2.5 py-1 text-sm font-bold text-white focus:outline-none w-36"
                                    />
                                    <button
                                      onClick={() => commitChannelName(idx)}
                                      className="p-1 hover:bg-white/10 rounded text-emerald-400 cursor-pointer"
                                      title="Save name"
                                    >
                                      <Check className="w-4 h-4" />
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={() => startEditingChannel(idx, channelName)}
                                    className="group flex items-center gap-1.5 px-2 py-0.5 rounded-lg hover:bg-white/5 border border-transparent hover:border-white/10 transition-colors cursor-pointer"
                                    title="Click to rename stream"
                                  >
                                    <h4 className="text-base font-bold text-white tracking-tight">
                                      @{channelName}
                                    </h4>
                                    <Edit2 className="w-3.5 h-3.5 text-gray-500 group-hover:text-purple-400 transition-colors" />
                                  </button>
                                )
                              ) : (
                                <h4 className="text-base font-bold text-white tracking-tight">
                                  @{channelName}
                                </h4>
                              )}

                              {/* Status Pill */}
                              {isLive ? (
                                <>
                                  <span className="text-xs px-2.5 py-0.5 rounded-full bg-red-500/10 text-red-400 font-bold border border-red-500/25 uppercase tracking-wider animate-pulse flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                                    Recording Live
                                  </span>
                                  {activeSession && (
                                    <span className="text-xs px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-gray-300 font-mono font-medium flex items-center gap-1.5">
                                      <Clock className="w-3 h-3 text-purple-400" />
                                      Started {new Date(activeSession.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
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

                              {/* If Live: Game & Viewer Count IN LINE */}
                              {isLive && activeSession && (
                                <div className="flex items-center gap-2 text-sm">
                                  {activeSession.currentGame && (
                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-purple-500/10 border border-purple-500/20 text-purple-300 font-medium">
                                      <Gamepad2 className="w-3.5 h-3.5 text-purple-400" />
                                      {activeSession.currentGame}
                                    </span>
                                  )}
                                  {activeSession.viewersCount !== undefined && activeSession.viewersCount > 0 && (
                                    <span className="inline-flex items-center gap-1.5 text-gray-300 bg-black/40 px-2.5 py-0.5 rounded-md border border-white/5 font-mono">
                                      <Users className="w-3.5 h-3.5 text-red-400" />
                                      {activeSession.viewersCount.toLocaleString()}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Stream Subtitle */}
                            <p className="text-xs text-gray-500 mt-0.5 font-mono">
                              {isLive 
                                ? "Source resolution" 
                                : isRunning 
                                ? `Last check: ${timeSinceCheck}s ago` 
                                : "Monitoring paused • Click handle above to edit"}
                            </p>
                          </div>
                        </div>

                        {/* Individual Channel Controls */}
                        <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                          <button
                            onClick={() => toggleChannelMonitoring(channelName)}
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

                      {/* Card Body: Live State vs Stream Offline State */}
                      {isLive && activeSession ? (
                        <div className="p-4 space-y-3.5">
                          {/* Compact metrics strip */}
                          <div className="grid grid-cols-3 gap-2.5">
                            <div className="bg-black/30 border border-white/5 rounded-lg px-3 py-2 flex items-center justify-between">
                              <span className="text-xs text-gray-400 uppercase tracking-wider font-semibold">Video Segments</span>
                              <span className="text-sm sm:text-base font-bold text-white font-mono">{activeSession.chunksDownloaded?.toLocaleString() || "0"}</span>
                            </div>
                            <div className="bg-black/30 border border-white/5 rounded-lg px-3 py-2 flex items-center justify-between">
                              <span className="text-xs text-gray-400 uppercase tracking-wider font-semibold">Duration</span>
                              <span className="text-sm sm:text-base font-bold text-white font-mono">{formatDuration(activeSession.videoDurationSeconds || 0)}</span>
                            </div>
                            <div className="bg-black/30 border border-white/5 rounded-lg px-3 py-2 flex items-center justify-between">
                              <span className="text-xs text-gray-400 uppercase tracking-wider font-semibold flex items-center gap-1.5">
                                <MessageSquare className="w-3.5 h-3.5 text-purple-400" />
                                Chat Messages
                              </span>
                              <span className="text-sm sm:text-base font-bold text-white font-mono">
                                {(activeSession.commentsWritten || 0).toLocaleString()}
                              </span>
                            </div>
                          </div>

                          {/* Offline warning if missing chunks */}
                          {activeSession.missingCount !== undefined && activeSession.missingCount > 0 && (
                            <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg flex flex-wrap items-center justify-between gap-3 text-sm">
                              <div className="flex items-center gap-2.5 text-amber-400">
                                <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
                                <div>
                                  <span className="font-bold text-white">Stream offline detected. </span>
                                  <span className="text-amber-200/90">
                                    Grace period: <span className="font-mono font-semibold text-amber-300">{formatGraceCountdown((activeSession as any).offlineGraceRemainingSeconds)}</span> remaining before automatic finalization.
                                  </span>
                                </div>
                              </div>
                              <button 
                                disabled={Boolean(forceStitchingChannels[activeSession.channel])}
                                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg border transition-all border-amber-500/40 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 hover:text-white cursor-pointer shadow-sm ${
                                  forceStitchingChannels[activeSession.channel] ? "opacity-75 cursor-wait" : ""
                                }`} 
                                onClick={() => forceStitch(activeSession.channel)}
                                title="Immediately conclude this broadcast and finalize recording now"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                <span>{forceStitchingChannels[activeSession.channel] ? "Finalizing..." : "Finalize Recording"}</span>
                              </button>
                            </div>
                          )}

                          {/* Interactive Game Switch Notification Banner with Buffer Override */}
                          {activeSession.pendingGameSwitch && (
                            <div className="p-3 bg-purple-500/10 border border-purple-500/30 rounded-lg flex flex-wrap items-center justify-between gap-3 text-sm">
                              <div className="flex items-center gap-2.5">
                                <div className="w-8 h-8 rounded-lg bg-purple-500/20 border border-purple-500/30 flex items-center justify-center shrink-0">
                                  <Scissors className="w-4 h-4 text-purple-400" />
                                </div>
                                <div>
                                  <div className="font-semibold text-white flex items-center gap-2">
                                    <span>Game Switch Detected:</span>
                                    <span className="text-gray-400 line-through text-xs sm:text-sm">{activeSession.pendingGameSwitch.previousGame}</span>
                                    <span className="text-purple-400">&rarr;</span>
                                    <span className="text-purple-300 font-bold text-xs sm:text-sm">{activeSession.pendingGameSwitch.currentGame}</span>
                                  </div>
                                  <p className="text-xs text-purple-300/80 mt-0.5">
                                    Buffering transition ({activeSession.pendingGameSwitch.secondsRemaining}s remaining before automatic splice)
                                  </p>
                                </div>
                              </div>
                              <button
                                type="button"
                                disabled={Boolean(isOverridingBuffer[activeSession.channel])}
                                onClick={() => handleOverrideBuffer(activeSession.channel, activeSession.pendingGameSwitch?.gameIndex)}
                                className={`flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs font-bold uppercase tracking-wider transition-all shadow-md shadow-purple-900/30 cursor-pointer ${
                                  isOverridingBuffer[activeSession.channel] ? "opacity-75 cursor-wait" : ""
                                }`}
                                title="Override buffer and immediately trigger game segment splice"
                              >
                                <Scissors className="w-3.5 h-3.5" />
                                <span>{isOverridingBuffer[activeSession.channel] ? "Splicing..." : "Splice Immediately"}</span>
                              </button>
                            </div>
                          )}

                          {/* Stream Options & Actions Footer */}
                          <div className="pt-2.5 flex flex-wrap items-center justify-between gap-3 text-sm border-t border-white/5">
                            <label className="flex items-center gap-2.5 cursor-pointer text-gray-400 hover:text-gray-300">
                              <input 
                                type="checkbox" 
                                checked={isLive && activeSession ? (activeSession.autoRenderChat || false) : (config?.channelAutoRender?.[cleaned] ?? config?.autoRenderChat ?? false)} 
                                onChange={() => toggleAutoRender(channelName, isLive && activeSession ? (activeSession.autoRenderChat || false) : (config?.channelAutoRender?.[cleaned] ?? config?.autoRenderChat ?? false))} 
                                className="w-4 h-4 rounded border-white/20 bg-black/40 text-purple-600 focus:ring-0" 
                              />
                              <span className="text-sm">Auto-render chat upon conclusion</span>
                            </label>

                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={Boolean(isManualSplicing[activeSession.channel])}
                                onClick={() => setManualSpliceChannel(activeSession.channel)}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white border border-white/10 hover:border-purple-500/40 transition-all cursor-pointer ${
                                  isManualSplicing[activeSession.channel] ? "opacity-75 cursor-wait" : ""
                                }`}
                                title="Manually cut the current game segment and begin a new segment"
                              >
                                <Scissors className="w-3.5 h-3.5 text-purple-400" />
                                <span>{isManualSplicing[activeSession.channel] ? "Cutting..." : "Splice Game Segment"}</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        /* Revised Idle Polling State */
                        <div className="px-4 py-3 bg-black/20 flex flex-wrap items-center justify-between gap-3 text-sm">
                          <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-gray-500 shrink-0" />
                            <span className="font-semibold text-gray-300">Stream Offline.</span>
                            <span className="text-gray-400">Recording will start when broadcast begins.</span>
                            {!isChannelMonitored && (
                              <span className="text-xs text-purple-400 font-mono ml-1">
                                (Click handle above to edit)
                              </span>
                            )}
                          </div>
                          <label className="flex items-center gap-2 cursor-pointer text-gray-400 hover:text-gray-300 shrink-0 ml-auto">
                            <input 
                              type="checkbox" 
                              checked={config?.channelAutoRender?.[cleaned] ?? config?.autoRenderChat ?? false} 
                              onChange={() => toggleAutoRender(channelName, config?.channelAutoRender?.[cleaned] ?? config?.autoRenderChat ?? false)} 
                              className="w-4 h-4 rounded border-white/20 bg-black/40 text-purple-600 focus:ring-0" 
                            />
                            <span className="text-xs sm:text-sm">Auto-render chat upon conclusion</span>
                          </label>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Unified Activity & Task Queue (Phase 2 - Concept 1) */}
              {status?.activeTasks && status.activeTasks.length > 0 && (() => {
                const totalCount = status.activeTasks.length;
                const completedCount = status.activeTasks.filter(t => 
                  t.status === 'success' || (!t.actionRequired && t.status !== 'running') || (t.actions && t.actions.some(a => a.value === 'dismiss') && t.status !== 'running')
                ).length;
                const actionRequiredCount = status.activeTasks.filter(t => t.actionRequired && t.status !== 'success' && t.status !== 'running' && !t.id.startsWith('render_')).length;

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
                            <h3 className="text-base font-bold text-white tracking-tight">Activity & Task Queue</h3>
                            <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-gray-300 font-mono">
                              {totalCount}
                            </span>
                            {actionRequiredCount > 0 && (
                              <span className="text-xs px-2.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 font-medium">
                                {actionRequiredCount} action{actionRequiredCount > 1 ? 's' : ''} needed
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5">Live background exports, segment stitching, and chat processing</p>
                        </div>
                      </div>

                      {completedCount > 0 && (
                        <button
                          onClick={handleDismissCompletedTasks}
                          disabled={isDismissingCompleted}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold bg-white/5 hover:bg-white/10 text-gray-300 border border-white/10 hover:border-white/20 transition-all cursor-pointer"
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
                      {status.activeTasks.map((task) => {
                        const isPending = Boolean(pendingTaskActions[task.id]);
                        const isSuccess = task.status === 'success';
                        const isError = task.status === 'error';
                        const isRunning = task.status === 'running';
                        const isActionReq = Boolean(task.actionRequired && task.status !== 'success' && !isRunning && !task.id.startsWith('render_'));

                        // Parse percentage if present in progress text
                        const percentMatch = task.progressText?.match(/(\d+)%/);
                        const percentVal = percentMatch ? parseInt(percentMatch[1], 10) : null;

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
                                  {/* Status Pill */}
                                  {isRunning && (
                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-purple-500/10 border border-purple-500/20 text-purple-300 text-xs font-semibold uppercase tracking-wider">
                                      <RefreshCw className="w-3.5 h-3.5 animate-spin text-purple-400" />
                                      {task.name.toLowerCase().includes('stitch') ? 'Stitching' : task.name.toLowerCase().includes('render') ? 'Rendering' : task.name.toLowerCase().includes('backfill') ? 'Backfilling' : 'Processing'}
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

                                  {/* Channel Badge */}
                                  {task.channelLogin && (
                                    <span className="text-sm font-mono font-medium text-gray-300 bg-white/5 px-2.5 py-0.5 rounded border border-white/5">
                                      @{task.channelLogin}
                                    </span>
                                  )}

                                  <h4 className="text-base font-bold text-white tracking-tight truncate">
                                    {task.name}
                                  </h4>
                                </div>

                                <p className="text-sm text-gray-400 font-mono flex flex-wrap items-center gap-2">
                                  <span>{task.progressText}</span>
                                  {task.expiresAt && task.expiresAt > Date.now() && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 animate-pulse">
                                      <Clock className="w-3 h-3" />
                                      Auto-selecting in {Math.max(1, Math.round((task.expiresAt - Date.now()) / 1000))}s
                                    </span>
                                  )}
                                </p>

                                {/* Progress bar for running tasks */}
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
                                  {task.actions.filter(a => a.value !== 'open_folder').map((action) => {
                                    const isActionPending = pendingTaskActions[task.id] === action.value;
                                    const isPrimary = action.value === 'render_chat' || action.value === 'yes' || action.value === 'retry_stitch' || action.value === 'backfill_full' || action.value === 'resume_vod_backfill';
                                    const isHighlight = action.value === 'backfill_current_game' || action.value === 'resume_stitch_gap';
                                    const isCancel = action.value === 'cancel_render' || action.value === 'cancel';
                                    const isDismiss = action.value === 'dismiss' || action.value === 'close' || action.value === 'no' || action.value === 'backfill_none';
                                    const isOpenFolder = action.value === 'open_folder';

                                    return (
                                      <button
                                        key={action.value}
                                        disabled={isPending}
                                        onClick={() => {
                                          if (action.value === 'cancel_render' || (action.value === 'cancel' && task.id.startsWith('render_'))) {
                                            setCancelRenderConfirmTask(task);
                                          } else {
                                            handleTaskAction(task.id, action.value);
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
                                        ) : action.value === 'backfill_full' || action.value === 'resume_vod_backfill' ? (
                                          <Download className="w-4 h-4" />
                                        ) : action.value === 'backfill_current_game' ? (
                                          <Gamepad2 className="w-4 h-4" />
                                        ) : action.value === 'resume_stitch_gap' ? (
                                          <Scissors className="w-4 h-4" />
                                        ) : isPrimary && action.value === 'render_chat' ? (
                                          <MessageSquare className="w-4 h-4" />
                                        ) : isPrimary && action.value === 'yes' ? (
                                          <Play className="w-4 h-4 fill-current" />
                                        ) : isPrimary && action.value === 'retry_stitch' ? (
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

                              {/* Passive dismiss for completed/error task with no explicit buttons */}
                              {(!task.actions || task.actions.length === 0) && !isRunning && (
                                <button
                                  onClick={() => handleTaskAction(task.id, 'dismiss')}
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
              })()}

              {renderDialog && (
                <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
                  <div className="bg-[#141416] border border-white/10 p-6 rounded-xl max-w-md w-full space-y-4 max-h-[85vh] overflow-y-auto shadow-2xl">
                    <div>
                      <h3 className="text-lg font-bold text-white tracking-tight">Render Chat Video</h3>
                      <p className="text-sm text-gray-400 mt-0.5">Configure dimensions for {renderDialog.channelLogin}</p>
                    </div>

                    {(!renderDialog.files || renderDialog.files.length === 0) ? (
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Width</label>
                          <input
                            type="number"
                            value={renderDialog.width}
                            onChange={e => setRenderDialog({...renderDialog, width: parseInt(e.target.value) || 0})}
                            className="w-full bg-[#1c1c1f] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Height</label>
                          <input
                            type="number"
                            value={renderDialog.height}
                            onChange={e => setRenderDialog({...renderDialog, height: parseInt(e.target.value) || 0})}
                            className="w-full bg-[#1c1c1f] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {renderDialog.files.map((file, idx) => (
                          <div key={idx} className={`bg-[#1c1c1f] p-3.5 rounded-lg border ${file.enabled === false ? 'border-red-500/30 opacity-50' : 'border-white/5'} space-y-3 transition-opacity`}>
                            <div className="flex items-center gap-2.5">
                              <input 
                                type="checkbox" 
                                checked={file.enabled !== false} 
                                onChange={e => {
                                  const newFiles = [...renderDialog.files!];
                                  newFiles[idx].enabled = e.target.checked;
                                  setRenderDialog({...renderDialog, files: newFiles});
                                }}
                                className="w-4 h-4 rounded text-purple-500 bg-[#242428] border-white/10"
                              />
                              <p className="text-sm font-medium text-white truncate flex-1" title={file.filename}>{file.filename}</p>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div className="space-y-1.5">
                                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Width</label>
                                <input
                                  type="number"
                                  value={file.width}
                                  onChange={e => {
                                    const newFiles = [...renderDialog.files!];
                                    newFiles[idx].width = parseInt(e.target.value) || 0;
                                    setRenderDialog({...renderDialog, files: newFiles});
                                  }}
                                  className="w-full bg-[#242428] border border-white/10 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Height</label>
                                <input
                                  type="number"
                                  value={file.height}
                                  onChange={e => {
                                    const newFiles = [...renderDialog.files!];
                                    newFiles[idx].height = parseInt(e.target.value) || 0;
                                    setRenderDialog({...renderDialog, files: newFiles});
                                  }}
                                  className="w-full bg-[#242428] border border-white/10 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                                />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex justify-end gap-3 pt-3.5 border-t border-white/10">
                      <button 
                        onClick={() => setRenderDialog(null)} 
                        disabled={isSubmittingRender}
                        className="px-4 py-2 text-sm font-semibold text-gray-400 hover:text-white rounded-lg transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button 
                        onClick={submitRenderChat} 
                        disabled={isSubmittingRender}
                        className={`flex items-center gap-2 px-4.5 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-semibold uppercase tracking-wider transition-colors shadow-md shadow-purple-900/30 cursor-pointer ${
                          isSubmittingRender ? "opacity-75 cursor-wait" : ""
                        }`}
                      >
                        {isSubmittingRender && <RefreshCw className="w-4 h-4 animate-spin" />}
                        {isSubmittingRender ? "Starting..." : "Start Render"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === "settings" && (
            <motion.div key="settings" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-6">
              <div>
                <h2 className="text-3xl font-bold text-white tracking-tight">Settings</h2>
                <p className="text-sm text-gray-400 mt-0.5">Configure your browser tokens and download preferences.</p>
              </div>

              <div className="flex space-x-4 border-b border-white/10 pb-2">
                <button onClick={() => setSettingsTab('general')} className={`pb-1.5 text-sm font-semibold uppercase tracking-wider transition-colors cursor-pointer ${settingsTab === 'general' ? 'border-b-2 border-purple-500 text-purple-400' : 'text-gray-400 hover:text-white border-b-2 border-transparent'}`}>General</button>
                <button onClick={() => setSettingsTab('render')} className={`pb-1.5 text-sm font-semibold uppercase tracking-wider transition-colors cursor-pointer ${settingsTab === 'render' ? 'border-b-2 border-purple-500 text-purple-400' : 'text-gray-400 hover:text-white border-b-2 border-transparent'}`}>Chat Render</button>
              </div>

              <form onSubmit={handleSaveConfig} className="space-y-5">
                {settingsTab === 'general' && (
                  <>
                    <div className="bg-blue-500/10 border border-blue-500/20 p-4 rounded-xl flex gap-3.5">
                      <Key className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
                      <div>
                        <h4 className="text-sm font-bold text-blue-400">How to get your OAuth Token</h4>
                        <p className="text-sm text-blue-200/70 mt-1 leading-relaxed">
                          1. Go to Twitch.tv and log in.<br/>
                          2. Press F12 to open Developer Tools, go to the <b>Application</b> tab (or Storage).<br/>
                          3. Under <b>Cookies</b>, find the cookie named <code>auth-token</code> and paste its value below.
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Browser OAuth Token</label>
                        <input
                          type="password"
                          value={config?.browserOAuthToken}
                          onChange={(e) => setConfig({ ...config!, browserOAuthToken: e.target.value })}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                          placeholder="e.g. oauth:xxxxxxxxxxxxxxxxxxxx"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Browser Client ID</label>
                        <input
                          type="text"
                          value={config?.browserClientId}
                          onChange={(e) => setConfig({ ...config!, browserClientId: e.target.value })}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-gray-400"
                          placeholder="kimne78kx3ncx6brgo4mv6wki5h1ko"
                        />
                        <p className="text-xs text-gray-500">Usually you don't need to change this.</p>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Default Channels (comma separated)</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-semibold text-sm">twitch.tv/</span>
                        <input
                          type="text"
                          value={channelsInput}
                          onChange={(e) => {
                            setChannelsInput(e.target.value);
                            const parsed = e.target.value.split(',').map(cleanChannel).filter(Boolean).slice(0, 2);
                            setConfig({ ...config!, channels: parsed });
                          }}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg pl-24 pr-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                          placeholder="username1, username2"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Save Path</label>
                        </div>
                        <input
                          type="text"
                          value={config?.savePath}
                          onChange={(e) => setConfig({ ...config!, savePath: e.target.value })}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                          placeholder="downloads"
                        />
                        <p className="text-xs text-gray-500">
                          Relative to program root folder (default: downloads), or an absolute path.
                        </p>
                      </div>
                      <div className="space-y-2.5 flex flex-col justify-end pb-1">
                        <label className="flex items-center gap-2.5 cursor-pointer group">
                          <input
                            type="checkbox"
                            checked={config?.autoStartMonitoring ?? true}
                            onChange={(e) => setConfig({ ...config!, autoStartMonitoring: e.target.checked })}
                            className="w-4.5 h-4.5 rounded border-white/20 bg-[#141416] text-purple-600 focus:ring-0 focus:ring-offset-0"
                          />
                          <span className="text-sm text-gray-300 font-medium group-hover:text-white transition-colors">Start monitoring automatically on launch</span>
                        </label>
                        <label className="flex items-center gap-2.5 cursor-pointer group">
                          <input
                            type="checkbox"
                            checked={(config as any)?.autoRenderChat ?? false}
                            onChange={(e) => setConfig({ ...config!, autoRenderChat: e.target.checked } as any)}
                            className="w-4.5 h-4.5 rounded border-white/20 bg-[#141416] text-purple-600 focus:ring-0 focus:ring-offset-0"
                          />
                          <span className="text-sm text-gray-300 font-medium group-hover:text-white transition-colors">Auto-Render Chat when stream finishes</span>
                        </label>
                      </div>
                    </div>
                    
                     <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                         <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                            <Clock className="w-4 h-4 text-purple-400" /> Game Switch Buffer (Minutes)
                         </label>
                         <p className="text-xs text-gray-500">Time buffered before and after a mid-stream game switch or long-broadcast splice</p>
                         <input
                            type="number"
                            min="0"
                            max="60"
                            value={(config as any)?.gameSwitchBufferMins ?? 5}
                            onChange={(e) => setConfig({ ...config!, gameSwitchBufferMins: parseInt(e.target.value) || 0 } as any)}
                            className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                         />
                      </div>
                      <div className="space-y-1.5">
                         <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                            <Clock className="w-4 h-4 text-purple-400" /> Reconnect Grace Period (Minutes)
                         </label>
                         <p className="text-xs text-gray-500">Time to keep session alive during streamer disconnects before finalizing</p>
                         <input
                            type="number"
                            min="1"
                            max="60"
                            value={(config as any)?.offlineGracePeriodMins ?? 5}
                            onChange={(e) => setConfig({ ...config!, offlineGracePeriodMins: Math.max(1, parseInt(e.target.value) || 1) } as any)}
                            className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                         />
                      </div>
                    </div>

                    {/* Extended Stream / Single Game Autosplice */}
                    <div className="bg-[#141416] border border-white/10 rounded-xl p-4 space-y-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1">
                          <label htmlFor="autosplice-toggle" className="text-sm font-semibold text-white flex items-center gap-2 cursor-pointer">
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
                            checked={(config as any)?.longGameAutospliceEnabled ?? true}
                            onChange={(e) => setConfig({ ...config!, longGameAutospliceEnabled: e.target.checked } as any)}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
                        </label>
                      </div>

                      {((config as any)?.longGameAutospliceEnabled ?? true) && (
                        <div className="pt-3 border-t border-white/5 space-y-3">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                                <Clock className="w-3.5 h-3.5 text-purple-400" /> Trigger Threshold (Hours)
                              </label>
                              <p className="text-xs text-gray-500">Duration on the same game before triggering a splice (0.25h steps)</p>
                              <input
                                type="number"
                                step="0.25"
                                min="0.25"
                                max="72"
                                value={(config as any)?.longGameAutospliceTriggerHours ?? 9}
                                onChange={(e) => {
                                  const val = Math.max(0.25, parseFloat(e.target.value) || 0.25);
                                  const curCut = (config as any)?.longGameAutospliceCutHours ?? 8;
                                  setConfig({
                                    ...config!,
                                    longGameAutospliceTriggerHours: val,
                                    longGameAutospliceCutHours: curCut > val ? val : curCut
                                  } as any);
                                }}
                                className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                                <Scissors className="w-3.5 h-3.5 text-purple-400" /> Splice Cut Point (Hours)
                              </label>
                              <p className="text-xs text-gray-500">Timestamp where segment is cut (must be &le; trigger threshold)</p>
                              <input
                                type="number"
                                step="0.25"
                                min="0.25"
                                max={(config as any)?.longGameAutospliceTriggerHours ?? 9}
                                value={(config as any)?.longGameAutospliceCutHours ?? 8}
                                onChange={(e) => {
                                  const trigger = (config as any)?.longGameAutospliceTriggerHours ?? 9;
                                  const rawVal = Math.max(0.25, parseFloat(e.target.value) || 0.25);
                                  const val = Math.min(trigger, rawVal);
                                  setConfig({
                                    ...config!,
                                    longGameAutospliceCutHours: val
                                  } as any);
                                }}
                                className="w-full bg-[#0a0a0c] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                              />
                            </div>
                          </div>
                          
                          <div className="px-3 py-2 bg-purple-500/10 border border-purple-500/20 rounded-lg text-xs text-purple-300 flex items-center gap-2">
                            <Clock className="w-4 h-4 shrink-0 text-purple-400" />
                            <span>
                              Active Policy: When a stream stays on one game for <strong>{(config as any)?.longGameAutospliceTriggerHours ?? 9}h</strong>, a splice is cut at the <strong>{(config as any)?.longGameAutospliceCutHours ?? 8}h</strong> mark (with <strong>{(config as any)?.gameSwitchBufferMins ?? 5} min</strong> buffer on both sides).
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}

                {settingsTab === 'render' && (
                  <div className="space-y-5">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">TwitchDownloaderCLI Path</label>
                      <input
                        type="text"
                        value={(config as any)?.tdPath || ""}
                        onChange={(e) => setConfig({ ...config!, tdPath: e.target.value } as any)}
                        className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                        placeholder="TwitchDownloader\TwitchDownloaderCLI.exe (or absolute path)"
                      />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Default Width</label>
                        <input
                          type="number"
                          value={(config as any)?.chatRender?.width || 350}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, width: parseInt(e.target.value) || 0 } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Default Height</label>
                        <input
                          type="number"
                          value={(config as any)?.chatRender?.height || 800}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, height: parseInt(e.target.value) || 0 } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Background Color (Hex)</label>
                        <input
                          type="text"
                          value={(config as any)?.chatRender?.backgroundColor || "#111111"}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, backgroundColor: e.target.value } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                          placeholder="#111111 or #FF111111"
                        />
                        <p className="text-xs text-gray-500">Format: #RRGGBB or #AARRGGBB (A = Alpha/Transparency)</p>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Alt Background Color (Hex)</label>
                        <input
                          type="text"
                          value={(config as any)?.chatRender?.altBackgroundColor || "#191919"}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, altBackgroundColor: e.target.value } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                          placeholder="#191919 or #FF191919"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Message Color (Hex)</label>
                        <input
                          type="text"
                          value={(config as any)?.chatRender?.messageColor || "#ffffff"}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, messageColor: e.target.value } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                          placeholder="#ffffff or #ffffffff"
                        />
                        <p className="text-xs text-gray-500">Format: #RRGGBB or #AARRGGBB</p>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Font</label>
                        <input
                          type="text"
                          value={(config as any)?.chatRender?.font || "Inter"}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, font: e.target.value } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Chat Sync - H.264 / 1080p (seconds)</label>
                        <input
                          type="number"
                          step="0.5"
                          value={(config as any)?.chatRender?.syncOffset ?? -2.5}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, syncOffset: e.target.value } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                        />
                        <p className="text-xs text-gray-500">Offset for standard H.264 streams (default: -2.5s). Negative values advance chat earlier.</p>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Chat Sync - HEVC / 1440p (seconds)</label>
                        <input
                          type="number"
                          step="0.5"
                          value={(config as any)?.chatRender?.syncOffsetHevc ?? -7.5}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, syncOffsetHevc: e.target.value } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                        />
                        <p className="text-xs text-gray-500">Offset for HEVC/1440p Enhanced Broadcasts (default: -7.5s). Compensates for broadcaster encoder lag.</p>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Font Size</label>
                        <input
                          type="number"
                          value={(config as any)?.chatRender?.fontSize || 24}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, fontSize: parseInt(e.target.value) || 0 } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Message Font Style</label>
                        <select
                          value={(config as any)?.chatRender?.messageFontStyle || "normal"}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, messageFontStyle: e.target.value } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white cursor-pointer"
                        >
                          <option value="normal">Normal</option>
                          <option value="bold">Bold</option>
                          <option value="italic">Italic</option>
                          <option value="bolditalic">Bold Italic</option>
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Username Font Style</label>
                        <select
                          value={(config as any)?.chatRender?.usernameFontStyle || "bold"}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, usernameFontStyle: e.target.value } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white cursor-pointer"
                        >
                          <option value="normal">Normal</option>
                          <option value="bold">Bold</option>
                          <option value="italic">Italic</option>
                          <option value="bolditalic">Bold Italic</option>
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Emoji Vendor</label>
                        <select
                          value={(config as any)?.chatRender?.emojiVendor || "notocolor"}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, emojiVendor: e.target.value } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white cursor-pointer"
                        >
                          <option value="notocolor">Google (notocolor)</option>
                          <option value="twemoji">Twitter (twemoji)</option>
                          <option value="none">None</option>
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Outline Size</label>
                        <input
                          type="number"
                          value={(config as any)?.chatRender?.outlineSize || 4}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, outlineSize: parseInt(e.target.value) || 0 } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Framerate</label>
                        <input
                          type="number"
                          value={(config as any)?.chatRender?.framerate || 60}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, framerate: parseInt(e.target.value) || 0 } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Update Rate</label>
                        <input
                          type="number"
                          value={(config as any)?.chatRender?.updateRate || 0}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, updateRate: parseFloat(e.target.value) || 0 } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-3.5 border-t border-white/10">
                      {[
                        { key: 'outline', label: 'Text Outline' },
                        { key: 'generateMask', label: 'Generate Mask' },
                        { key: 'alternateBackgrounds', label: 'Alternate Backgrounds' },
                        { key: 'bttv', label: 'BTTV Emotes' },
                        { key: 'ffz', label: 'FFZ Emotes' },
                        { key: 'stv', label: '7TV Emotes' },
                        { key: 'giphy', label: 'Giphy GIFs' },
                        { key: 'allowUnlistedEmotes', label: 'Allow Unlisted Emotes' },
                        { key: 'badges', label: 'Badges' },
                        { key: 'subMessages', label: 'Sub Messages' },
                        { key: 'dispersion', label: 'Dispersion' },
                        { key: 'offline', label: 'Offline Mode' },
                        { key: 'avatars', label: 'Show Avatars' },
                        { key: 'readableColors', label: 'Readable Colors' },
                        { key: 'sharpening', label: 'Sharpening' },
                        { key: 'autoCompensateClockDrift', label: 'Auto-Compensate Clock Drift (10+ hr streams)' },
                      ].map(opt => (
                        <label key={opt.key} className="flex items-center gap-2.5 cursor-pointer group">
                          <input
                            type="checkbox"
                            checked={(config as any)?.chatRender?.[opt.key] ?? (['bttv', 'ffz', 'stv', 'giphy', 'allowUnlistedEmotes', 'badges', 'subMessages', 'readableColors', 'autoCompensateClockDrift'].includes(opt.key))}
                            onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, [opt.key]: e.target.checked } } as any)}
                            className="w-4.5 h-4.5 rounded border-white/20 bg-[#141416] text-purple-600 focus:ring-0 focus:ring-offset-0"
                          />
                          <span className="text-sm text-gray-300 font-medium group-hover:text-white transition-colors">{opt.label}</span>
                        </label>
                      ))}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-3.5 border-t border-white/10">
                      {[
                        { key: 'scaleEmote', label: 'Scale Emote' },
                        { key: 'scaleBadge', label: 'Scale Badge' },
                        { key: 'scaleEmoji', label: 'Scale Emoji' },
                        { key: 'scaleAvatar', label: 'Scale Avatar' },
                        { key: 'scaleVertical', label: 'Scale Vertical' },
                        { key: 'scaleSidePadding', label: 'Scale Side Padding' },
                        { key: 'scaleSectionHeight', label: 'Scale Section Height' },
                        { key: 'scaleWordSpace', label: 'Scale Word Space' },
                        { key: 'scaleEmoteSpace', label: 'Scale Emote Space' },
                        { key: 'scaleHighlightStroke', label: 'Scale Highlight Stroke' },
                        { key: 'scaleHighlightIndent', label: 'Scale Highlight Indent' },
                      ].map(opt => (
                        <div key={opt.key} className="space-y-1.5">
                          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{opt.label}</label>
                          <input
                            type="number"
                            step="0.1"
                            value={(config as any)?.chatRender?.[opt.key] ?? (opt.key === 'scaleVertical' ? 0.5 : 1.0)}
                            onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, [opt.key]: parseFloat(e.target.value) || 0 } } as any)}
                            className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                          />
                        </div>
                      ))}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3.5 border-t border-white/10">
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">File Format</label>
                        <select
                          value={(config as any)?.chatRender?.format || "mp4"}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, format: e.target.value } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white cursor-pointer"
                        >
                          <option value="mp4">MP4 (.mp4)</option>
                          <option value="webm">WEBM (.webm) - Transparent for VP9</option>
                          <option value="mov">MOV (.mov) - Transparent for ProRes</option>
                          <option value="mkv">MKV (.mkv)</option>
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Codec</label>
                        <select
                          value={(config as any)?.chatRender?.codec || "h264"}
                          onChange={(e) => {
                            const newCodec = e.target.value;
                            let newFormat = (config as any)?.chatRender?.format || "mp4";
                            if ((newCodec === "vp9" || newCodec === "vp8") && newFormat !== "webm" && newFormat !== "mkv") {
                              newFormat = "webm";
                            } else if (newCodec === "prores" && newFormat !== "mov" && newFormat !== "mkv") {
                              newFormat = "mov";
                            }
                            setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, codec: newCodec, format: newFormat } } as any);
                          }}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white cursor-pointer"
                        >
                          <option value="vp9">VP9 (Transparent, ~98% Smaller WebM)</option>
                          <option value="prores">ProRes (Transparent, Master MOV)</option>
                          <option value="h264">H264 (Standard)</option>
                          <option value="hevc">HEVC / H265</option>
                          <option value="vp8">VP8</option>
                        </select>
                      </div>
                      <div className="space-y-1.5 md:col-span-2">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Chat Badge Filter (Bitmask)</label>
                        <input
                          type="number"
                          value={(config as any)?.chatRender?.badgeFilter || 0}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, badgeFilter: parseInt(e.target.value) || 0 } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                        />
                        <p className="text-xs text-gray-500">
                          0 = All (Default), 1 = Broadcaster, 2 = Moderator, 4 = VIP, 8 = Subscriber, 16 = Predictions, 32 = NoAudioVisual, 64 = PrimeGaming. Add values together to combine.
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Ignore Users (comma separated)</label>
                        <input
                          type="text"
                          value={(config as any)?.chatRender?.ignoreUsers || ""}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, ignoreUsers: e.target.value } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Banned Words (comma separated)</label>
                        <input
                          type="text"
                          value={(config as any)?.chatRender?.bannedWords || ""}
                          onChange={(e) => setConfig({ ...config!, chatRender: { ...(config as any)?.chatRender, bannedWords: e.target.value } } as any)}
                          className="w-full bg-[#141416] border border-white/10 rounded-lg px-3 py-2 text-sm sm:text-base focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                        />
                      </div>
                    </div>

                    <div className="pt-4 border-t border-white/10">
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
                          onClick={openManualRenderModal}
                          className="flex items-center justify-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-semibold transition-colors cursor-pointer shrink-0 shadow-sm"
                        >
                          <Play className="w-3.5 h-3.5 fill-current" />
                          Manual Render...
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap justify-between items-center gap-4 mt-6 pt-6 border-t border-white/10">
                  <div className="flex items-center gap-3">
                    <button 
                      type="button" 
                      disabled={isResetting}
                      onClick={() => setShowRebootConfirm(true)}
                      className={`flex items-center gap-2 bg-red-500/10 text-red-400 border border-red-500/20 px-4 py-2.5 rounded-lg text-sm font-semibold uppercase tracking-wider hover:bg-red-500 hover:text-white transition-all cursor-pointer ${
                        isResetting ? "opacity-75 cursor-wait" : ""
                      }`}
                    >
                      {isResetting && <RefreshCw className="w-4 h-4 animate-spin" />}
                      {isResetting ? "Rebooting..." : "Reboot Program"}
                    </button>
                    <a
                      href="/api/system-log"
                      download
                      className="flex items-center gap-2 bg-white/5 text-gray-300 border border-white/10 hover:border-white/20 hover:text-white px-4 py-2.5 rounded-lg text-sm font-semibold uppercase tracking-wider transition-all"
                    >
                      <Download className="w-4 h-4" />
                      Download System Log
                    </a>
                  </div>
                  <div className="flex items-center gap-3">
                    {saveStatusMessage && (
                      <div className={`flex items-center gap-2 text-sm font-semibold ${saveStatusMessage.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>
                        {saveStatusMessage.type === 'success' && <Check className="w-4 h-4" />}
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
            </motion.div>
          )}

          {activeTab === "logs" && (
            <motion.div key="logs" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-3xl font-bold text-white tracking-tight">System Log</h2>
                  <p className="text-sm text-gray-400 mt-0.5">Detailed history of all monitoring and download events.</p>
                </div>
                <div className="flex items-center gap-3">
                  {!autoScrollLogs ? (
                    <button 
                      onClick={scrollToBottomLogs}
                      className="flex items-center gap-2 px-3 py-2 bg-purple-600/20 text-purple-400 border border-purple-500/30 hover:bg-purple-600 hover:text-white rounded-lg text-sm font-semibold transition-all shadow-sm cursor-pointer"
                    >
                      <ArrowDown className="w-4 h-4 animate-bounce" />
                      Auto-scroll paused (click to resume)
                    </button>
                  ) : (
                    <span className="flex items-center gap-2 text-sm text-gray-400 bg-white/5 px-3 py-1.5 rounded-lg border border-white/5 font-medium">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                      Auto-scroll on
                    </span>
                  )}
                  <a
                    href="/api/system-log"
                    download="system.log"
                    className="flex items-center gap-2 px-3 py-2 bg-white/5 hover:bg-white/10 text-gray-300 rounded-lg text-sm font-semibold transition-colors border border-white/10"
                  >
                    <Download className="w-4 h-4" />
                    Download File
                  </a>
                </div>
              </div>
              <div className="bg-[#111113] border border-white/10 rounded-xl overflow-hidden shadow-md">
                <div 
                  ref={logContainerRef}
                  onScroll={handleLogScroll}
                  className="p-3.5 h-[620px] overflow-y-auto font-mono text-xs leading-relaxed space-y-0.5 scrollbar-thin scrollbar-thumb-white/10"
                >
                  {status?.logs && status.logs.length > 0 ? (
                    status.logs.map((log, i) => (
                      <div 
                        key={i} 
                        className="text-gray-300 hover:bg-white/[0.04] px-2.5 py-0.5 rounded transition-colors break-words font-mono select-text whitespace-pre-wrap"
                      >
                        {log}
                      </div>
                    ))
                  ) : (
                    <div className="text-gray-500 text-center py-20 text-xs">No logs recorded yet.</div>
                  )}
                  <div ref={logEndRef} />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Manual Chat Render Modal */}
        {manualRenderDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
            <div className="bg-[#141416] border border-white/15 rounded-2xl w-full max-w-lg p-6 shadow-2xl space-y-5">
              <div className="flex items-center justify-between border-b border-white/10 pb-4">
                <div className="flex items-center gap-2.5">
                  <Film className="w-5 h-5 text-purple-400" />
                  <h3 className="text-lg font-bold text-white tracking-tight">Manual Chat Render</h3>
                </div>
                <button 
                  type="button"
                  onClick={() => setManualRenderDialog(false)}
                  className="text-gray-400 hover:text-white p-1 rounded-lg transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider block">
                    Chat JSON File Path
                  </label>
                  <input
                    type="text"
                    value={manualRenderPath}
                    onChange={(e) => {
                      setManualRenderPath(e.target.value);
                      setManualRenderMsg(null);
                    }}
                    placeholder="e.g. downloads/the_happy_hob_.../chat.json (or full path)"
                    className="w-full bg-[#1c1c1f] border border-white/10 rounded-lg px-3.5 py-2.5 text-sm font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white placeholder-gray-600 shadow-inner"
                  />
                  <p className="text-xs text-gray-500">
                    Paste the full path to the chat JSON file (or filename if it resides inside your configured downloads folder).
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Width (px)</label>
                    <input
                      type="number"
                      value={manualRenderWidth}
                      onChange={(e) => setManualRenderWidth(parseInt(e.target.value) || 0)}
                      className="w-full bg-[#1c1c1f] border border-white/10 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Height (px)</label>
                    <input
                      type="number"
                      value={manualRenderHeight}
                      onChange={(e) => setManualRenderHeight(parseInt(e.target.value) || 0)}
                      className="w-full bg-[#1c1c1f] border border-white/10 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-purple-500/50 transition-colors text-white"
                    />
                  </div>
                </div>

                {manualRenderMsg && (
                  <div className={`p-3 rounded-lg text-xs flex items-center gap-2 ${
                    manualRenderMsg.type === 'success' 
                      ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' 
                      : 'bg-red-500/10 border border-red-500/20 text-red-400'
                  }`}>
                    {manualRenderMsg.type === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                    ) : (
                      <AlertCircle className="w-4 h-4 shrink-0" />
                    )}
                    <span>{manualRenderMsg.text}</span>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10">
                <button
                  type="button"
                  onClick={() => setManualRenderDialog(false)}
                  disabled={isStartingManualRender}
                  className="px-4 py-2 text-sm font-semibold text-gray-400 hover:text-white rounded-lg transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitManualRender}
                  disabled={isStartingManualRender || !manualRenderPath.trim()}
                  className={`flex items-center gap-2 px-5 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-semibold uppercase tracking-wider transition-colors shadow-md shadow-purple-900/30 cursor-pointer ${
                    isStartingManualRender || !manualRenderPath.trim() ? "opacity-75 cursor-not-allowed" : ""
                  }`}
                >
                  {isStartingManualRender && <RefreshCw className="w-4 h-4 animate-spin" />}
                  {isStartingManualRender ? "Starting..." : "Start Render"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Stop Live Recording Confirmation Modal */}
        {stopConfirmChannel && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
            <div className="bg-[#141416] border border-red-500/30 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/25 flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-5 h-5 text-red-400" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white tracking-tight">Stop Live Recording?</h3>
                  <p className="text-xs text-gray-400 font-mono">@{stopConfirmChannel} is actively recording</p>
                </div>
              </div>

              <p className="text-sm text-gray-300 leading-relaxed">
                Stream @{stopConfirmChannel} is actively recording! Stopping monitoring now will conclude recording and immediately trigger segment stitching and chat rendering.
              </p>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10">
                <button
                  type="button"
                  onClick={() => setStopConfirmChannel(null)}
                  className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-400 hover:text-white transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const channel = stopConfirmChannel;
                    setStopConfirmChannel(null);
                    executeToggleChannelMonitoring(channel);
                  }}
                  className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-red-600 hover:bg-red-500 transition-colors shadow-md shadow-red-900/30 cursor-pointer"
                >
                  Stop Recording
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Reboot Program Confirmation Modal */}
        {showRebootConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
            <div className="bg-[#141416] border border-red-500/30 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/25 flex items-center justify-center shrink-0">
                  <RefreshCw className="w-5 h-5 text-red-400" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white tracking-tight">Reboot Program?</h3>
                  <p className="text-xs text-gray-400">Cancel all tasks and reset state</p>
                </div>
              </div>

              <p className="text-sm text-gray-300 leading-relaxed">
                Are you sure you want to reboot the program? This will cancel all active background tasks, terminate active chat renders, and reset stream monitoring.
              </p>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10">
                <button
                  type="button"
                  onClick={() => setShowRebootConfirm(false)}
                  className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-400 hover:text-white transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowRebootConfirm(false);
                    executeReset();
                  }}
                  className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-red-600 hover:bg-red-500 transition-colors shadow-md shadow-red-900/30 cursor-pointer"
                >
                  Reboot Program
                </button>
              </div>
            </div>
          </div>
        )}
        {/* 3-Mode Manual Splice Game Modal */}
        {manualSpliceChannel && (() => {
          const activeSession = status?.activeSessions.find(
            s => cleanChannel(s.channel) === cleanChannel(manualSpliceChannel)
          );
          const games = activeSession?.games || [];
          const hasPrevious = games.length > 1;
          const previousGameName = hasPrevious ? games[games.length - 2].gameName : null;
          const currentGameName = activeSession?.currentGame || (games.length > 0 ? games[games.length - 1].gameName : "Current Game");
          const currentGameDurationSec = Math.max(0, (activeSession?.videoDurationSeconds || 0) - (games[games.length - 1]?.startTimeOffset || 0));
          const currentGameDurationMins = Math.max(0.1, currentGameDurationSec / 60).toFixed(1);

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
                      <h3 className="text-base font-bold text-white tracking-tight">Manual Video Splice</h3>
                      <p className="text-xs text-purple-300 font-mono">@{manualSpliceChannel} • Playing {currentGameName}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setManualSpliceChannel(null)}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <p className="text-xs text-gray-400 leading-relaxed">
                  Choose what to do with the footage recorded up to this moment:
                </p>

                {/* 3 Options */}
                <div className="space-y-3">
                  {/* Option 1: Append to Previous Game */}
                  <label
                    className={`block p-3.5 rounded-xl border transition-all cursor-pointer ${
                      !hasPrevious
                        ? "opacity-40 border-white/5 bg-white/[0.02] cursor-not-allowed"
                        : spliceAction === 'append_previous'
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
                        checked={spliceAction === 'append_previous'}
                        onChange={() => setSpliceAction('append_previous')}
                        className="mt-1 text-purple-600 focus:ring-0 cursor-pointer disabled:cursor-not-allowed"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-white">Append Extension to Previous Game</span>
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
                          Slices footage recorded up to now and stitches it as a seamless extension file to {previousGameName || 'the previous game'} with matching chat. Shifts {currentGameName}'s start point to now.
                        </p>
                      </div>
                    </div>
                  </label>

                  {/* Option 2: Extract Standalone Highlight / Clip */}
                  <label
                    className={`block p-3.5 rounded-xl border transition-all cursor-pointer ${
                      spliceAction === 'extract_clip'
                        ? "border-purple-500/70 bg-purple-950/25 shadow-sm shadow-purple-500/10"
                        : "border-white/10 bg-white/[0.03] hover:border-white/20"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="radio"
                        name="splice_action"
                        value="extract_clip"
                        checked={spliceAction === 'extract_clip'}
                        onChange={() => setSpliceAction('extract_clip')}
                        className="mt-1 text-purple-600 focus:ring-0 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-white">Extract Standalone Highlight / Clip</span>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
                            Non-destructive
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                          Remuxes a standalone video and chat clip right now. The ongoing broadcast recording continues completely untouched without splitting the master game VOD.
                        </p>

                        {/* Sub-options for Clip */}
                        {spliceAction === 'extract_clip' && (
                          <div className="mt-3 pt-3 border-t border-white/10 space-y-2.5">
                            <div className="flex items-center gap-4 text-xs">
                              <label className="flex items-center gap-1.5 cursor-pointer text-gray-300 hover:text-white">
                                <input
                                  type="radio"
                                  name="clip_scope"
                                  value="whole_game"
                                  checked={clipScope === 'whole_game'}
                                  onChange={() => setClipScope('whole_game')}
                                  className="text-purple-600 focus:ring-0"
                                />
                                <span>Whole game until now (~{currentGameDurationMins} min)</span>
                              </label>

                              <label className="flex items-center gap-1.5 cursor-pointer text-gray-300 hover:text-white">
                                <input
                                  type="radio"
                                  name="clip_scope"
                                  value="custom_duration"
                                  checked={clipScope === 'custom_duration'}
                                  onChange={() => setClipScope('custom_duration')}
                                  className="text-purple-600 focus:ring-0"
                                />
                                <span>Last X minutes</span>
                              </label>
                            </div>

                            {clipScope === 'custom_duration' && (
                              <div className="flex items-center gap-2 pt-1">
                                <span className="text-xs text-gray-400">Duration:</span>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    setClipMinutes(prev => Math.max(0.5, Number((prev - 0.5).toFixed(1))));
                                  }}
                                  className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white font-mono text-xs font-bold transition-colors cursor-pointer"
                                >
                                  -0.5m
                                </button>
                                <input
                                  type="number"
                                  min="0.5"
                                  max="180"
                                  step="0.5"
                                  value={clipMinutes}
                                  onChange={(e) => setClipMinutes(Math.max(0.5, Math.min(180, parseFloat(e.target.value) || 0.5)))}
                                  className="w-20 px-2.5 py-1 text-xs text-center rounded bg-black/40 border border-white/20 text-white font-mono focus:outline-none focus:border-purple-500"
                                />
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    setClipMinutes(prev => Math.min(180, Number((prev + 0.5).toFixed(1))));
                                  }}
                                  className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white font-mono text-xs font-bold transition-colors cursor-pointer"
                                >
                                  +0.5m
                                </button>
                                <span className="text-[11px] text-gray-400 font-mono">
                                  ({Math.round(clipMinutes * 60)}s • {Math.round(clipMinutes * 30)} chunks)
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
                      spliceAction === 'split_new_part'
                        ? "border-purple-500/70 bg-purple-950/25 shadow-sm shadow-purple-500/10"
                        : "border-white/10 bg-white/[0.03] hover:border-white/20"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="radio"
                        name="splice_action"
                        value="split_new_part"
                        checked={spliceAction === 'split_new_part'}
                        onChange={() => setSpliceAction('split_new_part')}
                        className="mt-1 text-purple-600 focus:ring-0 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-white">Split Game into New Part / Chapter</span>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                            New segment
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                          Finalizes the current segment now for stitching and starts the next part immediately, preserving the transition buffer.
                        </p>
                      </div>
                    </div>
                  </label>
                </div>

                {/* Live Preview Summary */}
                <div className="p-3 rounded-xl bg-purple-950/30 border border-purple-500/20 text-xs text-purple-200 flex items-start gap-2">
                  <span className="font-bold text-purple-400 shrink-0">Summary:</span>
                  <div className="leading-relaxed">
                    {spliceAction === 'append_previous' && (
                      <span>
                        Will stitch extra footage up to now as an extension file for <strong>{previousGameName}</strong> with matching chat, then advance <strong>{currentGameName}</strong>'s start point.
                      </span>
                    )}
                    {spliceAction === 'extract_clip' && clipScope === 'whole_game' && (
                      <span>
                        Will export a standalone ~<strong>{currentGameDurationMins}m</strong> video and chat clip of <strong>{currentGameName}</strong> up to now. The live recording continues without interruption.
                      </span>
                    )}
                    {spliceAction === 'extract_clip' && clipScope === 'custom_duration' && (
                      <span>
                        Will extract a standalone <strong>{clipMinutes}m</strong> video and chat clip of <strong>{currentGameName}</strong> ending now. The live recording continues without interruption.
                      </span>
                    )}
                    {spliceAction === 'split_new_part' && (
                      <span>
                        Will finalize <strong>{currentGameName}</strong> (Segment {games.length || 1}) and immediately begin Part {games.length + 1} with leading buffer preserved.
                      </span>
                    )}
                  </div>
                </div>

                {/* Modal Actions */}
                <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10">
                  <button
                    type="button"
                    onClick={() => setManualSpliceChannel(null)}
                    className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-400 hover:text-white transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const ch = manualSpliceChannel;
                      const act = spliceAction;
                      const sc = clipScope;
                      const mins = clipMinutes;
                      setManualSpliceChannel(null);
                      executeManualSplice(ch, act, sc, mins);
                    }}
                    className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-purple-600 hover:bg-purple-500 transition-colors shadow-md shadow-purple-900/30 cursor-pointer"
                  >
                    Execute Splice
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
        {/* Cancel Chat Render Confirmation Modal */}
        {cancelRenderConfirmTask && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
            <div className="bg-[#141416] border border-red-500/30 p-6 rounded-xl max-w-md w-full space-y-4 shadow-2xl">
              <div className="flex items-center gap-3 text-red-400">
                <div className="w-10 h-10 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-5 h-5 text-red-400" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white tracking-tight">Cancel Chat Render?</h3>
                  <p className="text-xs text-gray-400 mt-0.5">{cancelRenderConfirmTask.name}</p>
                </div>
              </div>
              <p className="text-sm text-gray-300 leading-relaxed">
                Are you sure you want to cancel this chat render? The render process will terminate and any partial render progress will be discarded.
              </p>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setCancelRenderConfirmTask(null)}
                  className="px-4 py-2 bg-white/5 hover:bg-white/10 text-gray-300 rounded-lg text-sm font-semibold transition-colors border border-white/10 cursor-pointer"
                >
                  Keep Rendering
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const taskId = cancelRenderConfirmTask.id;
                    setCancelRenderConfirmTask(null);
                    handleTaskAction(taskId, 'cancel_render');
                  }}
                  className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-semibold transition-colors shadow-md shadow-red-900/30 cursor-pointer"
                >
                  Yes, Cancel Render
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Global Toast Notification */}
        {toastMessage && (
          <div className="fixed bottom-6 right-6 z-50 max-w-md animate-in fade-in slide-in-from-bottom-3 duration-200">
            <div className={`p-4 rounded-xl shadow-2xl border flex items-start gap-3 ${
              toastMessage.type === 'error'
                ? 'bg-red-950/90 border-red-500/40 text-red-200'
                : toastMessage.type === 'success'
                ? 'bg-emerald-950/90 border-emerald-500/40 text-emerald-200'
                : 'bg-zinc-900/95 border-purple-500/40 text-gray-200'
            }`}>
              <Folder className="w-5 h-5 text-purple-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wider text-purple-300">File Manager</p>
                <p className="text-sm mt-0.5 break-words font-mono">{toastMessage.text}</p>
              </div>
              <button
                type="button"
                onClick={() => setToastMessage(null)}
                className="text-gray-400 hover:text-white p-1 rounded hover:bg-white/10 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
