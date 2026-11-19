import fs from "fs";
import path from "path";
import axios from "axios";
import checkDiskSpace from "check-disk-space";
import { Parser } from "m3u8-parser";
import { ActiveDownloadSession, SessionGame, CaptureMode } from "../types";
import { state, addLog, updateTask, removeTask, scheduleStateSave, cleanChannelName, PROJECT_ROOT, getResolvedSavePath, getChatRenderDimensionsForChatFile } from "./state";
import { 
  twitchAxios, 
  fetchChannelStreamStatus, 
  checkChannelStreamId, 
  checkLiveStreamFallback,
  getSourceMediaPlaylistUrl, 
  inspectMp4InitBuffer
} from "./twitch";
import { startLiveChatDownload, startChatRenderMultiple, flushPendingChatWrites } from "./chat";
import { sealMasterChatFileFromJournal, hasChatSource } from "./chatCompiler";
import {
  updateSessionManifest,
  appendSegmentTimelineEntry,
  computeChunkCountForDuration,
  getSignedElapsedDurationBetweenChunks,
  getAverageSegmentDuration,
  clearSessionManifestMemoryCache,
} from "./sessionManifest";
import { enqueueCompilationJob } from "./video";
import { backfillVod, promptMidStreamVodBackfill } from "./vodBackfill";
import { emitSessionsDelta } from "./eventBus";

export { backfillVod, promptMidStreamVodBackfill };

export const DISK_WARNING_THRESHOLD_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB
export const DISK_CRITICAL_THRESHOLD_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
const DISK_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export async function queryFreeDiskBytes(targetPath: string): Promise<number | null> {
  try {
    const checkPath = fs.existsSync(targetPath) ? targetPath : getResolvedSavePath();
    const target = fs.existsSync(checkPath) ? checkPath : PROJECT_ROOT;
    const diskPromise = checkDiskSpace(target);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout querying disk space")), 2500)
    );
    const res = await Promise.race([diskPromise, timeoutPromise]);
    if (res && typeof res.free === "number") {
      return res.free;
    }
  } catch {
    try {
      if (typeof (fs.promises as any).statfs === "function") {
        const checkPath = fs.existsSync(targetPath) ? targetPath : PROJECT_ROOT;
        const stats = await (fs.promises as any).statfs(checkPath);
        if (stats && typeof stats.bavail === "number" && typeof stats.bsize === "number") {
          return stats.bavail * stats.bsize;
        }
      }
    } catch {}
  }
  return null;
}

let monitoringTimeout: NodeJS.Timeout | null = null;
let isCheckingStatus = false;

export function stopMonitoringTimer() {
  if (monitoringTimeout) {
    clearTimeout(monitoringTimeout);
    monitoringTimeout = null;
  }
}

export function setMonitoringInterval(timer: NodeJS.Timeout | null) {
  stopMonitoringTimer();
  monitoringTimeout = timer;
}

export function getMonitoringInterval() {
  return monitoringTimeout;
}

const initFailureCooldowns: Record<string, number> = {};

