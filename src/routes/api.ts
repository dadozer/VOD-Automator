import express from "express";
import fs from "fs";
import path from "path";
import checkDiskSpace from "check-disk-space";
import { spawn, exec, execFile } from "child_process";
import { state, addLog, updateTask, removeTask, scheduleStateSave, flushStateSync, CONFIG_FILE, CONFIG_BAK_FILE, LOG_FILE, LOG_ROTATED_FILE, cleanChannelName, PROJECT_ROOT, saveConfigAtomic, getResolvedSavePath, normalizeConfigSavePath } from "../services/state";
import { stopActiveDownload, handleStitchComplete, startMonitoring, getMonitoringInterval, setMonitoringInterval, stopMonitoringTimer, backfillVod, finalizeLiveDownload, triggerFinalizeFlow, manualSpliceGame, overrideGameSwitchBuffer, formatTimestamp, executeResumeStitchGap, executeResumeVodBackfill, refreshMediaPlaylist } from "../services/download";
import { stitchVideoChunks, abortAllFfmpegProcesses } from "../services/video";
import { downloadVodChat, startChatRenderMultiple, startManualChatRender, resolveLiveChatBackfill, abortAllChatProcesses, abortChatProcess } from "../services/chat";

export async function openFolderInOs(targetPath?: string): Promise<{ success: boolean; folderPath: string; error?: string }> {
  let resolved: string;
  if (!targetPath) {
    resolved = getResolvedSavePath();
  } else if (targetPath.toLowerCase().includes("newdownloader")) {
    const afterDownloads = targetPath.replace(/^.*?[\\/]downloads[\\/]?/i, '');
    resolved = afterDownloads ? path.join(getResolvedSavePath(), afterDownloads) : getResolvedSavePath();
  } else if (path.isAbsolute(targetPath)) {
    resolved = path.normalize(targetPath);
  } else {
    resolved = path.resolve(PROJECT_ROOT, targetPath);
  }
  try {
    if (!fs.existsSync(resolved)) {
      await fs.promises.mkdir(resolved, { recursive: true }).catch(() => {});
    }
  } catch (e) {}

  addLog(`[Explorer] Opening folder in OS file manager: ${resolved}`);

  return new Promise((resolve) => {
    try {
      if (process.platform === 'win32') {
        const winPath = path.normalize(resolved);
        const explorerExe = path.join(process.env.WINDIR || 'C:\\Windows', 'explorer.exe');
        
        let settled = false;
        const child = spawn(explorerExe, [winPath], {
          detached: true,
          stdio: 'ignore'
        });

        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          addLog(`[Explorer] Direct explorer spawn failed (${err.message}). Trying shell start...`);
          exec(`start "" "${winPath}"`, (execErr) => {
            if (execErr) {
              addLog(`[Explorer] Error opening folder: ${execErr.message}`);
              resolve({ success: false, folderPath: winPath, error: execErr.message });
            } else {
              resolve({ success: true, folderPath: winPath });
            }
          });
        });

        setTimeout(() => {
          if (!settled) {
            settled = true;
            child.unref();
            resolve({ success: true, folderPath: winPath });
          }
        }, 200);
      } else if (process.platform === 'darwin') {
        execFile('open', [resolved], (err) => {
          if (err) {
            addLog(`[Explorer] Error opening folder on macOS: ${err.message}`);
            resolve({ success: false, folderPath: resolved, error: err.message });
          } else {
            resolve({ success: true, folderPath: resolved });
          }
        });
      } else {
        execFile('xdg-open', [resolved], (err) => {
          if (err) {
            addLog(`[Explorer] Error opening folder on Linux: ${err.message}`);
            resolve({ success: false, folderPath: resolved, error: err.message });
          } else {
            resolve({ success: true, folderPath: resolved });
          }
        });
      }
    } catch (err: any) {
      addLog(`[Explorer] Exception opening folder: ${err.message}`);
      resolve({ success: false, folderPath: resolved, error: err.message });
    }
  });
}

