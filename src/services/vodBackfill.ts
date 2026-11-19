import fs from "fs";
import path from "path";
import axios from "axios";
import checkDiskSpace from "check-disk-space";
import { Parser } from "m3u8-parser";
import { CaptureMode } from "../types";
import {
  state,
  addLog,
  updateTask,
  removeTask,
  cleanChannelName,
  PROJECT_ROOT,
  getResolvedSavePath,
} from "./state";
import {
  twitchAxios,
  requestWithBackoff,
  getSourceMediaPlaylistUrl,
  fetchRecentVods,
  fetchVodChapters,
  inspectMp4InitBuffer,
} from "./twitch";
import { resolveLiveChatBackfill } from "./chat";
import { updateSessionManifest } from "./sessionManifest";
import { enqueueCompilationJob } from "./video";

const DISK_WARNING_THRESHOLD_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB
const DISK_CRITICAL_THRESHOLD_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

function formatVodTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

async function queryVodFreeDiskBytes(targetPath: string): Promise<number | null> {
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

async function downloadVodSegmentWithRetry(url: string, timeoutMs = 10000, retries = 2) {
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, { responseType: "arraybuffer", timeout: timeoutMs });
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

/**
 * Inspects broadcast chapters when joining a mid-stream broadcast (> 2 minutes old)
 * and presents an interactive backfill prompt with a 60s AFK safe default.
 */
export function promptMidStreamVodBackfill(params: {
  channelLogin: string;
  streamId: string;
  folderPath: string;
  captureMode: CaptureMode;
  streamAgeMs: number;
  fallbackGameName?: string;
}): void {
  const { channelLogin, streamId, folderPath, captureMode, streamAgeMs, fallbackGameName } = params;
  const taskId = `prompt_backfill_${streamId}`;
  const timeMins = Math.round(streamAgeMs / 60000);
  const promptTitleBase =
    captureMode === "video_only"
      ? "VOD Video Backfill"
      : captureMode === "chat_only"
      ? "VOD Chat Backfill"
      : "VOD & Chat Backfill";
  const promptTargetDesc =
    captureMode === "video_only"
      ? "missed video"
      : captureMode === "chat_only"
      ? "missed chat"
      : "missed video & chat";

  updateTask(
    taskId,
    promptTitleBase,
    `Stream has been live for ${timeMins}m. Inspecting broadcast chapters...`,
    "running",
    true,
    []
  );

  if (state.activeTasks[taskId]) {
    state.activeTasks[taskId].streamId = streamId;
    state.activeTasks[taskId].channelLogin = channelLogin;
    state.activeTasks[taskId].folderPath = folderPath;
    state.activeTasks[taskId].captureMode = captureMode;
    state.activeTasks[taskId].promptContext = {};
  }

  (async () => {
    try {
      const userQuery = await fetchRecentVods(channelLogin, 5);
      const edges = userQuery.data?.data?.user?.videos?.edges || [];
      let targetVod: any = null;
      for (const edge of edges) {
        if (edge.node.broadcast?.id == streamId) {
          targetVod = edge.node;
          break;
        }
      }
      if (!targetVod && edges.length > 0) {
        const mostRecent = edges[0].node;
        const vodAgeHours =
          (Date.now() - new Date(mostRecent.createdAt).getTime()) / (1000 * 60 * 60);
        if (vodAgeHours < 48) targetVod = mostRecent;
      }

      let chapters: any[] = [];
      if (targetVod) {
        chapters = await fetchVodChapters(targetVod.id);
      }

      const currentTask = state.activeTasks[taskId];
      if (!currentTask) return;

      const countdownSec = 60;
      const expiresAt = Date.now() + countdownSec * 1000;

      if (chapters.length > 1) {
        const currentChapter = chapters[chapters.length - 1];
        const currentGameName =
          currentChapter.gameName || fallbackGameName || "Current Game";
        const currentChapterOffsetSec = Math.floor(currentChapter.positionMilliseconds / 1000);
        const bufferMins = state.config.gameSwitchBufferMins ?? 5;
        const bufferSec = bufferMins * 60;
        const bufferedStartOffsetSec = Math.max(0, currentChapterOffsetSec - bufferSec);

        currentTask.promptContext = {
          vodId: targetVod?.id,
          chapters,
          chapterRawStartOffset: currentChapterOffsetSec,
          currentGameStartOffset: bufferedStartOffsetSec,
          currentGameName,
        };
        currentTask.vodId = targetVod?.id;
        currentTask.chapters = chapters;
        currentTask.chapterRawStartOffset = currentChapterOffsetSec;
        currentTask.currentGameStartOffset = bufferedStartOffsetSec;
        currentTask.currentGameName = currentGameName;

        addLog(
          `[Backfill] VOD chapter "${currentGameName}" began at ${formatVodTimestamp(
            currentChapterOffsetSec
          )}. Applying ${bufferMins}m buffer -> will backfill from ${formatVodTimestamp(
            bufferedStartOffsetSec
          )}.`
        );

        updateTask(
          taskId,
          `${promptTitleBase} (@${channelLogin})`,
          `Stream has been live for ${timeMins}m across ${chapters.length} games. Choose ${promptTargetDesc} backfill option (Auto-selecting No Backfill in ${countdownSec}s):`,
          "running",
          true,
          [
            { label: "Full VOD", value: "backfill_full" },
            { label: `Current Game Only (${currentGameName})`, value: "backfill_current_game" },
            { label: "No Backfill (Default)", value: "backfill_none" },
          ]
        );
      } else {
        currentTask.promptContext = {
          vodId: targetVod?.id,
          chapters,
        };
        currentTask.vodId = targetVod?.id;
        currentTask.chapters = chapters;

        updateTask(
          taskId,
          `${promptTitleBase} (@${channelLogin})`,
          `Stream has been live for ${timeMins}m. Would you like to backfill ${promptTargetDesc} from VOD? (Auto-selecting No Backfill in ${countdownSec}s)`,
          "running",
          true,
          [
            { label: "Full VOD", value: "backfill_full" },
            { label: "No Backfill (Default)", value: "backfill_none" },
          ]
        );
      }

      if (state.activeTasks[taskId]) {
        state.activeTasks[taskId].expiresAt = expiresAt;
        state.activeTasks[taskId].defaultAction = "backfill_none";
        state.activeTasks[taskId].autoCountdownSeconds = countdownSec;
      }
    } catch {
      const countdownSec = 60;
      const expiresAt = Date.now() + countdownSec * 1000;
      updateTask(
        taskId,
        `${promptTitleBase} (@${channelLogin})`,
        `Stream has been live for ${timeMins}m. Would you like to backfill ${promptTargetDesc} from VOD? (Auto-selecting No Backfill in ${countdownSec}s)`,
        "running",
        true,
        [
          { label: "Full VOD", value: "backfill_full" },
          { label: "No Backfill (Default)", value: "backfill_none" },
        ]
      );
      if (state.activeTasks[taskId]) {
        state.activeTasks[taskId].expiresAt = expiresAt;
        state.activeTasks[taskId].defaultAction = "backfill_none";
        state.activeTasks[taskId].autoCountdownSeconds = countdownSec;
      }
    }

    setTimeout(() => {
      if (state.activeTasks[taskId] && state.activeTasks[taskId].actionRequired) {
        addLog(
          `[Backfill] AFK timeout (60s) elapsed for @${channelLogin}. Auto-selecting No Backfill.`
        );
        if (captureMode !== "video_only") {
          resolveLiveChatBackfill(channelLogin, "none", 0).catch((err) => {
            addLog(`[Chat Backfill Error] ${err.message}`);
          });
        }
        removeTask(taskId);
      }
    }, 60000);
  })();
}

/**
 * Downloads VOD backfill segments (`vod_seq_*.ts` + isolated `vod_init.mp4`) and dispatches
 * a standalone `VodBackfillStitchJob` onto the compilation pipeline (Rule 1 & Rule 10).
 */
export async function backfillVod(
  channelLogin: string,
  streamId: string,
  folderPath: string,
  options?: {
    mode?: "full" | "current_game";
    startOffsetSec?: number;
    endOffsetSec?: number;
    gameName?: string;
    outputSuffix?: string;
    isResumptionBackfill?: boolean;
    chapters?: any[];
  }
): Promise<void> {
  const taskId = `backfill_${streamId}`;
  updateTask(taskId, "VOD Backfill", "Looking for VOD...");

  try {
    const preflightFreeBytes = await queryVodFreeDiskBytes(folderPath);
    if (preflightFreeBytes !== null) {
      const freeGb = (preflightFreeBytes / (1024 * 1024 * 1024)).toFixed(2);
      if (preflightFreeBytes < DISK_CRITICAL_THRESHOLD_BYTES) {
        addLog(
          `[Storage Safety] CRITICAL: Free disk space (${freeGb} GB) is below the 5 GB safety threshold. Aborting VOD backfill for @${channelLogin}.`
        );
        updateTask(
          taskId,
          `VOD Backfill Aborted (@${channelLogin})`,
          `Insufficient disk space (${freeGb} GB free, < 5 GB minimum).`,
          "error",
          false,
          [{ label: "Dismiss", value: "dismiss" }]
        );
        return;
      } else if (preflightFreeBytes < DISK_WARNING_THRESHOLD_BYTES) {
        addLog(
          `[Storage Safety] WARNING: Low disk space (${freeGb} GB remaining, < 20 GB threshold) before starting VOD backfill for @${channelLogin}.`
        );
      }
    }

    const userQuery = await fetchRecentVods(channelLogin, 5);
    if (userQuery.data?.errors) {
      addLog(`[Backfill] GraphQL Error: ${JSON.stringify(userQuery.data.errors)}`);
    }

    const edges = userQuery.data?.data?.user?.videos?.edges || [];
    let targetVod: any = null;

    for (const edge of edges) {
      const node = edge.node;
      if (node.broadcast?.id == streamId) {
        targetVod = node;
        break;
      }
    }

    if (!targetVod && edges.length > 0) {
      const mostRecent = edges[0].node;
      const vodAgeHours =
        (new Date().getTime() - new Date(mostRecent.createdAt).getTime()) / (1000 * 60 * 60);
      if (vodAgeHours < 48) {
        targetVod = mostRecent;
        addLog(
          `[Backfill] Stream ID didn't match exactly, but found a recent VOD (${targetVod.id}) created ${vodAgeHours.toFixed(
            1
          )} hours ago. Using as fallback.`
        );
      } else {
        addLog(
          `[Backfill] Most recent VOD is ${vodAgeHours.toFixed(1)} hours old, skipping fallback.`
        );
      }
    }

    if (!targetVod) {
      addLog(
        `[Backfill] No matching VOD found for stream ${streamId}. (VODs available: ${edges.length})`
      );
      removeTask(taskId);
      return;
    }

    const vodId = targetVod.id;
    updateTask(taskId, "VOD Backfill", `Found VOD ${vodId}. Fetching playlist...`);

    const mediaPlaylistUrl = await getSourceMediaPlaylistUrl({
      vodId,
      isLive: false,
    });

    const mediaResponse = await requestWithBackoff(() => twitchAxios.get(mediaPlaylistUrl), {
      description: `VOD media playlist for ${vodId}`,
    });
    const mediaParser = new Parser();
    mediaParser.push(mediaResponse.data);
    mediaParser.end();

    const segments = mediaParser.manifest.segments;
    const baseUrl = mediaPlaylistUrl.substring(0, mediaPlaylistUrl.lastIndexOf("/") + 1);

    addLog(`[Backfill] Found ${segments.length} total segments in VOD.`);

    let startIdx = 0;
    let accumulatedSec = 0;
    const startOffsetSec = options?.startOffsetSec || 0;

    if (options?.mode === "current_game" && startOffsetSec > 0) {
      for (let idx = 0; idx < segments.length; idx++) {
        const segDur = segments[idx].duration || 2.0;
        if (accumulatedSec + segDur >= startOffsetSec) {
          startIdx = idx;
          break;
        }
        accumulatedSec += segDur;
      }
    }

    let endIdx = segments.length;
    if (options?.endOffsetSec && options.endOffsetSec > 0) {
      let endAccSec = 0;
      for (let idx = 0; idx < segments.length; idx++) {
        const segDur = segments[idx].duration || 2.0;
        endAccSec += segDur;
        if (endAccSec >= options.endOffsetSec) {
          endIdx = Math.min(segments.length, idx + 1);
          break;
        }
      }
    }

    const targetSegments = segments.slice(startIdx, endIdx);
    const avgVodSegDur =
      targetSegments.length > 0
        ? targetSegments.reduce((acc: number, s: any) => acc + (s.duration || 2.0), 0) /
          targetSegments.length
        : 2.0;
    addLog(
      `[Backfill] Range: Downloading ${targetSegments.length} segments (~${avgVodSegDur.toFixed(
        1
      )}s/chunk, ${
        options?.mode === "current_game"
          ? `Current Game: ${options.gameName || "Game"} from offset ${Math.round(
              startOffsetSec
            )}s to ${options?.endOffsetSec ? `${Math.round(options.endOffsetSec)}s` : "end"}`
          : "Full VOD"
      }).`
    );

    // Strict Rule 10 isolation: Always save exclusively to 'vod_init.mp4' and NEVER copy onto live 'init.mp4'
    const rawVodMapMatch =
      typeof mediaResponse.data === "string"
        ? mediaResponse.data.match(/EXT-X-MAP:URI="([^"]+)"/)
        : null;
    const vodMapUri = rawVodMapMatch
      ? rawVodMapMatch[1]
      : targetSegments[0]?.map?.uri ||
        segments[0]?.map?.uri ||
        (mediaParser.manifest as any).map?.uri;
    if (vodMapUri) {
      const vodInitFilePath = path.join(folderPath, "vod_init.mp4");
      const initUrl = vodMapUri.startsWith("http") ? vodMapUri : baseUrl + vodMapUri;
      try {
        const initRes = await axios.get(initUrl, { responseType: "arraybuffer", timeout: 8000 });
        const initBuf = Buffer.from(initRes.data);
        await fs.promises.writeFile(vodInitFilePath, initBuf);
        const info = inspectMp4InitBuffer(initBuf);
        const trackDesc = info.codec
          ? `, ${info.codec}${info.width && info.height ? ` ${info.width}x${info.height}` : ""}`
          : "";
        addLog(
          `[Backfill] Saved VOD initialization segment: vod_init.mp4 (${initBuf.byteLength} bytes${trackDesc}).`
        );
        await updateSessionManifest(folderPath, {
          vodTrack: {
            vodId,
            container: "fmp4",
            codec: info.codec || null,
            width: info.width,
            height: info.height,
            initFilename: "vod_init.mp4",
            avgSegmentDurationSec: avgVodSegDur,
            updatedAtMs: Date.now(),
          },
        });
      } catch (initErr: any) {
        addLog(
          `[Backfill Warning] Failed to download VOD initialization segment: ${initErr.message}`
        );
      }
    } else {
      await updateSessionManifest(folderPath, {
        vodTrack: {
          vodId,
          container: "ts",
          initFilename: null,
          avgSegmentDurationSec: avgVodSegDur,
          updatedAtMs: Date.now(),
        },
      });
    }

    let downloadedCount = 0;
    const segmentsFile = path.join(folderPath, "failed_segments.txt");
    const concurrency = 5;

    for (let i = 0; i < targetSegments.length; i += concurrency) {
      if (!state.activeTasks[taskId]) {
        addLog(`[Backfill] Cancelled.`);
        return;
      }

      const chunk = targetSegments.slice(i, i + concurrency);
      const promises = chunk.map(async (seg: any, index: number) => {
        const seqNum = startIdx + i + index;

        if (
          state.activeDownloadSessions[channelLogin] &&
          state.activeDownloadSessions[channelLogin].downloadedSegments.has(`vod_${seqNum}`)
        ) {
          return;
        }

        const segUrl = seg.uri.startsWith("http") ? seg.uri : baseUrl + seg.uri;
        try {
          const segRes = await downloadVodSegmentWithRetry(segUrl, 10000, 2);
          const fileName = `vod_seq_${String(seqNum).padStart(8, "0")}.ts`;
          const filePath = path.join(folderPath, fileName);

          await fs.promises.writeFile(filePath, Buffer.from(segRes.data));

          if (state.activeDownloadSessions[channelLogin]) {
            state.activeDownloadSessions[channelLogin].downloadedSegments.add(`vod_${seqNum}`);
          }
          downloadedCount++;
        } catch (err: any) {
          const dur = Math.max(0, Math.round((seqNum - startIdx) * avgVodSegDur));
          const ts = formatVodTimestamp(dur);
          const gameLabel = options?.gameName ? `Game: "${options.gameName}" - ` : "";
          await fs.promises
            .appendFile(
              segmentsFile,
              `Seq: vod_${seqNum} - ${gameLabel}Timestamp: ${ts} - Failed to download\n`
            )
            .catch(() => {});
          addLog(`[Backfill] Failed to download seq ${seqNum}: ${err.message}`);
        }
      });

      await Promise.all(promises);
      updateTask(
        taskId,
        "VOD Backfill",
        `Downloaded ${downloadedCount}/${targetSegments.length} missing segments... (${Math.round(
          (i / targetSegments.length) * 100
        )}%)`
      );
    }

    addLog(
      `[Backfill] Complete. Downloaded ${downloadedCount}/${targetSegments.length} missing segments.`
    );
    removeTask(taskId);

    // Immediately dispatch typed VodBackfillStitchJob onto the compilation pipeline
    const stitchTaskId = `stitch_vod_${vodId}_${Date.now()}`;
    updateTask(
      stitchTaskId,
      `Stitching VOD (${options?.gameName || "Backfill"})`,
      "Stitching VOD segments into standalone video...",
      "running",
      false,
      undefined
    );
    const sessionCaptureMode: CaptureMode =
      state.activeDownloadSessions[channelLogin]?.captureMode ||
      state.config.channelCaptureModes?.[cleanChannelName(channelLogin)] ||
      "both";

    enqueueCompilationJob({
      kind: "vod_backfill",
      taskId: stitchTaskId,
      preserveTaskOnSuccess: true,
      folderPath,
      channelLogin,
      vodId,
      vodMode: options?.mode,
      vodStartOffsetSec: options?.startOffsetSec,
      vodAvgSegmentDuration: avgVodSegDur,
      gameName: options?.gameName,
      outputSuffix: options?.outputSuffix,
      chatFilePath: state.activeDownloadSessions[channelLogin]?.chatFilePath,
      captureMode: sessionCaptureMode,
    })
      .then(() => {
        updateTask(
          stitchTaskId,
          `VOD Backfill Complete (${options?.gameName || "Backfill"})`,
          "Saved standalone VOD video.",
          "success",
          false,
          [
            ...(sessionCaptureMode !== "video_only"
              ? [{ label: "Render Chat", value: "render_chat" }]
              : []),
            { label: "Open Folder", value: "open_folder" },
            { label: "Close", value: "dismiss" },
          ]
        );
        if (state.activeTasks[stitchTaskId]) {
          state.activeTasks[stitchTaskId].folderPath = folderPath;
          state.activeTasks[stitchTaskId].channelLogin = channelLogin;
        }
        addLog(
          `[Backfill] Successfully stitched standalone VOD video for ${options?.gameName || "VOD"}.`
        );
      })
      .catch((err) => {
        addLog(`[Backfill] Error stitching VOD: ${err.message}`);
        updateTask(stitchTaskId, "Stitching VOD Video", `Failed: ${err.message}`, "error", true, [
          { label: "Close", value: "dismiss" },
        ]);
      });
  } catch (err: any) {
    addLog(`[Backfill] Error: ${err.message}`);
    removeTask(taskId);
  }
}