async function downloadSegmentWithRetry(urlOrGetter: string | (() => string), timeoutMs = 8000, retries = 2) {
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const targetUrl = typeof urlOrGetter === "function" ? urlOrGetter() : urlOrGetter;
    try {
      return await axios.get(targetUrl, { responseType: "arraybuffer", timeout: timeoutMs });
    } catch (err: any) {
      lastErr = err;
      const status = err.response?.status;
      const isRetryable =
        !status ||
        status === 429 ||
        status === 403 ||
        status === 404 ||
        (status >= 500 && status < 600) ||
        err.code === "ECONNABORTED" ||
        err.code === "ETIMEDOUT" ||
        err.code === "ECONNRESET";
      if (attempt < retries && isRetryable) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

export function formatTimestamp(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function getGameRelativeTimestampInfo(session: ActiveDownloadSession, seqNum: number): { gameName: string; timestamp: string } {
  if (session.games && session.games.length > 0) {
    const bufferMins = state.config.gameSwitchBufferMins ?? 5;
    const bufferSec = bufferMins * 60;
    
    // Find which game segment contains this chunk
    let gameIdx = session.games.length - 1;
    for (let i = 0; i < session.games.length; i++) {
      const nextG = session.games[i + 1];
      if (nextG) {
        const nextLeadChunks = nextG.overrideBuffer
          ? 0
          : computeChunkCountForDuration(session.folderPath, nextG.startChunk, bufferSec, 'backward');
        const nextStart = Math.max(0, nextG.startChunk - nextLeadChunks);
        if (seqNum < nextStart) {
          gameIdx = i;
          break;
        }
      } else {
        gameIdx = i;
      }
    }

    const targetGame = session.games[gameIdx];
    const targetLeadChunks = targetGame.overrideBuffer
      ? 0
      : computeChunkCountForDuration(session.folderPath, targetGame.startChunk, bufferSec, 'backward');
    const gameStartChunk = gameIdx === 0
      ? (targetGame.startChunk > 0 ? targetGame.startChunk : (session.firstSeqNum || 0))
      : Math.max(0, targetGame.startChunk - targetLeadChunks);
    
    const gameOffsetSec = Math.max(
      0,
      Math.round(getSignedElapsedDurationBetweenChunks(session.folderPath, gameStartChunk, seqNum))
    );
    return {
      gameName: targetGame.gameName || "Unknown Game",
      timestamp: formatTimestamp(gameOffsetSec)
    };
  }

  return {
    gameName: session.currentGame || "Current Game",
    timestamp: formatTimestamp(session.videoDurationSeconds || 0)
  };
}


export async function checkOrphanedSession(savedSession: any) {
    try {
      const channel = savedSession.channel;

      // If user moved or deleted the session's download folder, attempt re-anchoring before discarding
      if (savedSession.folderPath) {
        if (!fs.existsSync(savedSession.folderPath)) {
          const folderBase = path.basename(savedSession.folderPath);
          const reanchored = path.join(getResolvedSavePath(), folderBase);
          if (fs.existsSync(reanchored)) {
            savedSession.folderPath = reanchored;
            if (savedSession.chatFilePath) {
              savedSession.chatFilePath = path.join(reanchored, path.basename(savedSession.chatFilePath));
            }
            if (savedSession.commentsJournalPath) {
              savedSession.commentsJournalPath = path.join(reanchored, path.basename(savedSession.commentsJournalPath));
            }
          }
        }
        if (!fs.existsSync(savedSession.folderPath)) {
          addLog(`[Recovery] Session download folder ${savedSession.folderPath} does not exist (deleted by user). Discarding session for ${channel}.`);
          delete state.activeDownloadSessions[channel];
          scheduleStateSave();
          return;
        }
      }

      let stream: any = null;
      let isGqlFailed = false;

      try {
        const gqlResponse = await checkChannelStreamId(channel);
        if (gqlResponse.data?.errors && (!gqlResponse.data?.data?.user)) {
          isGqlFailed = true;
        } else {
          stream = gqlResponse.data?.data?.user?.stream;
        }
      } catch (e: any) {
        isGqlFailed = true;
      }

      if (isGqlFailed) {
        addLog(`[Recovery] Primary GQL status check degraded for orphaned session ${channel}. Testing Usher fallback...`);
        const fallback = await checkLiveStreamFallback(channel);
        if (fallback.isLive === true) {
          stream = { id: fallback.streamId || savedSession.streamId };
        } else if (fallback.isLive === false) {
          stream = null;
        } else {
          addLog(`[Recovery] Status for orphaned session ${channel} could not be confirmed due to network outage. Leaving in limbo.`);
          return;
        }
      }

      if (!stream || stream.id !== savedSession.streamId) {
        addLog(`[Recovery] Found orphaned session for ${channel} from previous app run. Stream ended. Triggering final stitch...`);
        await stopActiveDownload(channel);
        triggerFinalizeFlow(savedSession, channel);
      } else {
        addLog(`[Recovery] Saved session for ${channel} is still LIVE. It will resume automatically on the next polling tick.`);
      }
    } catch (e) {
      addLog(`[Recovery] Failed to check status for orphaned session ${savedSession.channel}. It may remain in limbo.`);
    }
  }

export async function checkStreamStatus() {
    state.lastCheckTime = Date.now();
    if (!state.hasLoggedInitialCheck && state.monitoredChannels.length > 0) {
      addLog(`[System] Initial stream check started for: ${state.monitoredChannels.join(', ')}`);
      state.hasLoggedInitialCheck = true;
    }
    for (const channelLogin of state.monitoredChannels) {
      let stream: any = null;
      let userId: string = "";
      let isGqlFailed = false;
      let activeSession = state.activeDownloadSessions[channelLogin];

      // If the user moved or deleted the session's download folder, attempt re-anchoring before discarding
      if (activeSession && activeSession.folderPath) {
        if (!fs.existsSync(activeSession.folderPath)) {
          const folderBase = path.basename(activeSession.folderPath);
          const reanchored = path.join(getResolvedSavePath(), folderBase);
          if (fs.existsSync(reanchored)) {
            activeSession.folderPath = reanchored;
            if (activeSession.chatFilePath) {
              activeSession.chatFilePath = path.join(reanchored, path.basename(activeSession.chatFilePath));
            }
            if (activeSession.commentsJournalPath) {
              activeSession.commentsJournalPath = path.join(reanchored, path.basename(activeSession.commentsJournalPath));
            }
          }
        }
        if (!fs.existsSync(activeSession.folderPath)) {
          addLog(`[Session] Folder ${activeSession.folderPath} was deleted by user. Discarding stale session for ${channelLogin} to restart fresh.`);
          await stopActiveDownload(channelLogin);
          activeSession = undefined;
        }
      }

      try {
        const gqlResponse = await fetchChannelStreamStatus(channelLogin);

        if (gqlResponse.data?.errors && gqlResponse.data.errors.length > 0) {
          addLog(`[GQL Warning] Stream status check returned errors for ${channelLogin}: ${JSON.stringify(gqlResponse.data.errors)}`);
          if (!gqlResponse.data?.data?.user) {
            isGqlFailed = true;
          }
        }

        if (!isGqlFailed) {
          const user = gqlResponse.data?.data?.user;
          userId = user?.id || "";
          stream = user?.stream || null;
        }
      } catch (error: any) {
        const details = error.response?.data ? JSON.stringify(error.response.data) : "";
        addLog(`[GQL Error] Stream status request failed for ${channelLogin}: ${error.message} ${details}`);
        isGqlFailed = true;
      }

      // If GQL failed (outage, 503, timeout, service unavailable, or user subgraph error), invoke fallback verification!
      if (isGqlFailed) {
        addLog(`[Outage Protection] Primary GQL status check degraded for ${channelLogin}. Testing Usher & Playback Token fallback...`);
        const fallback = await checkLiveStreamFallback(channelLogin);

        if (fallback.isLive === true) {
          addLog(`[Outage Protection] Usher confirmed ${channelLogin} is LIVE! (Broadcast ID: ${fallback.streamId || 'unknown'})`);
          userId = fallback.channelId || (activeSession?.channel ? userId : "");
          stream = {
            id: fallback.streamId || activeSession?.streamId || `live_${Date.now()}`,
            type: "live",
            title: activeSession?.currentTitle || `Live Stream (${channelLogin})`,
            createdAt: new Date().toISOString(),
            viewersCount: activeSession?.viewersCount || 0,
            game: { name: activeSession?.currentGame || "Unknown" },
            previewImageURL: activeSession?.previewImageUrl || ""
          };
        } else if (fallback.isLive === false) {
          addLog(`[Outage Protection] Usher confirmed ${channelLogin} is offline.`);
          stream = null;
        } else {
          // Status unconfirmed due to total network or Twitch edge outage
          addLog(`[Outage Protection] Status for ${channelLogin} could not be confirmed (${fallback.error || 'network error'}). Preserving session state.`);
          if (activeSession) {
            // DO NOT increment missingCount - server is having an outage!
            continue;
          }
          continue;
        }
      }

      if (stream) {
        const now = Date.now();
        if (!activeSession && initFailureCooldowns[channelLogin] && now < initFailureCooldowns[channelLogin]) {
          // Channel is in cooldown after failed media initialization; wait for cooldown to expire before re-attempting
          continue;
        }

        if (!activeSession) {
          addLog(`Stream is LIVE! Channel: ${channelLogin}, Title: ${stream.title}`);
          try {
            await startDownloadSession(channelLogin, stream, userId);
          } catch (sessionErr: any) {
            addLog(`[Session Error] Failed to initialize download session for ${channelLogin}: ${sessionErr.message}`);
          }
        } else if (activeSession.streamId !== stream.id) {
          // Stream ID changed! OBS disconnected and reconnected, Twitch assigned a new broadcast ID.
          addLog(`[Stream Change] Stream ID changed for ${channelLogin} from ${activeSession.streamId} to ${stream.id}. Triggering stitch of old session and starting new session...`);
          const sessionData = { ...activeSession };
          await stopActiveDownload(channelLogin);
          
          triggerFinalizeFlow(sessionData, channelLogin, sessionData.streamId);

          // Start the new session
          try {
            await startDownloadSession(channelLogin, stream, userId);
          } catch (sessionErr: any) {
            addLog(`[Session Error] Failed to start new download session for ${channelLogin}: ${sessionErr.message}`);
          }
        } else {
          // Restore playlist polling and chat ONLY if truly orphaned/uninitialized after an app restart
          // Never trigger if the session is actively polling or has polled within the last 45s
          const isStalled = !activeSession.playlistPollInterval && !activeSession.isPollingActive && (!activeSession.lastPollTimestampMs || (Date.now() - activeSession.lastPollTimestampMs > 45000));
          if (isStalled) {
            const sessionCaptureMode: CaptureMode = activeSession.captureMode || state.config.channelCaptureModes?.[cleanChannelName(channelLogin)] || 'both';
            activeSession.captureMode = sessionCaptureMode;
            addLog(`[Recovery] Re-initializing intervals for restored session: ${channelLogin} (mode: ${sessionCaptureMode})`);
            // Ensure folder exists on disk
            if (activeSession.folderPath && !fs.existsSync(activeSession.folderPath)) {
              await fs.promises.mkdir(activeSession.folderPath, { recursive: true }).catch(() => {});
            }
            if (sessionCaptureMode !== 'chat_only') {
              // Grab token again and await playlist refresh before scheduling poll
              await refreshMediaPlaylist(channelLogin).catch((err: any) => {
                addLog(`[Recovery Warning] Failed to refresh stalled playlist for ${channelLogin}: ${err.message}`);
              });
            }
            if (!activeSession.playlistPollInterval && !(activeSession as any).isStopped) {
              activeSession.playlistPollInterval = setTimeout(() => pollPlaylist(channelLogin), 2000) as any;
            }
            if (sessionCaptureMode !== 'video_only') {
              startLiveChatDownload(channelLogin, activeSession.folderPath, stream.id, userId || "", stream.createdAt || new Date().toISOString());
            }
          }

          // Reset missing count if stream is found
          if (activeSession.missingCount && activeSession.missingCount > 0) {
            addLog(`[Stream] Broadcast resumed for @${channelLogin}. Offline grace period cleared.`);
          }
          activeSession.missingCount = 0;
          activeSession.offlineDetectedAtMs = undefined;
          activeSession.playlistConsecutiveErrors = 0;
          
          const newGame = stream.game?.name || 'Unknown';
          if (activeSession.currentGame !== newGame && newGame !== 'Unknown') {
            const now = Date.now();
            if (!activeSession.games) activeSession.games = [];
            
            const lastGame = activeSession.games[activeSession.games.length - 1];
            
            if (lastGame && lastGame.isAwaitingNextGame) {
              const prevFallbackName = lastGame.gameName;
              lastGame.gameName = newGame;
              lastGame.isAwaitingNextGame = false;
              activeSession.currentGame = newGame;
              addLog(`[Game Change] Broadcaster updated category to "${newGame}". Assigned pending segment (started at chunk ${lastGame.startChunk}, fallback "${prevFallbackName}", ${lastGame.customLeadingBufferMins ?? (state.config.gameSwitchBufferMins ?? 5) * 2}m leading buffer) to "${newGame}".`);
              scheduleStateSave();
            } else {
              // Maintain max sequence number in memory during active session
              let maxChunk = activeSession.highestSeq > 0 ? activeSession.highestSeq : 0;
              if (maxChunk === 0 && fs.existsSync(activeSession.folderPath)) {
                try {
                  const entries = await fs.promises.readdir(activeSession.folderPath, { withFileTypes: true });
                  const chunkFiles = entries.filter(e => e.isFile() && e.name.startsWith('seq_') && e.name.endsWith('.ts')).map(e => e.name);
                  if (chunkFiles.length > 0) {
                    maxChunk = Math.max(...chunkFiles.map(f => parseInt(f.replace('seq_', '').replace('.ts', ''))).filter(n => !isNaN(n)));
                  }
                } catch (e) {}
              }
              
              // Lock the chat's time offset directly to the exact accumulated video duration to prevent drift
              const timeOffsetSeconds = Math.floor(activeSession.videoDurationSeconds || 0);

              if (lastGame && !lastGame.isTimeSplice && (now - lastGame.startTimeMs) < 3 * 60 * 1000) {
                // Current game lasted < 3 mins. Absorb it.
                addLog(`[Game Change] "${lastGame.gameName}" lasted less than 3 mins. Absorbing into previous game...`);
                activeSession.games.pop();

                const previousGame = activeSession.games[activeSession.games.length - 1];
                if (!previousGame || previousGame.gameName !== newGame) {
                  activeSession.games.push({
                    gameName: newGame,
                    startChunk: maxChunk,
                    startTimeOffset: timeOffsetSeconds,
                    startTimeMs: now
                  });
                }
              } else {
                // Valid game change
                const splitLabel = activeSession.captureMode === 'video_only'
                  ? 'Video split'
                  : activeSession.captureMode === 'chat_only'
                  ? 'Chat split'
                  : 'Video/Chat split';
                addLog(`[Game Change] Detected switch to "${newGame}". Logging boundary for ${splitLabel}.`);
                activeSession.games.push({
                  gameName: newGame,
                  startChunk: maxChunk,
                  startTimeOffset: timeOffsetSeconds,
                  startTimeMs: now
                });
              }
              activeSession.currentGame = newGame;
              scheduleStateSave();
            }
          }

          // Update rich metadata
          if (stream.viewersCount) activeSession.viewersCount = stream.viewersCount;
          if (stream.previewImageURL) activeSession.previewImageUrl = stream.previewImageURL;
          // Check for title change
          if (stream.title && activeSession.currentTitle !== stream.title) {
            activeSession.currentTitle = stream.title;
            const titlesPath = path.join(activeSession.folderPath, "Broadcast Titles.txt");
            fs.promises.appendFile(titlesPath, `[${new Date().toLocaleTimeString()}] ${stream.title}\n`).catch(() => {});
            addLog(`Stream title changed (${channelLogin}): ${stream.title}`);
          }
        }
      } else if (!stream && activeSession) {
        if (!activeSession.offlineDetectedAtMs) {
          activeSession.offlineDetectedAtMs = Date.now();
        }
        activeSession.missingCount = (activeSession.missingCount || 0) + 1;
        
        const graceMins = (state.config.offlineGracePeriodMins !== undefined && state.config.offlineGracePeriodMins >= 1)
          ? state.config.offlineGracePeriodMins
          : 5;
        // checkStreamStatus runs every 15s -> 4 checks per minute
        const maxGraceChecks = Math.max(2, Math.round((graceMins * 60) / 15));

        if (activeSession.missingCount === 1) {
          addLog(`[Stream] Stream offline detected for @${channelLogin}. Entering ${graceMins}m grace period before automatic finalization...`);
        } else if (activeSession.missingCount % 4 === 0 && activeSession.missingCount < maxGraceChecks) {
          const remainingMins = Math.max(1, Math.round((maxGraceChecks - activeSession.missingCount) * 15 / 60));
          addLog(`[Stream] Stream offline for @${channelLogin} (${remainingMins}m grace period remaining before finalization)...`);
        }

        if (activeSession.missingCount >= maxGraceChecks) {
          const finalizeDesc = activeSession.captureMode === 'video_only'
            ? 'video stitching'
            : activeSession.captureMode === 'chat_only'
            ? 'chat slicing'
            : 'video stitching & chat slicing';
          addLog(`[Stream] Stream @${channelLogin} exceeded ${graceMins}m grace period. Concluding broadcast and triggering finalization (${finalizeDesc})...`);
          const sessionData = { ...activeSession };
          await stopActiveDownload(channelLogin);
          
          triggerFinalizeFlow(sessionData, channelLogin);
        }
      }
    }
    emitSessionsDelta();
  }

  export function startMonitoring() {
    state.hasLoggedInitialCheck = false;
    stopMonitoringTimer();

    const scheduleNextCheck = () => {
      if (!state.config.isMonitoring) return;
      monitoringTimeout = setTimeout(async () => {
        if (!state.config.isMonitoring) return;
        if (isCheckingStatus) {
          scheduleNextCheck();
          return;
        }
        isCheckingStatus = true;
        try {
          await checkStreamStatus();
        } catch (err: any) {
          addLog(`[Monitoring] Unexpected error in checkStreamStatus: ${err.message}`);
        } finally {
          isCheckingStatus = false;
          if (state.config.isMonitoring) {
            scheduleNextCheck();
          }
        }
      }, 15000);
    };

    // Run once immediately, then schedule next
    (async () => {
      isCheckingStatus = true;
      try {
        await checkStreamStatus();
      } catch (err: any) {
        addLog(`[Monitoring] Unexpected error in initial checkStreamStatus: ${err.message}`);
      } finally {
        isCheckingStatus = false;
        if (state.config.isMonitoring) {
          scheduleNextCheck();
        }
      }
    })();
  }

  export async function startDownloadSession(channelLogin: string, stream: any, twitchId: string) {
    const streamId = stream.id;
    const createdAt = stream.createdAt ? new Date(stream.createdAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    const folderName = `${channelLogin}_${createdAt}_${streamId}`;

    let targetSavePath = getResolvedSavePath();
    try {
      if (!fs.existsSync(targetSavePath)) {
        await fs.promises.mkdir(targetSavePath, { recursive: true });
      }
    } catch (savePathErr: any) {
      addLog(`[Session] Warning: Could not create configured savePath "${targetSavePath}" (${savePathErr.message}). Falling back to project downloads folder.`);
      targetSavePath = getResolvedSavePath("downloads");
      try {
        if (!fs.existsSync(targetSavePath)) {
          await fs.promises.mkdir(targetSavePath, { recursive: true });
        }
      } catch (fbErr: any) {
        addLog(`[Session] Critical: Failed to create fallback directory "${targetSavePath}": ${fbErr.message}`);
      }
      state.config.savePath = "downloads";
      scheduleStateSave();
    }

    // Pre-flight storage capacity check (< 20 GB warning, < 5 GB critical abort)
    const preflightFreeBytes = await queryFreeDiskBytes(targetSavePath);
    if (preflightFreeBytes !== null) {
      const freeGb = (preflightFreeBytes / (1024 * 1024 * 1024)).toFixed(2);
      if (preflightFreeBytes < DISK_CRITICAL_THRESHOLD_BYTES) {
        initFailureCooldowns[channelLogin] = Date.now() + 60000;
        addLog(`[Storage Safety] CRITICAL: Free disk space (${freeGb} GB) is below the 5 GB safety threshold. Aborting session initialization for @${channelLogin} to prevent disk exhaustion.`);
        return;
      } else if (preflightFreeBytes < DISK_WARNING_THRESHOLD_BYTES) {
        addLog(`[Storage Safety] WARNING: Low disk space (${freeGb} GB remaining, < 20 GB threshold) while starting recording session for @${channelLogin}.`);
      }
    }

    const folderPath = path.join(targetSavePath, folderName);

    let downloadedSegments = new Set<string | number>();
    let currentChunkIndex = 0;
    let liveChunksCount = 0;

    if (fs.existsSync(folderPath)) {
      addLog(`[Session] Resuming existing session for stream ${streamId}`);
      
      const dirEntries = await fs.promises.readdir(folderPath, { withFileTypes: true });
      const files = dirEntries.filter(e => e.isFile()).map(e => e.name);
      const chunkFiles = files.filter(f => f.endsWith('.ts'));
      chunkFiles.forEach(f => {
         if (f.startsWith('seq_')) {
            const seq = parseInt(f.replace('seq_', '').replace('.ts', ''), 10);
            if (!isNaN(seq)) downloadedSegments.add(seq);
         } else if (f.startsWith('vod_seq_')) {
            const seq = parseInt(f.replace('vod_seq_', '').replace('.ts', ''), 10);
            if (!isNaN(seq)) downloadedSegments.add(`vod_${seq}`);
         }
      });

      const chunkFilesList = files.filter(f => f.startsWith('seq_') && f.endsWith('.ts'));
      liveChunksCount = chunkFilesList.length;
      if (chunkFilesList.length > 0) {
        const indices = chunkFilesList.map(f => parseInt(f.replace('seq_', '').replace('.ts', ''))).filter(n => !isNaN(n));
        if (indices.length > 0) {
          currentChunkIndex = Math.max(...indices);
        }
      }
    } else {
      try {
        await fs.promises.mkdir(folderPath, { recursive: true });
      } catch (err: any) {
        addLog(`[Session] Failed to create stream folder ${folderPath}: ${err.message}`);
        throw err;
      }
    }


    const titlesPath = path.join(folderPath, "Broadcast Titles.txt");
    await fs.promises.appendFile(titlesPath, `[${new Date().toLocaleTimeString()}] ${stream.title}\n`);

    const segmentsFile = path.join(folderPath, "failed_segments.txt");

    const streamCreatedAtMs = stream.createdAt ? new Date(stream.createdAt).getTime() : Date.now();
    // Always anchor videoStartTimeMs to the broadcast start time (streamCreatedAtMs)
    // so timeline offsets (live chat, VOD backfill, and game slices) are consistently referenced to broadcast start
    const videoStartTimeMs = streamCreatedAtMs;
    const captureMode: CaptureMode = state.config.channelCaptureModes?.[cleanChannelName(channelLogin)] || 'both';

    const elapsedSecAtInit = Math.max(0, Math.floor((Date.now() - streamCreatedAtMs) / 1000));
    const chatOnlyJoinOffsetSec = elapsedSecAtInit < 60 ? 0 : elapsedSecAtInit;
    const chatOnlyInitChunk = Math.floor(chatOnlyJoinOffsetSec / 2);

    const resumeStartOffsetSec = captureMode === 'chat_only'
      ? chatOnlyJoinOffsetSec
      : Math.max(0, Math.round(getSignedElapsedDurationBetweenChunks(folderPath, 0, currentChunkIndex)));

    state.activeDownloadSessions[channelLogin] = {
      channel: channelLogin,
      streamId: streamId,
      twitchId: twitchId,
      startTime: new Date().toISOString(),
      streamCreatedAtMs: streamCreatedAtMs,
      initialJoinOffsetSec: captureMode === 'chat_only' ? chatOnlyJoinOffsetSec : undefined,
      firstSeqNum: captureMode === 'chat_only' ? chatOnlyInitChunk : undefined,
      videoDurationSeconds: captureMode === 'chat_only' ? chatOnlyJoinOffsetSec : undefined,
      chunksDownloaded: liveChunksCount, // Exclusively count live seq_*.ts segments (never vod_seq_*.ts)
      folderPath: folderPath,
      segmentsFile: segmentsFile,
      currentTitle: stream.title,
      currentGame: stream.game?.name || 'Unknown',
      viewersCount: stream.viewersCount || 0,
      previewImageUrl: stream.previewImageURL || '',
      games: [{
        gameName: stream.game?.name || 'Unknown',
        startChunk: captureMode === 'chat_only' ? chatOnlyInitChunk : currentChunkIndex,
        startTimeOffset: resumeStartOffsetSec,
        startTimeMs: streamCreatedAtMs
      }],
      downloadedSegments: downloadedSegments,
      mediaPlaylistUrl: "",
      playlistPollInterval: null,
      isRefreshingPlaylist: false,
      highestSeq: captureMode === 'chat_only' ? chatOnlyInitChunk : (currentChunkIndex > 0 ? currentChunkIndex : -1),
      videoStartTimeMs: videoStartTimeMs,
      commentsWritten: 0,
      autoRenderChat: state.config.channelAutoRender?.[channelLogin] ?? state.config.autoRenderChat ?? false,
      captureMode
    };

    await updateSessionManifest(folderPath, {
      channelLogin,
      twitchId: parseInt(twitchId || "0", 10) || 0,
      streamId,
      title: stream.title || "",
      streamCreatedAtMs,
      videoStartTimeMs,
      initialJoinOffsetSec: captureMode === "chat_only" ? chatOnlyJoinOffsetSec : 0,
      firstSeqNum: captureMode === "chat_only" ? chatOnlyInitChunk : undefined,
      captureMode,
    });

    scheduleStateSave();

    if (captureMode !== 'chat_only') {
      // Robust media playlist initialization with retry for newly live streams
      let playlistAttempts = 0;
      while (playlistAttempts < 3 && (!state.activeDownloadSessions[channelLogin]?.mediaPlaylistUrl)) {
        if (playlistAttempts > 0) {
          addLog(`[Session] Waiting for media playlist to become available for ${channelLogin} (attempt ${playlistAttempts + 1}/3)...`);
          await new Promise(r => setTimeout(r, 2000));
        }
        await refreshMediaPlaylist(channelLogin);
        playlistAttempts++;
      }
    } else {
      addLog(`[Session] Initialized Chat-Only session for @${channelLogin} (skipping HLS video stream download).`);
    }
    
    const isSessionReady = Boolean(
      state.activeDownloadSessions[channelLogin] &&
      (captureMode === 'chat_only' || state.activeDownloadSessions[channelLogin].mediaPlaylistUrl)
    );

    if (isSessionReady) {
      delete initFailureCooldowns[channelLogin];
      state.activeDownloadSessions[channelLogin].playlistPollInterval = setTimeout(() => pollPlaylist(channelLogin), 2500) as any; // Poll every 2.5s

      // Start live chat recording unless channel is configured for Video Only
      if (captureMode !== 'video_only') {
        if (twitchId) {
          const chatStartTime = stream.createdAt || state.activeDownloadSessions[channelLogin].startTime;
          startLiveChatDownload(channelLogin, folderPath, streamId, twitchId, chatStartTime);
        } else {
          addLog("[Chat] Failed to get Twitch ID, chat will not be recorded.");
        }
      } else {
        addLog(`[Session] Video-Only mode active for @${channelLogin} (skipping live chat IRC/PubSub recording).`);
      }
      
      const streamAgeMs = Date.now() - new Date(stream.createdAt).getTime();
      const wasAlreadyLive = streamAgeMs > 2 * 60 * 1000; // 2 minutes

      if (wasAlreadyLive) {
        promptMidStreamVodBackfill({
          channelLogin,
          streamId,
          folderPath,
          captureMode,
          streamAgeMs,
          fallbackGameName: stream.game?.name,
        });
      } else {
        addLog(`[Backfill] Stream just started, no backfill needed.`);
      }
      emitSessionsDelta(true);
    } else {
      initFailureCooldowns[channelLogin] = Date.now() + 45000; // 45s cooldown before retrying initialization
      addLog(`Failed to initialize download session for ${channelLogin} (media playlist not available). Retrying next cycle.`);
      stopActiveDownload(channelLogin);
    }
  }

  export async function refreshMediaPlaylist(channelLogin: string) {
    const session = state.activeDownloadSessions[channelLogin];
    if (!session) return;
    session.isRefreshingPlaylist = true;
    try {
      const newPlaylistUrl = await getSourceMediaPlaylistUrl({
        channelLogin: session.channel,
        isLive: true
      });
      if (session.mediaPlaylistUrl !== newPlaylistUrl) {
        session.initSegmentDownloaded = false;
      }
      session.mediaPlaylistUrl = newPlaylistUrl;
      addLog(`[Stream] Successfully refreshed media playlist for @${channelLogin}.`);
      session.playlistConsecutiveErrors = 0;
    } catch (err: any) {
      if (!session.playlistConsecutiveErrors || session.playlistConsecutiveErrors <= 1) {
        addLog(`[Stream] Could not refresh playlist for @${channelLogin}: ${err.message}`);
      }
    } finally {
      session.isRefreshingPlaylist = false;
    }
  }

export function handleSessionResumeSuccess(channelLogin: string) {
  addLog(`[Session Resumption] Session resumed successfully for @${channelLogin}. All stream segments recovered seamlessly (no content lost).`);

  const resumeTaskId = `resume_success_${channelLogin}_${Date.now()}`;
  updateTask(
    resumeTaskId,
    `Session Resumed (@${channelLogin})`,
    "All stream segments recovered seamlessly with zero lost content.",
    "success",
    false,
    [{ label: "Dismiss", value: "dismiss" }]
  );

  setTimeout(() => {
    removeTask(resumeTaskId);
  }, 15000);
}

export function handleSessionResumeGap(
  channelLogin: string,
  lastSeqBeforeGap: number,
  resumptionSeq: number,
  missingCount: number
) {
  const session = state.activeDownloadSessions[channelLogin];
  if (!session) return;

  const taskId = `prompt_resume_gap_${channelLogin}`;
  if (state.activeTasks[taskId]) return; // Prompt already open

  const avgSegDur = getAverageSegmentDuration(session.folderPath, 2.0);
  const missingSec = Math.round(missingCount * avgSegDur);
  const countdownSec = 60;
  const expiresAt = Date.now() + (countdownSec * 1000);

  const currentGame = session.games && session.games.length > 0 
    ? session.games[session.games.length - 1] 
    : null;
  const currentGameName = currentGame?.gameName || session.currentGame || 'Current Game';

  session.resumptionGap = {
    detectedAt: Date.now(),
    preGapHighestSeq: lastSeqBeforeGap,
    resumptionSeq: resumptionSeq,
    missingChunkCount: missingCount,
    estimatedMissingSec: missingSec,
    currentGameIndex: session.games ? session.games.length - 1 : 0
  };

  addLog(`[Resumption Gap] Stream gap of ${missingCount} segments (~${missingSec}s) detected on @${channelLogin} during downtime. Prompting user for recovery action (Option 2 default in 60s)...`);

  updateTask(
    taskId,
    `Session Resumed with Lost Segments (@${channelLogin})`,
    `Interrupted during downtime: ${missingCount} segments (~${missingSec}s) missing for "${currentGameName}". Auto-selecting Option 2 (VOD Backfill) in ${countdownSec}s.`,
    "running",
    true,
    [
      { label: "Option 2: VOD Backfill Current Game (Default - Zero Lost Content)", value: "resume_vod_backfill" },
      { label: "Option 1: Stitch Live (Accept Gap)", value: "resume_stitch_gap" }
    ]
  );

  const task = state.activeTasks[taskId];
  if (task) {
    task.channelLogin = channelLogin;
    task.streamId = session.streamId;
    task.folderPath = session.folderPath;
    task.expiresAt = expiresAt;
    task.defaultAction = "resume_vod_backfill";
    task.autoCountdownSeconds = countdownSec;
    task.preGapHighestSeq = lastSeqBeforeGap;
    task.resumptionSeq = resumptionSeq;
    task.missingChunkCount = missingCount;
    task.currentGameName = currentGameName;
    task.promptContext = {
      preGapHighestSeq: lastSeqBeforeGap,
      resumptionSeq,
      missingChunkCount: missingCount,
      currentGameName,
    };
  }

  // AFK Default Behavior: Auto-select Option 2 after countdown
  setTimeout(() => {
    if (state.activeTasks[taskId] && state.activeTasks[taskId].actionRequired) {
      addLog(`[Recovery] AFK timeout (${countdownSec}s) elapsed for @${channelLogin}. Auto-selecting Option 2 (VOD Backfill).`);
      executeResumeVodBackfill(channelLogin, lastSeqBeforeGap, resumptionSeq).catch(err => {
        addLog(`[Recovery Error] ${err.message}`);
      });
    }
  }, countdownSec * 1000);
}

export async function executeResumeStitchGap(channelLogin: string) {
  const taskId = `prompt_resume_gap_${channelLogin}`;
  const session = state.activeDownloadSessions[channelLogin];
  const task = state.activeTasks[taskId];
  const missingCount = task?.missingChunkCount || session?.resumptionGap?.missingChunkCount || 30;
  const avgSegDur = getAverageSegmentDuration(session?.folderPath, 2.0);
  const missingDurationSec = parseFloat((missingCount * avgSegDur).toFixed(3));
  const resumptionSeq = task?.resumptionSeq || session?.resumptionGap?.resumptionSeq || 0;

  addLog(`[Recovery] Option 1 executed for @${channelLogin}: Stitching live sequences across gap. Missing duration (~${Math.round(missingDurationSec)}s) will be compensated in chat timestamps.`);

  if (session) {
    if (!session.gapAdjustments) session.gapAdjustments = [];
    session.gapAdjustments.push({
      atChunk: resumptionSeq,
      missingDurationSec: missingDurationSec
    });
    session.totalGapDurationSec = (session.totalGapDurationSec || 0) + missingDurationSec;

    if (session.segmentsFile) {
      const { gameName, timestamp } = getGameRelativeTimestampInfo(session, resumptionSeq);
      await fs.promises.appendFile(session.segmentsFile, `[GAP] Resumed at Seq ${resumptionSeq} (Game: "${gameName}" - Timestamp: ${timestamp}) - Missing ${missingCount} chunks (~${missingDurationSec}s) - Live stitched with chat timestamp compensation\n`).catch(() => {});
    }
  }

  removeTask(taskId);
  scheduleStateSave();
}

export async function executeResumeVodBackfill(
  channelLogin: string,
  lastSeqBeforeGap?: number,
  resumptionSeq?: number
) {
  const taskId = `prompt_resume_gap_${channelLogin}`;
  const task = state.activeTasks[taskId];
  const session = state.activeDownloadSessions[channelLogin];

  const preGapSeq = lastSeqBeforeGap ?? task?.preGapHighestSeq ?? session?.resumptionGap?.preGapHighestSeq ?? 0;
  const resumeSeq = resumptionSeq ?? task?.resumptionSeq ?? session?.resumptionGap?.resumptionSeq ?? 0;

  if (!session) {
    removeTask(taskId);
    return;
  }

  if (!session.games || session.games.length === 0) {
    session.games = [{
      gameName: session.currentGame || 'Unknown',
      startChunk: 0,
      startTimeOffset: 0,
      startTimeMs: session.streamCreatedAtMs || Date.now()
    }];
  }

  const currentGameIndex = session.games.length - 1;
  const currentGame = session.games[currentGameIndex];
  const gameName = currentGame.gameName || session.currentGame || 'Current Game';

  addLog(`[Recovery] Executing Option 2 for @${channelLogin}: Deleting interrupted live segments for "${gameName}" and backfilling from VOD...`);

  // 1. Delete live segments previous to the resumption for ONLY the current game
  let deletedCount = 0;
  const startChunkToDelete = currentGame.startChunk;
  if (preGapSeq >= startChunkToDelete) {
    for (let seq = startChunkToDelete; seq <= preGapSeq; seq++) {
      const fileName = `seq_${String(seq).padStart(8, '0')}.ts`;
      const filePath = path.join(session.folderPath, fileName);
      try {
        if (fs.existsSync(filePath)) {
          await fs.promises.unlink(filePath);
          deletedCount++;
        }
      } catch (e) {}
      session.downloadedSegments.delete(seq);
    }
    addLog(`[Recovery] Cleaned up ${deletedCount} interrupted live segments (seq_${startChunkToDelete} to seq_${preGapSeq}) for "${gameName}".`);
  }

  // 2. Determine backfill start offset BEFORE advancing currentGame boundaries to the resumption edge
  const gameStartOffsetSec = Math.max(0, Math.floor(
    currentGameIndex === 0 
      ? 0 
      : (currentGame.startTimeOffset || 0)
  ));
  const broadcastStartMs = session.streamCreatedAtMs || session.videoStartTimeMs || Date.now();
  const resumptionOffsetSec = Math.max(0, Math.floor((Date.now() - broadcastStartMs) / 1000));
  const backfillEndOffsetSec = resumptionOffsetSec + 6;

  // 3. Advance the current game's start boundary to the resumption edge so subsequent live recording forms Part 2
  currentGame.startChunk = resumeSeq;
  currentGame.startTimeMs = Date.now();
  currentGame.startTimeOffset = resumptionOffsetSec;

  addLog(`[Recovery] Requesting VOD Backfill for "${gameName}" from ${formatTimestamp(gameStartOffsetSec)} to ${formatTimestamp(backfillEndOffsetSec)} (~6s overlap for manual editing)...`);

  removeTask(taskId);
  scheduleStateSave();

  // 4. Trigger standalone VOD backfill download and stitching
  backfillVod(channelLogin, session.streamId, session.folderPath, {
    mode: 'current_game',
    startOffsetSec: gameStartOffsetSec,
    endOffsetSec: backfillEndOffsetSec,
    gameName: `${gameName} (Part 1 - Pre-Resumption)`,
    outputSuffix: 'part1',
    isResumptionBackfill: true
  }).catch(err => {
    addLog(`[Recovery Backfill Error] ${err.message}`);
  });
}

  export async function pollPlaylist(channelLogin: string) {
    const session = state.activeDownloadSessions[channelLogin];
    if (!session || (session as any).isStopped) return;

    // Track active polling state so status checks do not trigger false session recoveries
    session.isPollingActive = true;
    session.lastPollTimestampMs = Date.now();

    // Clear any existing timer to enforce single-timer invariant per channel
    if (session.playlistPollInterval) {
      clearTimeout(session.playlistPollInterval);
      session.playlistPollInterval = null;
    }

    let scheduled = false;
    const scheduleNext = (delayMs = 2500) => {
      if (scheduled) return;
      scheduled = true;
      const current = state.activeDownloadSessions[channelLogin];
      if (current) {
        current.isPollingActive = false;
        current.lastPollTimestampMs = Date.now();
      }
      if (current && !(current as any).isStopped) {
        if (current.playlistPollInterval) {
          clearTimeout(current.playlistPollInterval);
          current.playlistPollInterval = null;
        }
        current.playlistPollInterval = setTimeout(() => pollPlaylist(channelLogin), delayMs) as any;
      }
    };

    // Chat-Only Mode lightweight clock & game-slicing tick (skips HLS segment downloads)
    if (session.captureMode === 'chat_only') {
      try {
        if (!session.folderVerified) {
          if (!fs.existsSync(session.folderPath)) {
            await fs.promises.mkdir(session.folderPath, { recursive: true }).catch(() => {});
          }
          session.folderVerified = true;
        }

        const nowMs = Date.now();
        if (!session.lastDiskCheckMs || (nowMs - session.lastDiskCheckMs) >= DISK_CHECK_INTERVAL_MS) {
          session.lastDiskCheckMs = nowMs;
          const freeBytes = await queryFreeDiskBytes(session.folderPath);
          if (freeBytes !== null && freeBytes < DISK_CRITICAL_THRESHOLD_BYTES) {
            const freeGb = (freeBytes / (1024 * 1024 * 1024)).toFixed(2);
            addLog(`[Storage Safety] CRITICAL: Free disk space dropped to ${freeGb} GB (< 5 GB threshold) during active Chat-Only recording of @${channelLogin}. Finalizing session!`);
            initFailureCooldowns[channelLogin] = Date.now() + 300000;
            const sessionData = { ...session };
            await stopActiveDownload(channelLogin);
            triggerFinalizeFlow(sessionData, channelLogin, "low_disk");
            return;
          }
        }

        const broadcastStartMs = session.streamCreatedAtMs || session.videoStartTimeMs || Date.now();
        session.videoDurationSeconds = Math.max(0, Math.floor((nowMs - broadcastStartMs) / 1000));
        session.highestSeq = Math.floor(session.videoDurationSeconds / 2);
        if (session.firstSeqNum === undefined) {
          session.firstSeqNum = Math.floor((session.initialJoinOffsetSec || 0) / 2);
        }

        // Check for extended stream / single-game autosplice
        const isAutospliceEnabled = state.config.longGameAutospliceEnabled ?? true;
        const triggerHours = state.config.longGameAutospliceTriggerHours ?? 9;
        const cutHours = Math.min(triggerHours, state.config.longGameAutospliceCutHours ?? 8);
        if (isAutospliceEnabled && triggerHours > 0 && cutHours > 0 && session.games && session.games.length > 0) {
          const lastGame = session.games[session.games.length - 1];
          const startChunk = (lastGame.startChunk && lastGame.startChunk > 0) ? lastGame.startChunk : (session.firstSeqNum || 0);
          const currentGameDuration = Math.max(0, (session.videoDurationSeconds || 0) - (lastGame.startTimeOffset || 0));
          const triggerSec = triggerHours * 3600;
          const cutSec = cutHours * 3600;
          if (currentGameDuration >= triggerSec) {
            const chunksElapsed = Math.round(cutSec / 2.0);
            const spliceStartChunk = startChunk + chunksElapsed;
            const spliceTimeOffset = (lastGame.startTimeOffset || 0) + cutSec;
            const spliceStartTimeMs = (lastGame.startTimeMs || Date.now()) + (cutSec * 1000);
            addLog(`[Time Splice] Chat-Only broadcast has been on "${lastGame.gameName}" for >= ${triggerHours}h. Creating time-based chat splice at the ${cutHours}h mark.`);
            session.games.push({
              gameName: lastGame.gameName,
              startChunk: spliceStartChunk,
              startTimeOffset: spliceTimeOffset,
              startTimeMs: spliceStartTimeMs,
              isTimeSplice: true
            });
            scheduleStateSave();
          }
        }

        // Check mid-stream game switch buffer completion
        const bufferMins = state.config.gameSwitchBufferMins ?? 5;
        const triggerChunkDistance = Math.floor((bufferMins * 60) / 2);
        if (session.games && session.games.length > 1) {
          for (let i = 0; i < session.games.length - 1; i++) {
            const pastGame = session.games[i];
            const nextGame = session.games[i + 1];
            if (!pastGame.isExported && session.highestSeq >= nextGame.startChunk + triggerChunkDistance) {
              pastGame.isExported = true;
              scheduleStateSave();
              addLog(`[Game Slicing] Chat-Only Mid-stream: ${pastGame.gameName} (Segment ${i + 1}) is fully buffered! Slicing chat segment in background...`);
              triggerMidStreamGameExport(session, i, channelLogin);
            }
          }
        }
      } finally {
        const currentSession = state.activeDownloadSessions[channelLogin];
        if (currentSession) {
          const now = Date.now();
          if (!currentSession.lastStateSaveMs || (now - currentSession.lastStateSaveMs) >= 20000) {
            currentSession.lastStateSaveMs = now;
            scheduleStateSave();
          }
          emitSessionsDelta();
        }
        scheduleNext(2500);
      }
      return;
    }

    if (!session.mediaPlaylistUrl || session.isRefreshingPlaylist) {
      scheduleNext(2500);
      return;
    }
    
    try {
      if (!session.folderVerified) {
        if (!fs.existsSync(session.folderPath)) {
          try {
            await fs.promises.mkdir(session.folderPath, { recursive: true });
          } catch (mkdirErr: any) {
            addLog(`[Session] Failed to ensure folder ${session.folderPath}: ${mkdirErr.message}`);
            scheduleNext(2500);
            return;
          }
        }
        session.folderVerified = true;
      }

      // Periodic 5-minute disk space check during active recording (< 20 GB warning, < 5 GB emergency stop & finalize)
      const nowMs = Date.now();
      if (!session.lastDiskCheckMs || (nowMs - session.lastDiskCheckMs) >= DISK_CHECK_INTERVAL_MS) {
        session.lastDiskCheckMs = nowMs;
        const freeBytes = await queryFreeDiskBytes(session.folderPath);
        if (freeBytes !== null) {
          const freeGb = (freeBytes / (1024 * 1024 * 1024)).toFixed(2);
          if (freeBytes < DISK_CRITICAL_THRESHOLD_BYTES) {
            const diskFinalizeDesc = session.captureMode === 'video_only'
              ? 'finalizing recorded video chunks'
              : 'sealing chat JSON and finalizing recorded chunks';
            addLog(`[Storage Safety] CRITICAL: Free disk space dropped to ${freeGb} GB (< 5 GB threshold) during active recording of @${channelLogin}. Gracefully pausing stream recording and ${diskFinalizeDesc}!`);
            initFailureCooldowns[channelLogin] = Date.now() + 300000; // 5-minute cooldown before re-attempting
            const sessionData = { ...session };
            await stopActiveDownload(channelLogin);
            triggerFinalizeFlow(sessionData, channelLogin, "low_disk");
            return;
          } else if (freeBytes < DISK_WARNING_THRESHOLD_BYTES) {
            addLog(`[Storage Safety] WARNING: Low disk space (${freeGb} GB remaining, < 20 GB threshold) while recording @${channelLogin}. Recording will automatically finalize and stop if free space drops below 5 GB.`);
          }
        }
      }

      const res = await twitchAxios.get(session.mediaPlaylistUrl, { timeout: 4500 });
      const parser = new Parser();
      parser.push(res.data);
      parser.end();

      const segments = parser.manifest.segments;
      const mediaSequence = parser.manifest.mediaSequence || 0;
      const baseUrl = session.mediaPlaylistUrl.substring(0, session.mediaPlaylistUrl.lastIndexOf("/") + 1);

      // Check for CMAF / fMP4 initialization segment (#EXT-X-MAP) for 1440p / Enhanced Broadcasting
      const rawMapMatch = typeof res.data === 'string' ? res.data.match(/EXT-X-MAP:URI="([^"]+)"/) : null;
      const mapUri = rawMapMatch ? rawMapMatch[1] : (segments[0]?.map?.uri || (parser.manifest as any).map?.uri);
      if (mapUri) {
        session.isFmp4 = true;
        const initFilePath = path.join(session.folderPath, "init.mp4");
        if (!session.initSegmentDownloaded || !fs.existsSync(initFilePath)) {
          const initUrl = mapUri.startsWith("http") ? mapUri : baseUrl + mapUri;
          try {
            const initRes = await twitchAxios.get(initUrl, { responseType: "arraybuffer", timeout: 8000 });
            const initBuf = Buffer.from(initRes.data);
            await fs.promises.writeFile(initFilePath, initBuf);
            session.initSegmentDownloaded = true;
            const info = inspectMp4InitBuffer(initBuf);
            const trackDesc = info.codec ? `, ${info.codec}${info.width && info.height ? ` ${info.width}x${info.height}` : ''}` : '';
            addLog(`[Stream] Detected CMAF / fMP4 stream. Saved live initialization segment: init.mp4 (${initBuf.byteLength} bytes${trackDesc}).`);
            (session as any).liveManifestRecorded = true;
            updateSessionManifest(session.folderPath, {
              liveTrack: {
                container: "fmp4",
                codec: info.codec || null,
                width: info.width,
                height: info.height,
                initFilename: "init.mp4",
                updatedAtMs: Date.now(),
              },
            }).catch(() => {});
          } catch (initErr: any) {
            addLog(`[Stream Warning] Failed to download initialization segment (${mapUri}): ${initErr.message}`);
          }
        } else {
          session.initSegmentDownloaded = true;
          if (!(session as any).liveManifestRecorded) {
            (session as any).liveManifestRecorded = true;
            fs.promises
              .readFile(initFilePath)
              .then((buf) => {
                const info = inspectMp4InitBuffer(buf);
                return updateSessionManifest(session.folderPath, {
                  liveTrack: {
                    container: "fmp4",
                    codec: info.codec || null,
                    width: info.width,
                    height: info.height,
                    initFilename: "init.mp4",
                    updatedAtMs: Date.now(),
                  },
                });
              })
              .catch(() => {});
          }
        }
      } else if (!(session as any).liveManifestRecorded && segments && segments.length > 0) {
        (session as any).liveManifestRecorded = true;
        updateSessionManifest(session.folderPath, {
          liveTrack: {
            container: "ts",
            initFilename: null,
            updatedAtMs: Date.now(),
          },
        }).catch(() => {});
      }

      if (session.playlistConsecutiveErrors && session.playlistConsecutiveErrors > 0) {
        addLog(`[Stream] Live playlist connection restored for @${channelLogin}.`);
        session.playlistConsecutiveErrors = 0;
      }

      const isFirstPollAfterRestart = Boolean(session.isResumingFromRestart);

      if (session.highestSeq !== -1 && mediaSequence > session.highestSeq + 1) {
        const missingCount = mediaSequence - (session.highestSeq + 1);
        const lastSeqBeforeGap = session.highestSeq;
        if (missingCount > 30) {
          addLog(`[Recovery] Detected gap of ${missingCount} segments (stream advanced while offline/restarting). Skipping expired live segments to lock on live edge.`);
          session.highestSeq = mediaSequence - 1;
          if (isFirstPollAfterRestart || session.isResumingFromRestart) {
            session.isResumingFromRestart = false;
            handleSessionResumeGap(channelLogin, lastSeqBeforeGap, mediaSequence, missingCount);
          }
        } else {
          const sampleUri = segments[0]?.uri || "";
          let testReplaced = sampleUri.replace(new RegExp(`${mediaSequence}(-unmuted)?\\.(ts|mp4)`), `0$1.$2`);
          if (testReplaced === sampleUri) {
            testReplaced = sampleUri.replace(new RegExp(`${mediaSequence}(?=\\.(ts|mp4))`), "0");
          }
          const canConstructMissingUrls = Boolean(sampleUri && testReplaced !== sampleUri);

          const estMissingSegDur = segments[0]?.duration || getAverageSegmentDuration(session.folderPath, 2.0);
          if (!canConstructMissingUrls) {
            // Enhanced Broadcasting & modern CloudFront live edges use opaque per-segment token URLs (e.g. .../v1/segment/CpYD...mp4?dna=...)
            // where sequence numbers are not embedded in the URL. Never fetch segments[0] under fake sequence numbers.
            addLog(`[Recovery] Detected ${missingCount} expired live segment(s) (${session.highestSeq + 1}–${mediaSequence - 1}) outside active playlist window (opaque CDN token URLs). Advancing to live edge.`);
            for (let i = session.highestSeq + 1; i < mediaSequence; i++) {
              session.downloadedSegments.add(i);
              session.videoDurationSeconds = (session.videoDurationSeconds || 0) + estMissingSegDur;
              if (session.segmentsFile) {
                const { gameName, timestamp } = getGameRelativeTimestampInfo(session, i);
                await fs.promises.appendFile(session.segmentsFile, `Seq: ${i} - Game: "${gameName}" - Timestamp: ${timestamp} - Expired before poll (opaque CDN URL)\n`).catch(() => {});
              }
            }
            session.highestSeq = mediaSequence - 1;
            if (isFirstPollAfterRestart || session.isResumingFromRestart) {
              session.isResumingFromRestart = false;
              handleSessionResumeGap(channelLogin, lastSeqBeforeGap, mediaSequence, missingCount);
            }
          } else {
            addLog(`[Recovery] Detected ${missingCount} missing segments. Attempting recovery...`);
            const recoveryPromises: Promise<boolean>[] = [];
            
            for (let i = session.highestSeq + 1; i < mediaSequence; i++) {
              if (!session.downloadedSegments.has(i)) {
                session.downloadedSegments.add(i);
                // Robustly replace the media sequence number in the URI with the missing sequence number (handling -unmuted suffixes and .mp4/.ts)
                let uriReplaced = sampleUri.replace(new RegExp(`${mediaSequence}(-unmuted)?\\.(ts|mp4)`), `${i}$1.$2`);
                if (uriReplaced === sampleUri) {
                  uriReplaced = sampleUri.replace(new RegExp(`${mediaSequence}(?=\\.(ts|mp4))`), i.toString());
                }
                const missingSegUrl = uriReplaced.startsWith("http") ? uriReplaced : baseUrl + uriReplaced;
                
                const p = downloadSegmentWithRetry(missingSegUrl, 10000, 2).then(async segRes => {
                  const fileName = `seq_${String(i).padStart(8, '0')}.ts`;
                  const filePath = path.join(session.folderPath, fileName);
                  try {
                    await fs.promises.writeFile(filePath, Buffer.from(segRes.data));
                  } catch (writeErr: any) {
                    if (writeErr.code === 'ENOENT') {
                      await fs.promises.mkdir(session.folderPath, { recursive: true }).catch(() => {});
                      await fs.promises.writeFile(filePath, Buffer.from(segRes.data));
                    } else {
                      throw writeErr;
                    }
                  }
                  
                  appendSegmentTimelineEntry(session.folderPath, i, estMissingSegDur, false);
                  session.chunksDownloaded++;
                  session.videoDurationSeconds = (session.videoDurationSeconds || 0) + estMissingSegDur;
                  addLog(`[Recovery] Successfully recovered segment ${i}`);
                  return true;
                }).catch(async err => {
                  const { gameName, timestamp } = getGameRelativeTimestampInfo(session, i);
                  if (session.segmentsFile) {
                    await fs.promises.appendFile(session.segmentsFile, `Seq: ${i} - Game: "${gameName}" - Timestamp: ${timestamp} - Failed to recover\n`).catch(()=>{});
                  }
                  addLog(`[Recovery] Failed to recover segment ${i}: ${err.message}`);
                  return false;
                });
                recoveryPromises.push(p);
              }
            }

            if (isFirstPollAfterRestart) {
              session.isResumingFromRestart = false;
              Promise.all(recoveryPromises).then(results => {
                const allSuccess = results.every(Boolean);
                if (allSuccess) {
                  handleSessionResumeSuccess(channelLogin);
                } else {
                  const failedCount = results.filter(r => !r).length;
                  handleSessionResumeGap(channelLogin, lastSeqBeforeGap, mediaSequence, failedCount);
                }
              });
            }
          }
        }
      } else if (isFirstPollAfterRestart) {
        session.isResumingFromRestart = false;
        handleSessionResumeSuccess(channelLogin);
      }

      if (!session.inFlightSegmentDownloads) {
        session.inFlightSegmentDownloads = new Map();
      }
      if (!session.latestSegmentUrls) {
        session.latestSegmentUrls = new Map();
      }

      // First pass: refresh latest opaque token URLs for all segments currently in the manifest
      // so any in-flight retry for an active segment uses the freshest CDN token URL.
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const seqNum = mediaSequence + i;
        const segUrl = seg.uri.startsWith("http") ? seg.uri : baseUrl + seg.uri;
        session.latestSegmentUrls.set(seqNum, segUrl);
      }

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const seqNum = mediaSequence + i;

        if (session.firstSeqNum === undefined) {
          session.firstSeqNum = seqNum;
          session.firstChunkDurations = [];
        }
        if (session.firstChunkDurations && session.firstChunkDurations.length < 20 && seqNum === session.firstSeqNum + session.firstChunkDurations.length) {
          session.firstChunkDurations.push(seg.duration);
        }

        if (seqNum > session.highestSeq) {
          session.highestSeq = seqNum;
        }

        // Record exact #EXTINF duration in SegmentTimelineIndex (segments.jsonl)
        appendSegmentTimelineEntry(
          session.folderPath,
          seqNum,
          seg.duration || 2.0,
          Boolean((seg as any).discontinuity)
        );

        if (!session.downloadedSegments.has(seqNum)) {
          session.downloadedSegments.add(seqNum);
          const segUrl = seg.uri.startsWith("http") ? seg.uri : baseUrl + seg.uri;

          // Anchor initial join offset and first game start chunk synchronously on first discovered live segment
          if (!session.initialTimelineAnchored && session.chunksDownloaded === 0) {
            session.initialTimelineAnchored = true;
            const elapsedSinceBroadcastStartSec = Math.max(0, (Date.now() - (session.streamCreatedAtMs || Date.now())) / 1000);
            const playlistWindowSec = segments.reduce((acc: number, s: any) => acc + (s.duration || 2), 0);
            const initialJoinOffsetSec = elapsedSinceBroadcastStartSec < 60
              ? 0
              : Math.max(0, Math.round(elapsedSinceBroadcastStartSec - playlistWindowSec));
            session.initialJoinOffsetSec = initialJoinOffsetSec;
            session.firstSeqNum = seqNum;
            session.videoDurationSeconds = initialJoinOffsetSec;
            if (session.games && session.games.length > 0) {
              const firstGame = session.games[0];
              if (firstGame.startChunk <= 0) {
                firstGame.startChunk = seqNum;
                if (firstGame.startTimeOffset === 0) {
                  firstGame.startTimeOffset = initialJoinOffsetSec;
                }
              }
            }
            updateSessionManifest(session.folderPath, {
              initialJoinOffsetSec,
              firstSeqNum: seqNum,
            }).catch(() => {});
          }

          // Advance session duration synchronously in strict sequence order
          session.videoDurationSeconds = (session.videoDurationSeconds || 0) + (seg.duration || 2);

          // Dispatch segment download asynchronously so a slow/retrying segment never blocks
          // subsequent 2.5s .m3u8 polls or causes opaque-URL segments to roll off the manifest!
          const downloadTask = (async () => {
            try {
              const segRes = await downloadSegmentWithRetry(
                () => session.latestSegmentUrls?.get(seqNum) || segUrl,
                4500,
                3
              );
              const fileName = `seq_${String(seqNum).padStart(8, '0')}.ts`;
              const filePath = path.join(session.folderPath, fileName);

              try {
                await fs.promises.writeFile(filePath, Buffer.from(segRes.data));
              } catch (writeErr: any) {
                if (writeErr.code === 'ENOENT') {
                  await fs.promises.mkdir(session.folderPath, { recursive: true }).catch(() => {});
                  await fs.promises.writeFile(filePath, Buffer.from(segRes.data));
                } else {
                  throw writeErr;
                }
              }

              session.chunksDownloaded++;
              emitSessionsDelta();
            } catch (downloadErr: any) {
              const { gameName, timestamp } = getGameRelativeTimestampInfo(session, seqNum);
              await fs.promises.appendFile(session.segmentsFile, `Seq: ${seqNum} - Game: "${gameName}" - Timestamp: ${timestamp} - Failed to download\n`).catch(() => {});
              addLog(`Failed to download segment ${seqNum}: ${downloadErr.message}`);
            } finally {
              session.inFlightSegmentDownloads?.delete(seqNum);
            }
          })();

          session.inFlightSegmentDownloads.set(seqNum, downloadTask);
        }
      }

      // Bound in-memory downloadedSegments & latestSegmentUrls sets to most recent 1,000 live segments to prevent memory bloat on 24/7 streams
      if (session.downloadedSegments.size > 1500 && session.highestSeq > 1000) {
        const pruneBeforeSeq = session.highestSeq - 1000;
        for (const item of session.downloadedSegments) {
          if (typeof item === 'number' && item < pruneBeforeSeq) {
            session.downloadedSegments.delete(item);
          }
        }
        if (session.latestSegmentUrls) {
          for (const seqKey of session.latestSegmentUrls.keys()) {
            if (seqKey < pruneBeforeSeq) {
              session.latestSegmentUrls.delete(seqKey);
            }
          }
        }
      }
      
      // Check for user-specified time-based game switch splice on extended streams
      const isAutospliceEnabled = state.config.longGameAutospliceEnabled ?? true;
      const triggerHours = state.config.longGameAutospliceTriggerHours ?? 9;
      const cutHours = Math.min(triggerHours, state.config.longGameAutospliceCutHours ?? 8);

      if (isAutospliceEnabled && triggerHours > 0 && cutHours > 0 && session.games && session.games.length > 0) {
        const lastGame = session.games[session.games.length - 1];
        const startChunk = (lastGame.startChunk && lastGame.startChunk > 0) ? lastGame.startChunk : (session.firstSeqNum || session.highestSeq);
        const currentGameDuration = Math.max(0, (session.videoDurationSeconds || 0) - (lastGame.startTimeOffset || 0));
        const triggerSec = triggerHours * 3600;
        const cutSec = cutHours * 3600;

        if (currentGameDuration >= triggerSec) {
          const avgDur = (session.chunksDownloaded > 0 && session.videoDurationSeconds && session.videoDurationSeconds > (session.initialJoinOffsetSec || 0))
            ? ((session.videoDurationSeconds - (session.initialJoinOffsetSec || 0)) / session.chunksDownloaded)
            : 2.0;
          const chunksElapsed = Math.round(cutSec / avgDur);
          const spliceStartChunk = startChunk + chunksElapsed;
          const spliceTimeOffset = (lastGame.startTimeOffset || 0) + cutSec;
          const spliceStartTimeMs = (lastGame.startTimeMs || Date.now()) + (cutSec * 1000);

          addLog(`[Time Splice] Broadcast has been on "${lastGame.gameName}" for >= ${triggerHours}h (${(currentGameDuration / 3600).toFixed(2)}h recorded). Creating time-based splice at the ${cutHours}h mark (Offset: ${spliceTimeOffset}s, Chunk: ${spliceStartChunk}).`);

          const continuationGame: SessionGame = {
            gameName: lastGame.gameName,
            startChunk: spliceStartChunk,
            startTimeOffset: spliceTimeOffset,
            startTimeMs: spliceStartTimeMs,
            isTimeSplice: true
          };

          session.games.push(continuationGame);
          scheduleStateSave();
        }
      }

      // Trigger mid-stream game slicing if conditions are met (buffer crossed)
      const bufferMins = state.config.gameSwitchBufferMins ?? 5;
      if (session.games && session.games.length > 1) {
        for (let i = 0; i < session.games.length - 1; i++) {
          const pastGame = session.games[i];
          const nextGame = session.games[i + 1];
          const triggerChunkDistance = computeChunkCountForDuration(
            session.folderPath,
            nextGame.startChunk,
            bufferMins * 60,
            "forward"
          );
          if (!pastGame.isExported && session.highestSeq >= nextGame.startChunk + triggerChunkDistance) {
            pastGame.isExported = true; // Mark exported right away so we don't trigger twice
            scheduleStateSave();
            addLog(`[Game Slicing] Mid-stream: ${pastGame.gameName} (Segment ${i + 1}) is fully buffered! Stitching segment in background...`);
            triggerMidStreamGameExport(session, i, channelLogin);
          }
        }
      }

    } catch (err: any) {
      session.playlistConsecutiveErrors = (session.playlistConsecutiveErrors || 0) + 1;
      if (err.response && (err.response.status === 404 || err.response.status === 403)) {
        if (session.playlistConsecutiveErrors === 1) {
          addLog(`[Stream] Live playlist returned ${err.response.status} for @${channelLogin} (broadcast may have concluded or reconnecting).`);
        }
        if (session.playlistConsecutiveErrors <= 2) {
          refreshMediaPlaylist(channelLogin);
        }
      } else {
        if (session.playlistConsecutiveErrors === 1) {
          addLog(`[Stream] Playlist poll error for @${channelLogin}: ${err.message}`);
        }
      }
    } finally {
      const currentSession = state.activeDownloadSessions[channelLogin];
      if (currentSession) {
        const now = Date.now();
        if (!currentSession.lastStateSaveMs || (now - currentSession.lastStateSaveMs) >= 20000) {
          currentSession.lastStateSaveMs = now;
          scheduleStateSave();
        }
        emitSessionsDelta();
      }
      const pollDelayMs = (currentSession?.playlistConsecutiveErrors && currentSession.playlistConsecutiveErrors > 1) ? 6000 : 2500;
      scheduleNext(pollDelayMs);
    }
  }

  export function triggerMidStreamGameExport(session: ActiveDownloadSession, gameIndex: number, channelLogin: string) {
    const pastGame = session.games![gameIndex];
    const exportTaskId = `export_${channelLogin}_${session.streamId}_game_${gameIndex}`;
    const initialSubtext = session.captureMode === 'chat_only' ? 'Slicing chat segment...' : 'Stitching...';
    const captureMode: CaptureMode = session.captureMode || 'both';
    updateTask(exportTaskId, `Exporting ${pastGame.gameName} (${channelLogin})`, initialSubtext, "running", false, undefined);
    
    enqueueCompilationJob({
      kind: 'live_segment',
      taskId: exportTaskId,
      preserveTaskOnSuccess: true,
      folderPath: session.folderPath,
      channelLogin,
      streamId: session.streamId,
      captureMode,
      isMidStreamExport: true,
      games: session.games || [],
      targetGameIndex: gameIndex,
      gameName: pastGame.gameName,
      chatFilePath: session.chatFilePath,
      videoDurationSeconds: session.videoDurationSeconds,
      initialJoinOffsetSec: session.initialJoinOffsetSec,
      firstSeqNum: session.firstSeqNum,
      streamCreatedAtMs: session.streamCreatedAtMs,
      gapAdjustments: session.gapAdjustments,
    }).then((chatFiles) => {
      updateTask(exportTaskId, `Exported ${pastGame.gameName} (${channelLogin})`, `Saved to ${session.folderPath}`, "success", false, [
        ...(captureMode !== 'video_only' ? [{ label: "Render Chat", value: "render_chat" }] : []),
        { label: "Open Folder", value: "open_folder" },
        { label: "Close", value: "dismiss" }
      ]);

      const filesArray = Array.isArray(chatFiles) ? chatFiles : [];
      if (captureMode !== 'video_only' && session.autoRenderChat && filesArray.length > 0) {
        addLog(`[Auto-Render] Triggering automatic chat render for mid-stream segment ${pastGame.gameName}...`);
        const segments = filesArray.map((f: string) => {
          const resDim = getChatRenderDimensionsForChatFile(path.join(session.folderPath, f), pastGame.gameName);
          return { filename: f, width: resDim.width, height: resDim.height };
        });
        
        startChatRenderMultiple(channelLogin, session.folderPath, segments).catch((err: any) => {
          addLog(`[Auto-Render] Error: ${err.message}`);
        });
      }
    }).catch((err: any) => {
      pastGame.isExported = false;
      addLog(`[Game Slicing] Mid-stream stitch error for ${pastGame.gameName}: ${err.message}`);
    });
  }

  export interface ManualSpliceOptions {
    action?: 'append_previous' | 'extract_clip' | 'split_new_part' | 'await_next_game';
    clipScope?: 'whole_game' | 'custom_duration';
    clipMinutes?: number;
    leadingBufferMinutes?: number;
  }

  export async function manualSpliceGame(channelLogin: string, options?: ManualSpliceOptions) {
    const cleaned = cleanChannelName(channelLogin);
    const session = Object.values(state.activeDownloadSessions).find(
      s => cleanChannelName(s.channel) === cleaned
    );
    if (!session) {
      throw new Error(`No active recording session found for @${channelLogin}`);
    }

    if (!session.games || session.games.length === 0) {
      session.games = [{
        gameName: session.currentGame || "Game",
        startChunk: 0,
        startTimeOffset: 0,
        startTimeMs: session.streamCreatedAtMs || new Date(session.startTime).getTime()
      }];
    }

    const action = options?.action || 'split_new_part';

    // Option 1: Append extension to previous game
    if (action === 'append_previous') {
      if (session.games.length < 2) {
        throw new Error(`Cannot append to previous game: no previous game segment found in this session.`);
      }

      const prevIndex = session.games.length - 2;
      const prevGame = session.games[prevIndex];
      const currentGameIndex = session.games.length - 1;
      const currentGame = session.games[currentGameIndex];

      const currentChunk = session.highestSeq > 0 ? session.highestSeq : 0;
      const timeOffsetSeconds = Math.floor(session.videoDurationSeconds || 0);

      const bufferMins = state.config.gameSwitchBufferMins ?? 5;
      const CHAT_BUFFER_SEC = bufferMins * 60;
      const trailingBufferChunks = computeChunkCountForDuration(
        session.folderPath,
        currentGame.startChunk,
        CHAT_BUFFER_SEC,
        "forward"
      );

      let extensionStartChunk = (prevGame.endChunk !== undefined && prevGame.endChunk > 0)
        ? prevGame.endChunk + 1
        : Math.min(currentChunk, currentGame.startChunk + trailingBufferChunks + 1);

      if (extensionStartChunk > currentChunk) {
        extensionStartChunk = currentGame.startChunk;
      }
      const extensionEndChunk = currentChunk;

      prevGame.endChunk = extensionEndChunk;
      prevGame.isExported = true;

      // Adjust start point of current game to the splice point
      currentGame.startChunk = currentChunk;
      currentGame.startTimeOffset = timeOffsetSeconds;
      currentGame.startTimeMs = Date.now();
      currentGame.overrideBuffer = false;
      currentGame.isExported = false;

      scheduleStateSave();

      const cleanPrevName = prevGame.gameName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const dateMatch = session.folderPath.match(/_(\d{4}-\d{2}-\d{2})_/);
      const dateStr = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];
      const outputBase = `${prevIndex + 1}_${cleanPrevName}_extension_${dateStr}`;

      const exportTaskId = `export_${cleaned}_${session.streamId}_extension_${Date.now()}`;
      const extSubtext = session.captureMode === 'chat_only' ? 'Slicing chat extension...' : 'Stitching extension...';
      const captureMode: CaptureMode = session.captureMode || 'both';
      updateTask(exportTaskId, `Appending extension to ${prevGame.gameName} (@${session.channel})`, extSubtext, "running", false, undefined);

      addLog(`[Manual Splice] Appending extension to "${prevGame.gameName}" on @${session.channel} (chunks ${extensionStartChunk} - ${extensionEndChunk}). Current game "${currentGame.gameName}" shifted to chunk ${currentChunk}.`);
      emitSessionsDelta(true);

      enqueueCompilationJob({
        kind: 'live_segment',
        taskId: exportTaskId,
        preserveTaskOnSuccess: true,
        folderPath: session.folderPath,
        channelLogin: session.channel,
        streamId: session.streamId,
        captureMode,
        isMidStreamExport: true,
        games: session.games,
        targetGameIndex: prevIndex,
        gameName: prevGame.gameName,
        chatFilePath: session.chatFilePath,
        initialJoinOffsetSec: session.initialJoinOffsetSec,
        firstSeqNum: session.firstSeqNum,
        streamCreatedAtMs: session.streamCreatedAtMs,
        gapAdjustments: session.gapAdjustments,
        customExportMode: 'append_previous',
        customChunkRange: { startIdx: extensionStartChunk, endIdx: extensionEndChunk },
        customOutputName: `${outputBase}.ts`,
        customChatOutputName: `${outputBase}.json`,
      }).then((chatFiles) => {
        updateTask(exportTaskId, `Appended extension to ${prevGame.gameName} (@${session.channel})`, `Saved to ${session.folderPath}`, "success", false, [
          ...(captureMode !== 'video_only' ? [{ label: "Render Chat", value: "render_chat" }] : []),
          { label: "Open Folder", value: "open_folder" },
          { label: "Close", value: "dismiss" }
        ]);

        const filesArray = Array.isArray(chatFiles) ? chatFiles : [];
        if (captureMode !== 'video_only' && session.autoRenderChat && filesArray.length > 0) {
          addLog(`[Auto-Render] Triggering automatic chat render for extension segment ${prevGame.gameName}...`);
          const segments = filesArray.map((f: string) => {
            const resDim = getChatRenderDimensionsForChatFile(path.join(session.folderPath, f), prevGame.gameName);
            return { filename: f, width: resDim.width, height: resDim.height };
          });
          startChatRenderMultiple(session.channel, session.folderPath, segments).catch((err: any) => {
            addLog(`[Auto-Render] Error: ${err.message}`);
          });
        }
      }).catch((err: any) => {
        addLog(`[Manual Splice Error] Error stitching extension: ${err.message}`);
      });

      return { success: true, mode: 'append_previous', gameName: prevGame.gameName };
    }

    // Option 2: Extract standalone highlight / clip
    if (action === 'extract_clip') {
      const currentGameIndex = session.games.length - 1;
      const currentGame = session.games[currentGameIndex];
      const currentChunk = session.highestSeq > 0 ? session.highestSeq : 0;
      const clipScope = options?.clipScope || 'custom_duration';
      const clipMinutes = options?.clipMinutes && options.clipMinutes > 0 ? options.clipMinutes : 5;

      let startIdx = 0;
      let durationLabel = '';
      if (clipScope === 'whole_game') {
        startIdx = currentGame.startChunk > 0 ? currentGame.startChunk : (session.firstSeqNum || 0);
        const elapsedSec = Math.max(
          30,
          Math.abs(getSignedElapsedDurationBetweenChunks(session.folderPath, startIdx, currentChunk + 1))
        );
        const durMins = (elapsedSec / 60).toFixed(1);
        durationLabel = `${durMins}m`;
      } else {
        const chunksNeeded = Math.max(
          1,
          computeChunkCountForDuration(session.folderPath, currentChunk, clipMinutes * 60, 'backward')
        );
        startIdx = Math.max(0, currentChunk - chunksNeeded);
        durationLabel = `${clipMinutes}m`;
      }
      const endIdx = currentChunk;

      const cleanName = (currentGame.gameName || session.currentGame || "Game").replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const dateMatch = session.folderPath.match(/_(\d{4}-\d{2}-\d{2})_/);
      const dateStr = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];
      const timeStr = new Date().toTimeString().split(' ')[0].replace(/:/g, '');
      const outputBase = `clip_${cleanName}_${durationLabel}_${dateStr}_${timeStr}`;

      const exportTaskId = `export_${cleaned}_${session.streamId}_clip_${Date.now()}`;
      const captureMode: CaptureMode = session.captureMode || 'both';
      updateTask(exportTaskId, `Extracting Clip (${durationLabel}) for ${currentGame.gameName} (@${session.channel})`, "Extracting clip...", "running", false, undefined);

      addLog(`[Manual Splice] Extracting standalone clip "${outputBase}" on @${session.channel} (chunks ${startIdx} - ${endIdx}, ${durationLabel}). Master stream timeline preserved.`);

      enqueueCompilationJob({
        kind: 'live_segment',
        taskId: exportTaskId,
        preserveTaskOnSuccess: true,
        folderPath: session.folderPath,
        channelLogin: session.channel,
        streamId: session.streamId,
        captureMode,
        isMidStreamExport: true,
        games: session.games,
        targetGameIndex: currentGameIndex,
        gameName: currentGame.gameName,
        chatFilePath: session.chatFilePath,
        initialJoinOffsetSec: session.initialJoinOffsetSec,
        firstSeqNum: session.firstSeqNum,
        streamCreatedAtMs: session.streamCreatedAtMs,
        gapAdjustments: session.gapAdjustments,
        customExportMode: 'extract_clip',
        customChunkRange: { startIdx, endIdx },
        customOutputName: `${outputBase}.ts`,
        customChatOutputName: `${outputBase}.json`,
        skipChunkCleanup: true, // Crucial invariant: never delete chunks during clip extraction!
      }).then((chatFiles) => {
        updateTask(exportTaskId, `Extracted Clip (${durationLabel}) for ${currentGame.gameName} (@${session.channel})`, `Saved to ${session.folderPath}`, "success", false, [
          ...(captureMode !== 'video_only' ? [{ label: "Render Chat", value: "render_chat" }] : []),
          { label: "Open Folder", value: "open_folder" },
          { label: "Close", value: "dismiss" }
        ]);

        const filesArray = Array.isArray(chatFiles) ? chatFiles : [];
        if (captureMode !== 'video_only' && session.autoRenderChat && filesArray.length > 0) {
          addLog(`[Auto-Render] Triggering automatic chat render for standalone clip ${outputBase}...`);
          const segments = filesArray.map((f: string) => {
            const resDim = getChatRenderDimensionsForChatFile(path.join(session.folderPath, f), currentGame.gameName);
            return { filename: f, width: resDim.width, height: resDim.height };
          });
          startChatRenderMultiple(session.channel, session.folderPath, segments).catch((err: any) => {
            addLog(`[Auto-Render] Error: ${err.message}`);
          });
        }
      }).catch((err: any) => {
        addLog(`[Manual Splice Error] Error extracting clip: ${err.message}`);
      });

      return { success: true, mode: 'extract_clip', gameName: currentGame.gameName, outputBase };
    }

    // Option 4: End current game & await next Twitch category switch
    if (action === 'await_next_game') {
      const lastIndex = session.games.length - 1;
      const lastGame = session.games[lastIndex];

      const currentChunk = session.highestSeq > 0 ? session.highestSeq : 0;
      const timeOffsetSeconds = Math.floor(session.videoDurationSeconds || 0);

      const defaultBufferMins = state.config.gameSwitchBufferMins ?? 5;
      const customLeadingBufferMins = (
        options?.leadingBufferMinutes !== undefined &&
        Number.isFinite(options.leadingBufferMinutes) &&
        options.leadingBufferMinutes >= 0
      )
        ? Number(options.leadingBufferMinutes)
        : (defaultBufferMins * 2);

      // Finalize outgoing segment immediately
      lastGame.overrideBuffer = true;
      lastGame.isManualSplice = true;
      lastGame.isExported = true;
      lastGame.endChunk = currentChunk;

      // Fallback name: "<Previous Game> Part 2" (or increment Part N if already Part N)
      const partMatch = lastGame.gameName.match(/^(.*?)\s+Part\s+(\d+)$/i);
      const fallbackName = partMatch
        ? `${partMatch[1]} Part ${parseInt(partMatch[2], 10) + 1}`
        : `${lastGame.gameName} Part 2`;

      const pendingNextGame: SessionGame = {
        gameName: fallbackName,
        startChunk: currentChunk,
        startTimeOffset: timeOffsetSeconds,
        startTimeMs: Date.now(),
        isManualSplice: true,
        isAwaitingNextGame: true,
        customLeadingBufferMins
      };
      session.games.push(pendingNextGame);
      scheduleStateSave();
      emitSessionsDelta(true);

      addLog(`[Manual Splice] Ended "${lastGame.gameName}" on @${channelLogin} at chunk ${currentChunk} (${timeOffsetSeconds}s) and awaiting next Twitch category switch (fallback label: "${fallbackName}", ${customLeadingBufferMins}m leading buffer). Splicing outgoing game immediately...`);
      triggerMidStreamGameExport(session, lastIndex, session.channel);

      return {
        success: true,
        mode: 'await_next_game',
        gameIndex: lastIndex,
        gameName: lastGame.gameName,
        fallbackNextGameName: fallbackName,
        leadingBufferMinutes: customLeadingBufferMins
      };
    }

    // Option 3: Split into new segment / part
    const lastIndex = session.games.length - 1;
    const lastGame = session.games[lastIndex];

    const currentChunk = session.highestSeq > 0 ? session.highestSeq : 0;
    const timeOffsetSeconds = Math.floor(session.videoDurationSeconds || 0);

    // Apply buffer override and manual splice flags to the ended segment
    lastGame.overrideBuffer = true;
    lastGame.isManualSplice = true;
    lastGame.isExported = true;
    lastGame.endChunk = currentChunk;

    // Create the continuation segment starting at current position with leading buffer preserved
    const continuationGame: SessionGame = {
      gameName: lastGame.gameName,
      startChunk: currentChunk,
      startTimeOffset: timeOffsetSeconds,
      startTimeMs: Date.now(),
      isManualSplice: true
    };
    session.games.push(continuationGame);
    scheduleStateSave();
    emitSessionsDelta(true);

    addLog(`[Manual Splice] Splitting game "${lastGame.gameName}" into new segment on @${channelLogin} at chunk ${currentChunk} (${timeOffsetSeconds}s). Splicing immediately...`);
    triggerMidStreamGameExport(session, lastIndex, session.channel);

    return { success: true, mode: 'split_new_part', gameIndex: lastIndex, gameName: lastGame.gameName };
  }

  export async function overrideGameSwitchBuffer(channelLogin: string, targetGameIndex?: number) {
    const cleaned = cleanChannelName(channelLogin);
    const session = Object.values(state.activeDownloadSessions).find(
      s => cleanChannelName(s.channel) === cleaned
    );
    if (!session) {
      throw new Error(`No active recording session found for @${channelLogin}`);
    }

    if (!session.games || session.games.length < 2) {
      throw new Error(`No game switch transitions available to splice on @${channelLogin}`);
    }

    let indexToExport = -1;
    if (targetGameIndex !== undefined && targetGameIndex >= 0 && targetGameIndex < session.games.length - 1) {
      indexToExport = targetGameIndex;
    } else {
      for (let i = 0; i < session.games.length - 1; i++) {
        if (!session.games[i].isExported) {
          indexToExport = i;
          break;
        }
      }
    }

    if (indexToExport === -1) {
      throw new Error(`All previous game segments have already been exported.`);
    }

    const pastGame = session.games[indexToExport];
    pastGame.overrideBuffer = true;
    pastGame.isExported = true;
    scheduleStateSave();
    emitSessionsDelta(true);

    addLog(`[Game Slicing] Bypassed buffer delay for "${pastGame.gameName}" (Segment ${indexToExport + 1}) on @${channelLogin}. Splicing immediately...`);
    triggerMidStreamGameExport(session, indexToExport, session.channel);

    return { success: true, gameIndex: indexToExport, gameName: pastGame.gameName };
  }

  export async function stopActiveDownload(channelLogin: string) {
    const cleaned = cleanChannelName(channelLogin);
    const matchingKey = Object.keys(state.activeDownloadSessions).find(k => cleanChannelName(k) === cleaned) || channelLogin;
    const session = state.activeDownloadSessions[matchingKey];
    if (session) {
      (session as any).isStopped = true;
      if (session.playlistPollInterval) clearTimeout(session.playlistPollInterval);
      if (session.chatReconnectTimer) {
        clearTimeout(session.chatReconnectTimer);
        session.chatReconnectTimer = null;
      }
      if (session.chatHeartbeatInterval) {
        clearInterval(session.chatHeartbeatInterval);
        session.chatHeartbeatInterval = null;
      }
      if (session.chatWs) {
        try { 
          session.chatWs.removeAllListeners();
          session.chatWs.terminate(); 
        } catch (e) { 
          try { session.chatWs.close(); } catch (err) {}
        }
        session.chatWs = null;
      }
      if (session.pubsubReconnectTimer) {
        clearTimeout(session.pubsubReconnectTimer);
        session.pubsubReconnectTimer = null;
      }
      if (session.pubsubHeartbeatInterval) {
        clearInterval(session.pubsubHeartbeatInterval);
        session.pubsubHeartbeatInterval = null;
      }
      if (session.pubsubWs) {
        try {
          session.pubsubWs.removeAllListeners();
          session.pubsubWs.terminate();
        } catch (e) {
          try { session.pubsubWs.close(); } catch (err) {}
        }
        session.pubsubWs = null;
      }
      if (session.hermesReconnectTimer) {
        clearTimeout(session.hermesReconnectTimer);
        session.hermesReconnectTimer = null;
      }
      if (session.hermesKeepaliveInterval) {
        clearInterval(session.hermesKeepaliveInterval);
        session.hermesKeepaliveInterval = null;
      }
      if (session.hermesWs) {
        try {
          session.hermesWs.removeAllListeners();
          session.hermesWs.terminate();
        } catch (e) {
          try { session.hermesWs.close(); } catch (err) {}
        }
        session.hermesWs = null;
      }
      session.ircConnected = false;
      session.hermesConnected = false;
      session.refreshHermesSocket = undefined;

      if (session.inFlightSegmentDownloads && session.inFlightSegmentDownloads.size > 0) {
        addLog(`[Stream] Waiting for ${session.inFlightSegmentDownloads.size} in-flight segment download(s) to finish before stopping @${channelLogin}...`);
        await Promise.allSettled(Array.from(session.inFlightSegmentDownloads.values()));
      }

      if (session.activeChatBackfillPromise) {
        addLog(`[Chat] Waiting for active chat backfill to finish before sealing chat stream for ${channelLogin}...`);
        await session.activeChatBackfillPromise.catch(() => {});
      }

      flushPendingChatWrites(session);

      if (session.chatStream) {
        await new Promise<void>((resolve) => {
          try {
            session.chatStream!.end(() => resolve());
          } catch (_) {
            resolve();
          }
        });
        session.chatStream = null;
      }

      if (session.captureMode !== 'video_only' && session.chatFilePath && hasChatSource(session.chatFilePath)) {
        let duration = Math.round(session.videoDurationSeconds || 0);
        if (duration <= 0) {
          if (session.highestSeq > 0) {
            const baseSeq = session.firstSeqNum ?? 0;
            const spanSec = Math.abs(
              getSignedElapsedDurationBetweenChunks(session.folderPath, baseSeq, session.highestSeq + 1)
            );
            duration = Math.max(0, Math.round((session.initialJoinOffsetSec || 0) + spanSec));
          } else {
            try {
              const entries = await fs.promises.readdir(session.folderPath, { withFileTypes: true });
              const liveChunkFiles = entries
                .filter(e => e.isFile() && /^seq_(\d+)\.ts$/.test(e.name))
                .map(e => e.name);
              if (liveChunkFiles.length > 0) {
                const avgDur = getAverageSegmentDuration(session.folderPath, 2.0);
                duration = Math.round(liveChunkFiles.length * avgDur);
              }
            } catch (e) {}
          }
        }

        try {
          const sealed = await sealMasterChatFileFromJournal(session.chatFilePath, {
            channelLogin,
            session,
            durationSec: duration,
          });
          if (sealed) {
            const lengthLabel = session.captureMode === 'chat_only' ? 'broadcast duration' : 'video length';
            addLog(`[Chat] Sealed master chat JSON (${sealed.commentCount} messages, ${sealed.eventCount} broadcast events, ${lengthLabel}: ${sealed.durationSec}s) for ${channelLogin}.`);
          }
        } catch (err: any) {
          addLog(`[Chat] Error sealing chat journal for ${channelLogin}: ${err.message}`);
        }
      }

      if (state.activeTasks[`prompt_backfill_${session.streamId}`]) {
        removeTask(`prompt_backfill_${session.streamId}`);
      }
      delete state.activeDownloadSessions[matchingKey];
      if (matchingKey !== channelLogin) {
        delete state.activeDownloadSessions[channelLogin];
      }
      scheduleStateSave();
      emitSessionsDelta(true);
    }
  }

  export function handleStitchComplete(
    sessionData: any, 
    completeTaskId: string, 
    channelName: string,
    videoError?: string | null,
    _generatedChatFiles?: string[]
  ) {
    const captureMode: CaptureMode = sessionData?.captureMode || state.config.channelCaptureModes?.[cleanChannelName(channelName)] || 'both';
    const isWarning = Boolean(videoError);
    const taskStatus = isWarning ? "warning" : "success";
    const statusMsg = isWarning
      ? `Broadcast processed with video notice: ${videoError}. Chat saved to ${sessionData.folderPath}`
      : `Saved to ${sessionData.folderPath}`;

    const taskActions = captureMode === 'video_only'
      ? [
          { label: "Open Folder", value: "open_folder" },
          { label: "Close", value: "dismiss" }
        ]
      : [
          { label: "Render Chat", value: "render_chat" },
          { label: "Open Folder", value: "open_folder" },
          { label: "Re-fetch VOD Chat", value: "download_vod_chat" },
          { label: "Close", value: "dismiss" }
        ];

    updateTask(completeTaskId, `Broadcast Complete (${channelName})`, statusMsg, taskStatus, false, taskActions);
    if (captureMode !== 'video_only' && sessionData.autoRenderChat) {
      addLog(`[Auto-Render] Triggering automatic chat render for ${channelName}...`);
      setTimeout(async () => {
        let jsonFiles: string[] = [];
        try {
          const dirEntries = await fs.promises.readdir(sessionData.folderPath, { withFileTypes: true });
          const files = dirEntries.filter(e => e.isFile()).map(e => e.name);
          jsonFiles = files.filter(f => {
            if (!f.endsWith('.json') || f.startsWith('session_') || f.includes('_backup_')) return false;
            const base = f.replace('.json', '');
            const hasRendered = files.some(other => other.startsWith(`rendered_${base}`));
            return !hasRendered;
          });
        } catch (e) {}
        
        if (jsonFiles.length === 0) {
          addLog(`[Render] No unrendered chat JSON found in ${sessionData.folderPath}`);
          return;
        }

        const segments = jsonFiles.map((f: string) => {
          const resDim = getChatRenderDimensionsForChatFile(path.join(sessionData.folderPath, f), sessionData.currentGame);
          return { filename: f, width: resDim.width, height: resDim.height };
        });
        
        startChatRenderMultiple(channelName, sessionData.folderPath, segments).catch((err: any) => {
          addLog(`[Auto-Render] Error: ${err.message}`);
        });
      }, 1000);
    }
  }

  export function triggerFinalizeFlow(sessionData: any, channelLogin: string, taskIdSuffix?: string) {
    const completeTaskId = `complete_${channelLogin}_${taskIdSuffix || Date.now()}`;
    const finalizeSubtext = sessionData?.captureMode === 'chat_only' ? 'Slicing chat segments...' : 'Stitching in progress...';
    updateTask(completeTaskId, `Broadcast Complete (${channelLogin})`, finalizeSubtext, "running", false, undefined);
    finalizeLiveDownload(sessionData, completeTaskId, channelLogin);
  }

  export async function finalizeLiveDownload(sessionData: ActiveDownloadSession, taskId: string, channelLogin: string) {
    let videoError: string | null = null;
    let chatFiles: string[] = [];
    const captureMode: CaptureMode =
      sessionData?.captureMode ||
      state.config.channelCaptureModes?.[cleanChannelName(channelLogin)] ||
      'both';
    try {
      chatFiles = await enqueueCompilationJob({
        kind: 'live_segment',
        taskId,
        preserveTaskOnSuccess: true,
        folderPath: sessionData.folderPath,
        channelLogin,
        streamId: sessionData.streamId,
        captureMode,
        isMidStreamExport: false,
        games: sessionData.games || [],
        chatFilePath: sessionData.chatFilePath,
        videoDurationSeconds: sessionData.videoDurationSeconds,
        initialJoinOffsetSec: sessionData.initialJoinOffsetSec,
        firstSeqNum: sessionData.firstSeqNum,
        streamCreatedAtMs: sessionData.streamCreatedAtMs,
        gapAdjustments: sessionData.gapAdjustments,
      });
    } catch (err: any) {
      videoError = err?.message || "Stitching failed";
      addLog(`[Video] Finalize stitching encountered issue for ${channelLogin}: ${videoError}`);
    }

    try {
      handleStitchComplete(sessionData, taskId, channelLogin, videoError, chatFiles);
    } catch (err: any) {
      addLog(`[Finalize] Error in handleStitchComplete for ${channelLogin}: ${err.message}`);
    } finally {
      clearSessionManifestMemoryCache(sessionData?.folderPath);
    }
  }