export function setupRoutes(app: express.Application) {
  // API Routes
  app.get("/api/config", (req, res) => res.json(state.config));
  
  app.post("/api/open-folder", async (req, res) => {
    const { folderPath } = req.body || {};
    const result = await openFolderInOs(folderPath);
    res.json(result);
  });
  
  app.get("/api/system-log", (req, res) => {
    const isRotated = req.query.archive === "1" || req.query.rotated === "1";
    const targetFile = isRotated ? LOG_ROTATED_FILE : LOG_FILE;
    const downloadName = isRotated ? "system.log.1" : "system.log";

    if (fs.existsSync(targetFile)) {
      res.download(targetFile, downloadName);
    } else if (isRotated && fs.existsSync(LOG_FILE)) {
      res.download(LOG_FILE, "system.log");
    } else {
      res.status(404).send("Log file not found.");
    }
  });

  app.post("/api/config", async (req, res) => {
    const prevOAuthToken = state.config?.browserOAuthToken || "";
    const prevClientId = state.config?.browserClientId || "";

    if (req.body?.chatRender && state.config?.chatRender) {
      req.body.chatRender = {
        ...state.config.chatRender,
        ...req.body.chatRender,
      };
    }
    state.config = { ...state.config, ...req.body };
    state.config.savePath = normalizeConfigSavePath(state.config.savePath);

    if (Array.isArray(state.config.channels)) {
      state.config.channels = Array.from(new Set(
        state.config.channels.map(cleanChannelName).filter(Boolean)
      )).slice(0, 2);
    }

    // Reconcile with active monitored channels:
    // If the user changed the channels in settings, any old channel no longer configured must be stopped cleanly
    const allowedChannels = new Set((state.config.channels || []).map(cleanChannelName));
    const removedChannels = state.monitoredChannels.filter(c => !allowedChannels.has(cleanChannelName(c)));
    
    for (const removed of removedChannels) {
      addLog(`[Config Update] Channel @${removed} is no longer in configured channels. Stopping monitoring...`);
      state.monitoredChannels = state.monitoredChannels.filter(c => cleanChannelName(c) !== cleanChannelName(removed));
      const matchingKey = Object.keys(state.activeDownloadSessions).find(k => cleanChannelName(k) === cleanChannelName(removed));
      if (matchingKey) {
        const activeSession = state.activeDownloadSessions[matchingKey];
        if (activeSession) {
          const sessionData = { ...activeSession };
          await stopActiveDownload(matchingKey);
          triggerFinalizeFlow(sessionData, removed);
        }
      }
    }

    // If Twitch Browser OAuth Token or Client-ID changed, immediately refresh playlists for active live sessions
    const credentialsChanged =
      (state.config.browserOAuthToken || "") !== prevOAuthToken ||
      (state.config.browserClientId || "") !== prevClientId;
    if (credentialsChanged) {
      const activeKeys = Object.keys(state.activeDownloadSessions);
      for (const chKey of activeKeys) {
        addLog(`[Config Update] Twitch authentication credentials updated. Refreshing live media playlist for @${chKey}...`);
        refreshMediaPlaylist(chKey).catch(() => {});
      }
    }

    state.config.isMonitoring = state.monitoredChannels.length > 0;
    if (state.monitoredChannels.length === 0) {
      stopMonitoringTimer();
    }

    try {
      await saveConfigAtomic(state.config);
    } catch (err) {
      console.error("Failed to save config.json", err);
    }
    res.json(state.config);
  });

  let cachedDiskSpace = { free: 0, size: 0, lastCheck: 0 };
  let isCheckingDisk = false;

  const refreshDiskSpace = async (targetSavePath?: string) => {
    if (isCheckingDisk) return;
    isCheckingDisk = true;
    try {
      const diskPath = getResolvedSavePath(targetSavePath);
      if (!fs.existsSync(diskPath)) {
        await fs.promises.mkdir(diskPath, { recursive: true }).catch(() => {});
      }
      const diskPromise = checkDiskSpace(diskPath);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout querying disk space")), 2500)
      );
      const res = await Promise.race([diskPromise, timeoutPromise]);
      if (res && typeof res.free === "number") {
        cachedDiskSpace = {
          free: res.free,
          size: res.size,
          lastCheck: Date.now(),
        };
      }
    } catch {
      // Fallback gracefully without blocking
    } finally {
      isCheckingDisk = false;
    }
  };

  // Kick off initial background disk space check
  refreshDiskSpace();

  app.get("/api/health", (req, res) => {
    const activeSessionsList = Object.values(state.activeDownloadSessions || {});
    const activeCount = activeSessionsList.length;
    const connectedWsCount = activeSessionsList.filter(
      (s) => s.chatWs && s.chatWs.readyState === 1
    ).length;
    const wsConnected = activeCount === 0 ? true : connectedWsCount === activeCount;

    return res.status(200).json({
      status: "ok",
      uptime: Math.floor(process.uptime()),
      isMonitoring: Boolean(state.config.isMonitoring),
      lastCheckTime: state.lastCheckTime || null,
      activeSessions: activeCount,
      wsConnected,
      chatSockets: {
        active: activeCount,
        connected: connectedWsCount,
      },
    });
  });

  app.get("/api/status", async (req, res) => {
    try {
      // Non-blocking refresh if cache is older than 60s
      const now = Date.now();
      if (now - cachedDiskSpace.lastCheck > 60000) {
        refreshDiskSpace();
      }

      return res.json({
        isMonitoring: state.config.isMonitoring,
        monitoredChannels: state.monitoredChannels || [],
        isLive: Object.keys(state.activeDownloadSessions).length > 0,
        logs: state.logs,
        activeTasks: Object.values(state.activeTasks),
        lastCheckTime: state.lastCheckTime,
        systemHealth: {
          diskFree: cachedDiskSpace.free,
          diskTotal: cachedDiskSpace.size,
          memoryUsed: process.memoryUsage().rss,
          uptime: process.uptime(),
        },
        activeSessions: Object.values(state.activeDownloadSessions || {}).map(session => {
          let pendingGameSwitch: any = undefined;
          if (session.games && session.games.length > 1) {
            const games = session.games;
            for (let i = 0; i < games.length - 1; i++) {
              if (!games[i].isExported) {
                const nextGame = games[i + 1];
                const bufferRequired = ((state.config as any).gameSwitchBufferMins ?? (state.config as any).gameSegmentBufferMinutes ?? 6) * 60;
                const bufferElapsed = (session.videoDurationSeconds || 0) - nextGame.startTimeOffset;
                const remaining = Math.max(0, Math.ceil(bufferRequired - bufferElapsed));
                pendingGameSwitch = {
                  gameIndex: i,
                  previousGame: games[i].gameName,
                  currentGame: nextGame.gameName,
                  secondsRemaining: remaining,
                  totalBufferSeconds: bufferRequired
                };
                break;
              }
            }
          }

          const graceMins = (state.config.offlineGracePeriodMins !== undefined && state.config.offlineGracePeriodMins >= 1)
            ? state.config.offlineGracePeriodMins
            : 5;
          const graceTotalSeconds = graceMins * 60;
          let offlineGraceRemainingSeconds = graceTotalSeconds;
          if (session.offlineDetectedAtMs) {
            const elapsedSec = Math.floor((Date.now() - session.offlineDetectedAtMs) / 1000);
            offlineGraceRemainingSeconds = Math.max(0, graceTotalSeconds - elapsedSec);
          } else if (session.missingCount && session.missingCount > 0) {
            const elapsedSec = session.missingCount * 15;
            offlineGraceRemainingSeconds = Math.max(0, graceTotalSeconds - elapsedSec);
          }

          return {
            channel: session.channel,
            streamId: session.streamId,
            startTime: session.startTime,
            chunksDownloaded: session.chunksDownloaded,
            videoDurationSeconds: session.videoDurationSeconds || 0,
            missingCount: session.missingCount || 0,
            offlineGraceRemainingSeconds,
            offlineGraceTotalSeconds: graceTotalSeconds,
            folderPath: session.folderPath,
            currentTitle: session.currentTitle,
            currentGame: session.currentGame,
            viewersCount: session.viewersCount,
            previewImageUrl: session.previewImageUrl,
            autoRenderChat: session.autoRenderChat,
            commentsWritten: session.commentsWritten || 0,
            games: session.games || [],
            pendingGameSwitch
          };
        })
      });
    } catch (err: any) {
      console.error("[API Error] Failed to compute /api/status:", err);
      return res.status(500).json({ error: "Failed to compute status", message: err?.message || String(err) });
    }
  });

  app.post("/api/sessions/:channel/auto-render", async (req, res) => {
    const { channel } = req.params;
    const { enabled } = req.body;
    const cleaned = cleanChannelName(channel);
    
    // Save to channelAutoRender config map
    if (!state.config.channelAutoRender) {
      state.config.channelAutoRender = {};
    }
    state.config.channelAutoRender[cleaned] = Boolean(enabled);

    // Also update active session if currently running
    const matchingKey = Object.keys(state.activeDownloadSessions).find(k => cleanChannelName(k) === cleaned);
    if (matchingKey && state.activeDownloadSessions[matchingKey]) {
      state.activeDownloadSessions[matchingKey].autoRenderChat = Boolean(enabled);
    }
    
    scheduleStateSave();
    try {
      await saveConfigAtomic(state.config);
    } catch (err) {
      console.error("Failed to save config.json", err);
    }

    return res.json({ 
      success: true, 
      channel: cleaned,
      enabled: state.config.channelAutoRender[cleaned],
      config: state.config
    });
  });

  app.post("/api/force-stitch", async (req, res) => {
    const { channel } = req.body;
    const activeSession = state.activeDownloadSessions[channel];
    
    if (!activeSession) {
      return res.status(404).json({ error: "No active session for this channel" });
    }
    
    addLog(`[Manual] Force ending stream for ${channel} and triggering stitching...`);
    const sessionData = { ...activeSession };
    await stopActiveDownload(channel);
    
    triggerFinalizeFlow(sessionData, channel);
    
    res.json({ success: true });
  });

  app.post("/api/recover-folder-video", async (req, res) => {
    try {
      const { folderPath } = req.body || {};
      if (!folderPath) {
        return res.status(400).json({ error: "folderPath is required" });
      }
      const resolved = path.resolve(folderPath);
      if (!fs.existsSync(resolved)) {
        return res.status(404).json({ error: `Folder not found: ${resolved}` });
      }

      addLog(`[Recovery] Triggered manual folder video recovery for: ${resolved}`);
      const taskId = `recovery_${Date.now()}`;
      updateTask(taskId, `Recovering Video (${path.basename(resolved)})`, "Scanning and stitching valid chunks...", "running");

      stitchVideoChunks(resolved, 'all', taskId)
        .then((outputs) => {
          updateTask(taskId, `Recovery Complete (${path.basename(resolved)})`, "Successfully stitched video segments.", "success", false, [{ label: "Dismiss", value: "dismiss" }]);
          addLog(`[Recovery] Manual recovery successful for ${resolved}. Outputs: ${outputs.join(', ')}`);
        })
        .catch((err) => {
          updateTask(taskId, `Recovery Failed (${path.basename(resolved)})`, err.message, "error", true, [{ label: "Close", value: "dismiss" }]);
          addLog(`[Recovery Error] Manual video recovery failed for ${resolved}: ${err.message}`);
        });

      res.json({ success: true, taskId, folderPath: resolved });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/channels/splice-game", async (req, res) => {
    try {
      const { channel, action, clipScope, clipMinutes } = req.body;
      if (!channel) return res.status(400).json({ error: "Channel is required" });
      const result = await manualSpliceGame(channel, { action, clipScope, clipMinutes: Number(clipMinutes) });
      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/channels/override-buffer", async (req, res) => {
    try {
      const { channel, gameIndex } = req.body;
      if (!channel) return res.status(400).json({ error: "Channel is required" });
      const result = await overrideGameSwitchBuffer(channel, gameIndex);
      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/tasks/:taskId/chat-files', (req, res) => {
    const { taskId } = req.params;
    const task = state.activeTasks[taskId];
    if (!task || !task.folderPath) return res.json({ files: [] });
    try {
      if (fs.existsSync(task.folderPath)) {
        const files = fs.readdirSync(task.folderPath);
        const jsonFiles = files.filter(f => f.endsWith('.json') && !f.startsWith('session_'));
        return res.json({ files: jsonFiles });
      }
    } catch (e) {}
    res.json({ files: [] });
  });

  app.post('/api/tasks/dismiss-completed', (req, res) => {
    let count = 0;
    for (const [id, task] of Object.entries(state.activeTasks)) {
      if (task.status === 'success' || (!task.actionRequired && task.status !== 'running') || (task.actions && task.actions.some(a => a.value === 'dismiss') && task.status !== 'running')) {
        removeTask(id);
        count++;
      }
    }
    return res.json({ success: true, count });
  });

  app.post('/api/tasks/:taskId/action', (req, res) => {
    const { taskId } = req.params;
    const { action } = req.body;
    const task = state.activeTasks[taskId];
    
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    if (taskId.startsWith('prompt_backfill_')) {
      if (action === 'backfill_full' || action === 'yes') {
        addLog(`[Backfill] User accepted Full VOD & Chat backfill.`);
        const chatPromise = resolveLiveChatBackfill(task.channelLogin!, 'full', 0).catch(err => {
          addLog(`[Chat Backfill Error] ${err.message}`);
        });
        if (state.activeDownloadSessions[task.channelLogin!]) {
          state.activeDownloadSessions[task.channelLogin!].activeChatBackfillPromise = chatPromise;
        }
        backfillVod(task.channelLogin!, task.streamId!, task.folderPath!, {
          mode: 'full',
          chapters: task.chapters
        }).catch(err => {
          addLog(`[Backfill] Unhandled error: ${err.message}`);
        });
        removeTask(taskId);
      } else if (action === 'backfill_current_game') {
        const bufferMins = (state.config.gameSwitchBufferMins ?? 5);
        const bufferSec = bufferMins * 60;
        const rawOffset = task.chapterRawStartOffset ?? task.currentGameStartOffset ?? 0;
        const finalStartOffset = task.currentGameStartOffset ?? Math.max(0, rawOffset - bufferSec);

        addLog(`[Backfill] User accepted Current Game Only backfill (${task.currentGameName || 'Current Game'}) from ${formatTimestamp(finalStartOffset)} (${bufferMins}m buffer applied).`);
        const chatPromise = resolveLiveChatBackfill(task.channelLogin!, 'current_game', finalStartOffset, task.currentGameName).catch(err => {
          addLog(`[Chat Backfill Error] ${err.message}`);
        });
        if (state.activeDownloadSessions[task.channelLogin!]) {
          state.activeDownloadSessions[task.channelLogin!].activeChatBackfillPromise = chatPromise;
        }
        backfillVod(task.channelLogin!, task.streamId!, task.folderPath!, {
          mode: 'current_game',
          startOffsetSec: finalStartOffset,
          gameName: task.currentGameName
        }).catch(err => {
          addLog(`[Backfill] Unhandled error: ${err.message}`);
        });
        removeTask(taskId);
      } else if (action === 'backfill_none' || action === 'no' || action === 'dismiss') {
        addLog(`[Backfill] User chose No Backfill. Continuing live recording.`);
        resolveLiveChatBackfill(task.channelLogin!, 'none', 0).catch(err => {
          addLog(`[Chat Backfill Error] ${err.message}`);
        });
        removeTask(taskId);
      }
      return res.json({ success: true });
    }

    if (taskId.startsWith('prompt_resume_gap_')) {
      const channel = task.channelLogin || '';
      if (action === 'resume_stitch_gap') {
        executeResumeStitchGap(channel).catch(err => {
          addLog(`[Recovery Error] ${err.message}`);
        });
      } else {
        // Option 2 (resume_vod_backfill or dismiss/default)
        executeResumeVodBackfill(channel, task.preGapHighestSeq, task.resumptionSeq).catch(err => {
          addLog(`[Recovery Error] ${err.message}`);
        });
      }
      removeTask(taskId);
      return res.json({ success: true });
    }

    if (action === 'manual_splice_now') {
      const channel = task.channelLogin || (task.folderPath ? path.basename(path.dirname(task.folderPath)) : '');
      if (channel) {
        manualSpliceGame(channel).then(() => {
          addLog(`[Manual Splice] Spliced game segment successfully.`);
        }).catch(err => {
          addLog(`[Manual Splice Error] ${err.message}`);
        });
      }
      removeTask(taskId);
      return res.json({ success: true });
    }

    if (taskId.startsWith('chat_') && action === 'cancel') {
      task.cancelled = true;
      return res.json({ success: true });
    }

    if (action === 'open_folder') {
      const folderToOpen = task.folderPath || getResolvedSavePath();
      openFolderInOs(folderToOpen).then((result) => {
        if (!result.success) {
          addLog(`[Explorer] Could not open folder for task ${taskId}: ${result.error}`);
        }
      });
      return res.json({ success: true, folderPath: folderToOpen });
    }

    if (action === 'retry_stitch') {
      if (!task.folderPath) {
        return res.status(400).json({ error: "Task is missing folder path" });
      }
      const newTaskId = `stitch_${Date.now()}`;
      updateTask(newTaskId, "Stitching Video", "Scanning sequence files...", "running", false, undefined);
      if (state.activeTasks[newTaskId]) {
        state.activeTasks[newTaskId].games = task.games;
        state.activeTasks[newTaskId].chatFilePath = task.chatFilePath;
        state.activeTasks[newTaskId].videoDurationSeconds = task.videoDurationSeconds;
        state.activeTasks[newTaskId].folderPath = task.folderPath;
        state.activeTasks[newTaskId].channelLogin = task.channelLogin;
      }
      stitchVideoChunks(task.folderPath, 'live', newTaskId).then(() => {
        updateTask(newTaskId, "Stitching Video", "Stitching Complete.", "success", false, [{ label: "Close", value: "dismiss" }]);
      }).catch(err => {
        addLog(`[Stitch] Unhandled error during retry stitch: ${err.message}`);
      });
      removeTask(taskId); // Remove the error task, stitchVideoChunks will use newTaskId
      return res.json({ success: true });
    }

    if (action === 'dismiss') {
      removeTask(taskId);
      return res.json({ success: true });
    }

    if (action === 'download_vod_chat') {
      if (!task.folderPath || !task.channelLogin) {
        return res.status(400).json({ error: "Task is missing folder path or channel login" });
      }
      downloadVodChat(task.channelLogin, task.folderPath).catch(err => {
        addLog(`[Chat] Unhandled error downloading VOD chat: ${err.message}`);
      });
      return res.json({ success: true });
    }

    if (action === 'render_chat') {
      if (!task.folderPath || !task.channelLogin) {
        return res.status(400).json({ error: "Task is missing folder path or channel login" });
      }

      const fallbackW = (state.config.chatRender && state.config.chatRender.width) || 350;
      const fallbackH = (state.config.chatRender && state.config.chatRender.height) || 800;

      const sanitizeDimension = (val: any, fallback: number): number => {
        const parsed = parseInt(String(val), 10);
        if (isNaN(parsed) || parsed < 100 || parsed > 7680) return fallback;
        return parsed;
      };

      const sanitizeFilename = (fn: any): string => {
        if (typeof fn !== 'string') return '';
        return path.basename(fn.trim()).replace(/[^a-zA-Z0-9._-]/g, '');
      };

      const { segments, width, height } = req.body;
      if (segments !== undefined) {
        if (!Array.isArray(segments) || segments.length === 0) {
          return res.status(400).json({ error: "segments must be a non-empty array" });
        }
        const sanitizedSegments = segments.map((s: any) => ({
          filename: sanitizeFilename(s?.filename),
          width: sanitizeDimension(s?.width, fallbackW),
          height: sanitizeDimension(s?.height, fallbackH)
        }));

        startChatRenderMultiple(task.channelLogin, task.folderPath, sanitizedSegments).catch(err => {
          addLog(`[Render] Unhandled error: ${err.message}`);
        });
      } else {
        const validW = sanitizeDimension(width, fallbackW);
        const validH = sanitizeDimension(height, fallbackH);

        startChatRenderMultiple(task.channelLogin, task.folderPath, [{ filename: '', width: validW, height: validH }]).catch(err => {
          addLog(`[Render] Unhandled error: ${err.message}`);
        });
      }
      return res.json({ success: true });
    }

    if (action === 'cancel_render' || (action === 'cancel' && taskId.startsWith('render_'))) {
      abortChatProcess(taskId);
      return res.json({ success: true });
    }

    res.status(400).json({ error: "Unknown task action" });
  });

  app.post("/api/render/manual", async (req, res) => {
    const { filePath, width, height } = req.body;
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: "File path is required" });
    }

    let trimmedPath = filePath.trim().replace(/^["']|["']$/g, ''); // strip any wrapping quotes
    const baseSavePath = getResolvedSavePath();

    // Auto-heal legacy path containing NewDownloader
    if (trimmedPath.toLowerCase().includes("newdownloader")) {
      const afterDownloads = trimmedPath.replace(/^.*?[\\/]downloads[\\/]?/i, '');
      trimmedPath = path.join(baseSavePath, afterDownloads);
    }
    
    // Check direct path first
    if (!fs.existsSync(trimmedPath)) {
      // If relative, check against PROJECT_ROOT and baseSavePath
      if (!path.isAbsolute(trimmedPath)) {
        const rootCombined = path.resolve(PROJECT_ROOT, trimmedPath);
        const saveCombined = path.resolve(baseSavePath, trimmedPath);
        if (fs.existsSync(rootCombined)) {
          trimmedPath = rootCombined;
        } else if (fs.existsSync(saveCombined)) {
          trimmedPath = saveCombined;
        }
      }

      if (!fs.existsSync(trimmedPath) && fs.existsSync(baseSavePath)) {
        // Try searching one level deep in subdirectories of savePath
        try {
          const subEntries = fs.readdirSync(baseSavePath, { withFileTypes: true });
          let found = false;
          for (const sub of subEntries) {
            if (sub.isDirectory()) {
              const subCombined = path.join(baseSavePath, sub.name, path.basename(trimmedPath));
              if (fs.existsSync(subCombined)) {
                trimmedPath = subCombined;
                found = true;
                break;
              }
            }
          }
          if (!found) {
            return res.status(404).json({ error: `File not found: "${trimmedPath}". Please check that the file exists.` });
          }
        } catch (e) {
          return res.status(404).json({ error: `File not found: "${trimmedPath}"` });
        }
      } else if (!fs.existsSync(trimmedPath)) {
        return res.status(404).json({ error: `File not found: "${trimmedPath}". Please verify that the file exists.` });
      }
    }

    if (!trimmedPath.toLowerCase().endsWith('.json')) {
      return res.status(400).json({ error: "Only .json chat files are supported" });
    }

    const customWidth = width ? parseInt(String(width), 10) : undefined;
    const customHeight = height ? parseInt(String(height), 10) : undefined;

    // Start render in background task
    startManualChatRender(trimmedPath, customWidth, customHeight).catch(err => {
      addLog(`[Manual Render] Error: ${err?.stack || err?.message || err}`);
    });

    res.json({ success: true, message: `Manual chat render started for ${path.basename(trimmedPath)}` });
  });

  app.post("/api/start", (req, res) => {
    const requestedChannels = req.body.channels;
    const singleChannel = req.body.channel;

    if (singleChannel) {
      const cleaned = cleanChannelName(singleChannel);
      if (!cleaned) return res.status(400).json({ error: "Invalid channel name" });

      if (!state.monitoredChannels.some(c => cleanChannelName(c) === cleaned)) {
        if (state.monitoredChannels.length >= 2) {
          return res.status(400).json({ error: "Maximum 2 monitored channels allowed. Stop an active stream first." });
        }
        state.monitoredChannels.push(cleaned);
      }
      state.config.isMonitoring = state.monitoredChannels.length > 0;
      startMonitoring();
      addLog(`Started monitoring channel: @${cleaned}`);
      return res.json({ status: "ok", monitoredChannels: state.monitoredChannels });
    }

    const targetChannels = (requestedChannels && requestedChannels.length > 0) ? requestedChannels : state.config.channels;
    if (!targetChannels || targetChannels.length === 0) return res.status(400).json({ error: "At least one channel required" });

    const cleanedTargets: string[] = Array.from(new Set<string>((targetChannels || []).map((c: string) => cleanChannelName(c)).filter(Boolean)));
    if (cleanedTargets.length > 2) return res.status(400).json({ error: "Maximum 2 channels allowed" });

    state.config.isMonitoring = true;
    state.monitoredChannels = cleanedTargets;
    startMonitoring();
    addLog(`Started monitoring channels: ${state.monitoredChannels.join(', ')}`);
    res.json({ status: "ok", monitoredChannels: state.monitoredChannels });
  });

  app.post("/api/stop", async (req, res) => {
    const singleChannel = req.body.channel;

    if (singleChannel) {
      const cleaned = cleanChannelName(singleChannel);
      state.monitoredChannels = state.monitoredChannels.filter(c => cleanChannelName(c) !== cleaned);
      state.config.isMonitoring = state.monitoredChannels.length > 0;
      if (state.monitoredChannels.length === 0) {
        stopMonitoringTimer();
      }

      const matchingKey = Object.keys(state.activeDownloadSessions).find(k => cleanChannelName(k) === cleaned);
      if (matchingKey) {
        const activeSession = state.activeDownloadSessions[matchingKey];
        if (activeSession) {
          addLog(`Stopped monitoring for @${cleaned}. Triggering background tasks (chat & stitching)...`);
          const sessionData = { ...activeSession };
          await stopActiveDownload(matchingKey);
          triggerFinalizeFlow(sessionData, cleaned);
        }
      } else {
        addLog(`Stopped monitoring for @${cleaned}`);
      }
      return res.json({ status: "ok", monitoredChannels: state.monitoredChannels });
    }

    state.config.isMonitoring = false;
    stopMonitoringTimer();
    
    const sessionKeys = Object.keys(state.activeDownloadSessions);
    if (sessionKeys.length > 0) {
      addLog("Stopped monitoring. Triggering background tasks (chat & stitching)...");
      for (const key of sessionKeys) {
        const session = state.activeDownloadSessions[key];
        if (session) {
          const sessionData = { ...session };
          await stopActiveDownload(key);
          triggerFinalizeFlow(sessionData, sessionData.channel);
        }
      }
    } else {
      addLog("Stopped monitoring");
    }
    state.monitoredChannels = [];
    res.json({ status: "ok" });
  });

  app.post("/api/reset", async (req, res) => {
    try {
      addLog("[Panic Reset] Initiating emergency program reboot. Terminating all active processes and tasks...");

      // 1. Immediately halt stream monitoring loop
      state.config.isMonitoring = false;
      stopMonitoringTimer();

      // 2. Abort all FFmpeg video stitching processes immediately
      abortAllFfmpegProcesses();

      // 3. Abort all TwitchDownloader CLI chat rendering processes immediately
      abortAllChatProcesses();

      // 4. Cancel all active background tasks so running loops exit immediately
      for (const task of Object.values(state.activeTasks)) {
        task.cancelled = true;
        task.status = 'cancelled';
      }

      // 5. Safely stop and seal all active live download sessions to preserve valid JSON on disk
      const activeChannels = Object.keys(state.activeDownloadSessions);
      await Promise.all(activeChannels.map(channel => stopActiveDownload(channel).catch(err => {
        addLog(`[Reset] Error stopping session for ${channel}: ${err.message}`);
      })));

      // 6. Clear in-memory state
      state.activeTasks = {};
      state.logs = [];
      state.monitoredChannels = [];

      // 7. Flush state synchronously to state.json to avoid ghost restorations
      flushStateSync();

      addLog("[Panic Reset] Program reboot complete. All background tasks, FFmpeg renders, and recordings terminated.");
      res.json({ status: "ok" });
    } catch (err: any) {
      addLog(`[Panic Reset Error] ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

}
