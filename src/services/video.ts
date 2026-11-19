import fs from "fs";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import { Parser } from "m3u8-parser";
import { state, addLog, updateTask, removeTask, resolveTdPath, getChatRenderDimensionsForGame, cleanChannelName } from "./state";
import { startChatRenderMultiple, safeParseChatData, repairChatJsonFile, flushPendingChatWrites } from "./chat";
import {
  hasChatSource,
  compileChatSlice,
  cleanupMasterChatArtifacts,
  writeJsonAtomic,
  loadUnifiedChatDataset,
} from "./chatCompiler";
import {
  detectSessionContainerFromManifest,
  computeChunkCountForDuration,
  getSignedElapsedDurationBetweenChunks,
  getAverageSegmentDuration,
} from "./sessionManifest";
import { ensureFfmpeg, getVideoDurationSeconds } from "./ffmpeg";
import { twitchAxios, getSourceMediaPlaylistUrl, fetchRecentVods, fetchInitSegmentFromTwitch, inspectMp4InitBuffer } from "./twitch";
import type { CompilationJobSpec, CaptureMode } from "../types";

// Active FFmpeg processes tracker for clean cancellation
const activeFfmpegProcesses: Map<string, ChildProcess> = new Map();

// Single-worker FIFO Compilation Queue driven by discriminated-union CompilationJobSpec
interface StitchJob {
  spec: CompilationJobSpec;
  resolve: (chatFiles: string[]) => void;
  reject: (err: any) => void;
}

const stitchQueue: StitchJob[] = [];
let isStitchRunning = false;
const chatOnlyFolderLocks = new Map<string, Promise<string[]>>();

export function abortFfmpegProcess(taskId: string) {
  if (state.activeTasks[taskId]) {
    state.activeTasks[taskId].cancelled = true;
  }
  const qIdx = stitchQueue.findIndex(j => j.spec.taskId === taskId);
  if (qIdx !== -1) {
    const [removedJob] = stitchQueue.splice(qIdx, 1);
    addLog(`[Video Queue] Removed cancelled task ${taskId} from stitch queue.`);
    removeTask(taskId);
    removedJob.resolve([]);
    stitchQueue.forEach((qJob, idx) => {
      const qTask = state.activeTasks[qJob.spec.taskId];
      if (qTask && qTask.status === 'running') {
        updateTask(qJob.spec.taskId, qTask.name || "Stitching Video", `Queued (Position #${idx + 1} in line)...`, "running", false);
      }
    });
    return;
  }
  const child = activeFfmpegProcesses.get(taskId);
  if (child) {
    try {
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) {}
      }, 3000);
    } catch (e) {}
    activeFfmpegProcesses.delete(taskId);
  }
}

export function abortAllFfmpegProcesses() {
  for (const job of stitchQueue) {
    if (state.activeTasks[job.spec.taskId]) {
      state.activeTasks[job.spec.taskId].cancelled = true;
    }
    removeTask(job.spec.taskId);
    job.resolve([]);
  }
  stitchQueue.length = 0;
  for (const [taskId, child] of activeFfmpegProcesses.entries()) {
    try {
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) {}
      }, 1000);
    } catch (e) {}
  }
  activeFfmpegProcesses.clear();
}

/**
 * Escapes file paths for FFmpeg concat demuxer format.
 * In concat file syntax, single quotes must be escaped as '\''.
 */
function formatConcatLine(filename: string): string {
  const escaped = filename.replace(/'/g, "'\\''");
  return `file '${escaped}'`;
}

/**
 * Detects whether a chunk file is traditional MPEG-TS or fragmented MP4 (fMP4/CMAF).
 * Uses authoritative session and folder checks as first-class signals.
 */
export async function detectChunkContainer(
  filePath: string,
  folderPath?: string,
  session?: any
): Promise<'ts' | 'fmp4'> {
  const isVodChunk = path.basename(filePath).startsWith('vod_seq_');

  // 1. Authoritative SessionManifest track metadata (strictly isolated by Live vs VOD)
  const manifestContainer = detectSessionContainerFromManifest(folderPath, isVodChunk);
  if (manifestContainer) {
    return manifestContainer;
  }

  // 2. Active live session flag (only applies to live seq_* chunks)
  if (!isVodChunk && session?.isFmp4) {
    return 'fmp4';
  }

  // 3. Track-specific initialization segment presence (init.mp4 for Live, vod_init.mp4 for VOD)
  if (folderPath) {
    const initName = isVodChunk ? 'vod_init.mp4' : 'init.mp4';
    const candidate = path.join(folderPath, initName);
    if (fs.existsSync(candidate)) {
      try {
        const st = await fs.promises.stat(candidate);
        if (st.size > 100) return 'fmp4';
      } catch (e) {}
    }
  }

  // 3. Inspect chunk header
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fd.read(buf, 0, 4096, 0);
    if (bytesRead > 0) {
      // MPEG-TS packets begin with sync byte 0x47 (and 0x47 at offset 188)
      if (buf[0] === 0x47 && (bytesRead < 189 || buf[188] === 0x47)) {
        return 'ts';
      }

      // Check common ISO-BMFF / fMP4 box atom types anywhere in the first 4KB
      const fmp4Boxes = ['moof', 'styp', 'ftyp', 'emsg', 'prft', 'sidx', 'traf', 'mdat'];
      const rawHeader = buf.slice(0, bytesRead).toString('binary');
      for (const box of fmp4Boxes) {
        if (rawHeader.includes(box)) {
          return 'fmp4';
        }
      }

      // If it doesn't start with 0x47, it cannot be MPEG-TS; treat as fmp4
      if (buf[0] !== 0x47) {
        return 'fmp4';
      }
    }
  } catch (e) {
  } finally {
    if (fd) await fd.close().catch(() => {});
  }

  return 'fmp4';
}

/**
 * Streams a single file sequentially to stdin with backpressure control.
 * Prevents memory buffer leaks and MaxListenersExceeded on long broadcasts.
 */
function streamFileToStdin(
  filePath: string,
  stdin: NodeJS.WritableStream,
  isCancelled: () => boolean
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let rs: fs.ReadStream | null = null;
    let finished = false;

    const cleanup = () => {
      if (rs) {
        try { rs.destroy(); } catch (e) {}
        rs = null;
      }
    };

    try {
      rs = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    } catch (openErr) {
      return resolve(false);
    }

    rs.on('data', (chunk) => {
      if (isCancelled() || (stdin as any).destroyed) {
        cleanup();
        if (!finished) { finished = true; resolve(false); }
        return;
      }
      const canContinue = stdin.write(chunk);
      if (!canContinue) {
        rs?.pause();
        stdin.once('drain', () => {
          if (!isCancelled() && !(stdin as any).destroyed && rs) {
            rs.resume();
          }
        });
      }
    });

    rs.on('end', () => {
      cleanup();
      if (!finished) { finished = true; resolve(true); }
    });

    rs.on('error', () => {
      cleanup();
      if (!finished) { finished = true; resolve(false); }
    });
  });
}

/**
 * Resolves the initialization segment (init.mp4 for Live, vod_init.mp4 for VOD backfill) for CMAF / fMP4 streams.
 * Queries local folder first, then Twitch CDN (matching stream ID, active live playlist, recent VODs),
 * and uses sister session folders only as a final fallback.
 */
export async function resolveInitSegment(
  folderPath: string,
  channelLogin?: string,
  session?: any,
  isVod = false
): Promise<string | null> {
  const primaryName = isVod ? 'vod_init.mp4' : 'init.mp4';
  const primaryInit = path.join(folderPath, primaryName);

  // Strict Rule 10 isolation: only check the track-matching local init file before querying Twitch CDN.
  // Never substitute vod_init.mp4 for init.mp4 (or vice versa) because resolution/codec tiers may differ.
  try {
    if (fs.existsSync(primaryInit)) {
      const st = await fs.promises.stat(primaryInit);
      if (st.size > 100) return primaryInit;
    }
  } catch (e) {}

  const targetLocalInit = primaryInit;

  // Parse folder name for channel login and stream ID as universal fallback
  const folderName = path.basename(folderPath);
  const chanMatch = folderName.match(/^([a-zA-Z0-9_]+)_\d{4}-\d{2}-\d{2}/);
  const streamIdMatch = folderName.match(/_(\d{10,15})/);
  const login = channelLogin || session?.channel || (chanMatch ? chanMatch[1] : "");
  const streamId = session?.streamId || (streamIdMatch ? streamIdMatch[1] : "");

  const fetchVodInitFromRecentVods = async (): Promise<string | null> => {
    if (!login) return null;
    try {
      const vodQuery = await fetchRecentVods(login, 5);
      const edges = vodQuery.data?.data?.user?.videos?.edges || [];
      for (const edge of edges) {
        const vodId = edge.node.id;
        const vodPlaylistUrl = await getSourceMediaPlaylistUrl({ channelLogin: login, vodId, isLive: false }).catch(() => null);
        if (vodPlaylistUrl) {
          const res = await twitchAxios.get(vodPlaylistUrl, { timeout: 6000 });
          const mapMatch = res.data.match(/EXT-X-MAP:URI="([^"]+)"/);
          const parser = new Parser();
          parser.push(res.data);
          parser.end();
          const mapUri = mapMatch ? mapMatch[1] : (parser.manifest?.segments?.[0]?.map?.uri || (parser.manifest as any)?.map?.uri);
          if (mapUri) {
            const baseUrl = vodPlaylistUrl.substring(0, vodPlaylistUrl.lastIndexOf('/') + 1);
            const initUrl = mapUri.startsWith('http') ? mapUri : baseUrl + mapUri;
            const initRes = await twitchAxios.get(initUrl, { responseType: 'arraybuffer', timeout: 8000 });
            const initBuf = Buffer.from(initRes.data);
            await fs.promises.writeFile(targetLocalInit, initBuf);
            const info = inspectMp4InitBuffer(initBuf);
            const trackDesc = info.codec ? `, ${info.codec}${info.width && info.height ? ` ${info.width}x${info.height}` : ''}` : '';
            addLog(`[Video Pre-flight] Downloaded missing fMP4 initialization segment (${primaryName}) from VOD ${vodId} (${initBuf.byteLength} bytes${trackDesc}).`);
            return targetLocalInit;
          }
        }
      }
    } catch (e: any) {
      addLog(`[Video Pre-flight] Could not fetch ${primaryName} from VOD: ${e.message}`);
    }
    return null;
  };

  // For VOD tracks, prefer the VOD playlist first so CloudFront 1440p60 HEVC upgrades match vod_seq_* segments
  if (isVod) {
    const fromVod = await fetchVodInitFromRecentVods();
    if (fromVod) return fromVod;
  }

  // 1. Query Twitch CDN specifically for this broadcast stream ID
  if (login && streamId) {
    try {
      const initBuf = await fetchInitSegmentFromTwitch(login, streamId);
      if (initBuf && initBuf.length > 100) {
        await fs.promises.writeFile(targetLocalInit, initBuf);
        const info = inspectMp4InitBuffer(initBuf);
        const trackDesc = info.codec ? `, ${info.codec}${info.width && info.height ? ` ${info.width}x${info.height}` : ''}` : '';
        addLog(`[Video Pre-flight] Downloaded matching ${primaryName} from Twitch CDN for @${login} (stream ${streamId}, ${initBuf.length} bytes${trackDesc}).`);
        return targetLocalInit;
      }
    } catch (e: any) {
      addLog(`[Video Pre-flight] Stream ID init segment lookup note: ${e.message}`);
    }
  }

  // 2. Attempt fetching from active live session playlist if resolving a live track
  if (login && !isVod) {
    try {
      const playlistUrl = session?.mediaPlaylistUrl || await getSourceMediaPlaylistUrl({ channelLogin: login, isLive: true }).catch(() => null);
      if (playlistUrl) {
        const res = await twitchAxios.get(playlistUrl, { timeout: 6000 });
        const mapMatch = res.data.match(/EXT-X-MAP:URI="([^"]+)"/);
        const parser = new Parser();
        parser.push(res.data);
        parser.end();
        const mapUri = mapMatch ? mapMatch[1] : (parser.manifest?.segments?.[0]?.map?.uri || (parser.manifest as any)?.map?.uri);
        if (mapUri) {
          const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
          const initUrl = mapUri.startsWith('http') ? mapUri : baseUrl + mapUri;
          const initRes = await twitchAxios.get(initUrl, { responseType: 'arraybuffer', timeout: 8000 });
          const initBuf = Buffer.from(initRes.data);
          await fs.promises.writeFile(targetLocalInit, initBuf);
          const info = inspectMp4InitBuffer(initBuf);
          const trackDesc = info.codec ? `, ${info.codec}${info.width && info.height ? ` ${info.width}x${info.height}` : ''}` : '';
          addLog(`[Video Pre-flight] Downloaded missing fMP4 initialization segment from live playlist (${initBuf.byteLength} bytes${trackDesc}).`);
          return targetLocalInit;
        }
      }
    } catch (e: any) {
      addLog(`[Video Pre-flight] Could not fetch ${primaryName} from live stream: ${e.message}`);
    }

    // 3. Offline recovery fallback from recent VODs if live stream already ended
    const fromVodFallback = await fetchVodInitFromRecentVods();
    if (fromVodFallback) return fromVodFallback;
  }

  // 4. Last Resort: Search parent directory for sister session folders of the same channel (matching track type first)
  try {
    const parentDir = path.dirname(folderPath);
    const entries = await fs.promises.readdir(parentDir, { withFileTypes: true });
    const cleanChan = login ? login.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    for (const entry of entries) {
      if (entry.isDirectory() && (!cleanChan || entry.name.toLowerCase().includes(cleanChan))) {
        const sisterInit = path.join(parentDir, entry.name, primaryName);
        if (fs.existsSync(sisterInit) && sisterInit !== targetLocalInit) {
          const st = await fs.promises.stat(sisterInit);
          if (st.size > 100) {
            const sisterBuf = await fs.promises.readFile(sisterInit);
            await fs.promises.writeFile(targetLocalInit, sisterBuf);
            const info = inspectMp4InitBuffer(sisterBuf);
            const trackDesc = info.codec ? ` (${info.codec}${info.width && info.height ? ` ${info.width}x${info.height}` : ''})` : '';
            addLog(`[Video Pre-flight] Last-resort fMP4 init fallback: copied ${path.basename(sisterInit)}${trackDesc} from sister folder ${entry.name}.`);
            return targetLocalInit;
          }
        }
      }
    }
  } catch (e) {}

  return null;
}

/**
 * Enqueues a strongly-typed CompilationJobSpec onto the Deterministic Compilation Pipeline.
 * Pure JSON `chat_only` segment compilations bypass the FFmpeg worker queue via per-folder serialization.
 */
export function enqueueCompilationJob(spec: CompilationJobSpec): Promise<string[]> {
  const { taskId, folderPath } = spec;
  const sessionMatching = Object.values(state.activeDownloadSessions).find(s => s.folderPath === folderPath);
  const effectiveCaptureMode: CaptureMode =
    spec.captureMode ||
    state.activeTasks[taskId]?.captureMode ||
    sessionMatching?.captureMode ||
    'both';

  // Persist typed retrySpec on ActiveTask so crash-restart `retry_stitch` can re-run deterministically
  if (state.activeTasks[taskId]) {
    state.activeTasks[taskId].folderPath = folderPath;
    if (spec.channelLogin) state.activeTasks[taskId].channelLogin = spec.channelLogin;
    state.activeTasks[taskId].captureMode = effectiveCaptureMode;
    state.activeTasks[taskId].retrySpec = spec;
  }

  // Fast-path decoupling: Pure JSON chat_only slicing does not spawn FFmpeg and must never block behind long video remuxes
  if (effectiveCaptureMode === 'chat_only' && spec.kind !== 'vod_backfill') {
    const folderKey = path.resolve(folderPath);
    const prevChain = chatOnlyFolderLocks.get(folderKey) || Promise.resolve([]);
    const nextChain = prevChain
      .catch(() => [])
      .then(() => executeCompilationJob(spec));
    chatOnlyFolderLocks.set(folderKey, nextChain);
    nextChain.finally(() => {
      if (chatOnlyFolderLocks.get(folderKey) === nextChain) {
        chatOnlyFolderLocks.delete(folderKey);
      }
    });
    return nextChain;
  }

  return new Promise((resolve, reject) => {
    const job: StitchJob = { spec, resolve, reject };
    stitchQueue.push(job);

    if (isStitchRunning) {
      const queuePos = stitchQueue.length;
      const queuedTask = state.activeTasks[taskId];
      addLog(`[Video Queue] Stitch job queued for ${path.basename(folderPath)} (Position #${queuePos} in queue).`);
      updateTask(taskId, queuedTask?.name || "Stitching Video", `Queued (Position #${queuePos} in line)...`, "running", false);
    } else {
      processNextStitchJob();
    }
  });
}

/**
 * Backward-compatible helper that synthesizes a typed CompilationJobSpec and delegates to enqueueCompilationJob.
 */
export function stitchVideoChunks(folderPath: string, type: 'all' | 'live' | 'vod' = 'all', existingTaskId?: string): Promise<string[]> {
  const taskId = existingTaskId || `stitch_${Date.now()}`;
  const taskObj = state.activeTasks[taskId];
  if (taskObj?.retrySpec && taskObj.retrySpec.folderPath === folderPath) {
    return enqueueCompilationJob({
      ...taskObj.retrySpec,
      taskId,
      preserveTaskOnSuccess: Boolean(existingTaskId),
    });
  }

  const sessionMatching = Object.values(state.activeDownloadSessions).find(s => s.folderPath === folderPath);
  const channelLogin = taskObj?.channelLogin || sessionMatching?.channel || "";
  const captureMode: CaptureMode =
    taskObj?.captureMode ||
    sessionMatching?.captureMode ||
    (channelLogin ? state.config.channelCaptureModes?.[cleanChannelName(channelLogin)] : undefined) ||
    'both';

  if (type === 'vod') {
    return enqueueCompilationJob({
      kind: 'vod_backfill',
      taskId,
      preserveTaskOnSuccess: Boolean(existingTaskId),
      folderPath,
      channelLogin,
      vodId: taskObj?.vodId,
      vodMode: taskObj?.vodMode === 'current_game' ? 'current_game' : 'full',
      vodStartOffsetSec: taskObj?.vodStartOffsetSec,
      vodAvgSegmentDuration: taskObj?.vodAvgSegmentDuration,
      gameName: taskObj?.gameName || taskObj?.currentGameName,
      outputSuffix: taskObj?.outputSuffix,
      chatFilePath: taskObj?.chatFilePath || sessionMatching?.chatFilePath,
      captureMode,
    });
  }

  if (type === 'all') {
    return enqueueCompilationJob({
      kind: 'folder_recovery',
      taskId,
      preserveTaskOnSuccess: Boolean(existingTaskId),
      folderPath,
      channelLogin,
      captureMode,
      games: taskObj?.games || sessionMatching?.games,
      chatFilePath: taskObj?.chatFilePath || sessionMatching?.chatFilePath,
      videoDurationSeconds: taskObj?.videoDurationSeconds || sessionMatching?.videoDurationSeconds,
    });
  }

  return enqueueCompilationJob({
    kind: 'live_segment',
    taskId,
    preserveTaskOnSuccess: Boolean(existingTaskId),
    folderPath,
    channelLogin,
    streamId: taskObj?.streamId || sessionMatching?.streamId,
    captureMode,
    isMidStreamExport: taskId.includes('_game_') || taskId.includes('_clip_') || taskId.includes('_extension_'),
    games: taskObj?.games || sessionMatching?.games || [],
    targetGameIndex: taskObj?.targetGameIndex,
    gameName: taskObj?.gameName,
    chatFilePath: taskObj?.chatFilePath || sessionMatching?.chatFilePath,
    videoDurationSeconds: taskObj?.videoDurationSeconds ?? sessionMatching?.videoDurationSeconds,
    initialJoinOffsetSec: taskObj?.initialJoinOffsetSec ?? sessionMatching?.initialJoinOffsetSec,
    firstSeqNum: taskObj?.firstSeqNum ?? sessionMatching?.firstSeqNum,
    streamCreatedAtMs: taskObj?.streamCreatedAtMs ?? sessionMatching?.streamCreatedAtMs,
    gapAdjustments: taskObj?.gapAdjustments || sessionMatching?.gapAdjustments,
    customExportMode: taskObj?.customExportMode,
    customChunkRange: taskObj?.customChunkRange,
    customOutputName: taskObj?.customOutputName,
    customChatOutputName: taskObj?.customChatOutputName,
    skipChunkCleanup: taskObj?.skipChunkCleanup,
  });
}

async function processNextStitchJob() {
  if (isStitchRunning || stitchQueue.length === 0) return;

  const job = stitchQueue.shift()!;
  isStitchRunning = true;

  if (state.activeTasks[job.spec.taskId]?.cancelled) {
    addLog(`[Video Queue] Skipping cancelled stitch job ${job.spec.taskId}.`);
    job.resolve([]);
    isStitchRunning = false;
    processNextStitchJob();
    return;
  }

  try {
    const chatFiles = await executeCompilationJob(job.spec);
    job.resolve(chatFiles);
  } catch (err: any) {
    job.reject(err);
  } finally {
    isStitchRunning = false;
    stitchQueue.forEach((qJob, idx) => {
      const qTask = state.activeTasks[qJob.spec.taskId];
      if (qTask && qTask.status === 'running') {
        const isChatOnlyQueued = (qJob.spec.captureMode || qTask.captureMode) === 'chat_only';
        updateTask(qJob.spec.taskId, qTask.name || (isChatOnlyQueued ? "Slicing Chat Segments" : "Stitching Video"), `Queued (Position #${idx + 1} in line)...`, "running", false);
      }
    });
    processNextStitchJob();
  }
}

async function executeCompilationJob(spec: CompilationJobSpec): Promise<string[]> {
  const { taskId, folderPath } = spec;
  const preserveTaskOnSuccess = Boolean(spec.preserveTaskOnSuccess);
  const type: 'all' | 'live' | 'vod' =
    spec.kind === 'vod_backfill' ? 'vod' : spec.kind === 'folder_recovery' ? 'all' : 'live';
  const generatedChatFiles: string[] = [];
  try {
    const taskObj = state.activeTasks[taskId];
    const sessionMatching = Object.values(state.activeDownloadSessions).find(s => s.folderPath === folderPath);
    const liveSpec = spec.kind === 'live_segment' ? spec : undefined;
    const vodSpec = spec.kind === 'vod_backfill' ? spec : undefined;
    const recoverySpec = spec.kind === 'folder_recovery' ? spec : undefined;

    const specGames = liveSpec?.games ?? recoverySpec?.games;
    const games = (specGames && specGames.length > 0)
      ? specGames
      : ((taskObj?.games && taskObj.games.length > 0) ? taskObj.games : (sessionMatching?.games || []));
    const chatFilePath =
      liveSpec?.chatFilePath ||
      vodSpec?.chatFilePath ||
      recoverySpec?.chatFilePath ||
      taskObj?.chatFilePath ||
      sessionMatching?.chatFilePath;
    const channelLogin = spec.channelLogin || taskObj?.channelLogin || sessionMatching?.channel || "";
    const session = channelLogin ? state.activeDownloadSessions[channelLogin] : sessionMatching;
    const captureMode: CaptureMode =
      spec.captureMode ||
      taskObj?.captureMode ||
      session?.captureMode ||
      (channelLogin ? state.config.channelCaptureModes?.[cleanChannelName(channelLogin)] : undefined) ||
      'both';
    const isMidStreamExport =
      liveSpec?.isMidStreamExport ??
      (taskId.includes('_game_') || taskId.includes('_clip_') || taskId.includes('_extension_'));

    if (captureMode === 'chat_only' && type !== 'vod') {
      updateTask(taskId, taskObj?.name || "Slicing Chat Segments", "Slicing chat JSON...");
      addLog(`[Chat-Only] Finalizing chat segments in ${folderPath}...`);
    } else {
      updateTask(taskId, taskObj?.name || "Stitching Video", "Scanning sequence files...");
      addLog(`[Video] Starting video stitching in ${folderPath} (Job: ${spec.kind})...`);
    }

    if (type === 'live' && session?.inFlightSegmentDownloads && session.inFlightSegmentDownloads.size > 0) {
      addLog(`[Video] Waiting for ${session.inFlightSegmentDownloads.size} in-flight live segment download(s) to complete before scanning chunks...`);
      await Promise.allSettled(Array.from(session.inFlightSegmentDownloads.values()));
    }

    // Asynchronous non-blocking directory reading
    const dirEntries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    const files = dirEntries.filter(entry => entry.isFile()).map(entry => entry.name);

    const getChunkIndex = (f: string) => {
      const m = f.match(/(?:vod_)?seq_(\d+)\.ts$/);
      return m ? parseInt(m[1], 10) : -1;
    };

    const liveChunkFiles = files
      .filter(f => f.startsWith('seq_') && f.endsWith('.ts'))
      .sort((a, b) => getChunkIndex(a) - getChunkIndex(b));

    const vodChunkFiles = files
      .filter(f => f.startsWith('vod_seq_') && f.endsWith('.ts'))
      .sort((a, b) => getChunkIndex(a) - getChunkIndex(b));

    const dateMatch = folderPath.match(/_(\d{4}-\d{2}-\d{2})_/);
    const dateStr = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];

    // Track successfully verified output files so we only clean up chunks if stitching succeeded
    const successfullyStitchedMp4s: string[] = [];

    const stitchGroup = async (chunkFiles: string[], outputName: string, label: string): Promise<number> => {
      if (chunkFiles.length === 0) return 0;

      const mp4OutputName = outputName.replace(/\.ts$/, '.mp4');
      const outputPath = path.join(folderPath, mp4OutputName);

      const tdPath = resolveTdPath(state.config.tdPath);
      
      const actualFfmpegPath = await ensureFfmpeg(tdPath, (msg) => {
        updateTask(taskId, msg, `Please wait...`, "running", false);
      });

      // Pre-flight check: exclude seq_00000000.ts artifact and empty chunks
      const validChunks: string[] = [];
      for (const cf of chunkFiles) {
        // Exclude legacy poison rename artifact
        if (cf === 'seq_00000000.ts') {
          addLog(`[Video Pre-flight] Discarding legacy poison chunk ${cf} to prevent concat error.`);
          continue;
        }

        const p = path.join(folderPath, cf);
        try {
          const st = await fs.promises.stat(p);
          if (st.size < 100) {
            addLog(`[Video Pre-flight] Skipping empty/truncated chunk ${cf} (${st.size} bytes).`);
            continue;
          }
          validChunks.push(cf);
        } catch (stErr) {
          addLog(`[Video Pre-flight] Chunk ${cf} not accessible on disk. Skipping.`);
        }
      }

      if (validChunks.length === 0) {
        throw new Error(`No sequence chunks available to stitch for ${label}`);
      }

      // Container detection: check first chunk to determine whether this is MPEG-TS or fMP4 (1440p)
      const sampleChunkPath = path.join(folderPath, validChunks[0]);
      const containerType = await detectChunkContainer(sampleChunkPath, folderPath, session);
      addLog(`[Video Pre-flight] Container format for ${label}: ${containerType.toUpperCase()} (${validChunks.length} chunks).`);

      let listFileName: string | null = null;
      let listFilePath: string | null = null;
      let ffmpegSpawnArgs: string[] = [];
      let isFmp4Pipe = false;
      let resolvedInitPath: string | null = null;

      const isVodGroup = type === 'vod' || validChunks[0].startsWith('vod_seq_');
      if (containerType === 'fmp4') {
        resolvedInitPath = await resolveInitSegment(folderPath, channelLogin, session, isVodGroup);
        if (!resolvedInitPath) {
          throw new Error(`Broadcast is 1440p fMP4 / CMAF, but initialization segment (${isVodGroup ? 'vod_init.mp4' : 'init.mp4'}) could not be found or downloaded for ${label}.`);
        }
        isFmp4Pipe = true;
        ffmpegSpawnArgs = [
          '-stats',
          '-loglevel', 'error',
          '-i', 'pipe:0',
          '-c', 'copy',
          '-movflags', '+faststart',
          '-avoid_negative_ts', 'make_zero',
          '-y',
          mp4OutputName
        ];
      } else {
        // Standard MPEG-TS concat demuxer
        listFileName = `concat_list_${Date.now()}_${Math.floor(Math.random() * 10000)}.txt`;
        listFilePath = path.join(folderPath, listFileName);
        const listContent = validChunks.map(formatConcatLine).join('\n');
        await fs.promises.writeFile(listFilePath, listContent, 'utf8');

        ffmpegSpawnArgs = [
          '-stats',
          '-loglevel', 'error',
          '-f', 'concat',
          '-safe', '0',
          '-i', listFileName,
          '-c', 'copy',
          '-avoid_negative_ts', 'make_zero',
          '-y',
          mp4OutputName
        ];
      }

      updateTask(taskId, `Stitching ${label}`, `Remuxing ${containerType.toUpperCase()} segments with FFmpeg...`);

      const runFfmpegProcess = async (): Promise<void> => {
        return new Promise<void>((resolve, reject) => {
          const child = spawn(actualFfmpegPath, ffmpegSpawnArgs, { cwd: folderPath });
          activeFfmpegProcesses.set(taskId, child);

          // Hard execution timeout (30m base or scaled to large segment collections)
          const FFMPEG_TIMEOUT_MS = Math.max(30 * 60 * 1000, validChunks.length * 2000);
          let isTimedOut = false;
          let forceKillTimer: NodeJS.Timeout | null = null;
          const timeoutTimer = setTimeout(() => {
            isTimedOut = true;
            addLog(`[Video Timeout] FFmpeg stitching exceeded ${(FFMPEG_TIMEOUT_MS / 60000).toFixed(0)}m timeout for ${label}. Terminating process...`);
            activeFfmpegProcesses.delete(taskId);
            try {
              child.kill('SIGTERM');
            } catch (e) {}
            forceKillTimer = setTimeout(() => {
              try {
                child.kill('SIGKILL');
              } catch (e) {}
            }, 3000);
            reject(new Error(`FFmpeg remuxing timed out after ${(FFMPEG_TIMEOUT_MS / 60000).toFixed(0)} minutes.`));
          }, FFMPEG_TIMEOUT_MS);

          child.stdout?.on('data', () => {}); // Consume stdout to prevent pipe buffer freeze
          
          let ffmpegErr = '';
          const nonProgressErrLines: string[] = [];
          let lastUpdateTime = 0;
          const estChunkDur = isVodGroup ? (vodSpec?.vodAvgSegmentDuration || taskObj?.vodAvgSegmentDuration || 2) : getAverageSegmentDuration(folderPath, 2.0);
          const estimatedTotalSec = Math.max(1, Math.round(validChunks.length * estChunkDur));

          child.stderr?.on('data', (data: any) => {
            const str = data.toString();
            ffmpegErr += str;
            if (ffmpegErr.length > 4000) {
              ffmpegErr = ffmpegErr.slice(-4000);
            }

            const lines = str.split(/\r?\n/);
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed && !trimmed.startsWith('frame=') && !trimmed.includes('bitrate=')) {
                nonProgressErrLines.push(trimmed);
                if (nonProgressErrLines.length > 25) {
                  nonProgressErrLines.shift();
                }
              }
            }

            const timeMatch = str.match(/time=(\d{2}):(\d{2}):(\d{2})/);
            if (timeMatch) {
              const hours = parseInt(timeMatch[1], 10);
              const minutes = parseInt(timeMatch[2], 10);
              const seconds = parseInt(timeMatch[3], 10);
              const currentSec = hours * 3600 + minutes * 60 + seconds;
              const now = Date.now();
              if (now - lastUpdateTime > 800) {
                lastUpdateTime = now;
                const pct = Math.min(99, Math.max(1, Math.round((currentSec / estimatedTotalSec) * 100)));
                updateTask(taskId, `Stitching ${label}`, `Remuxing segments: ${pct}%`);
              }
            }
          });

          // If fMP4 pipe mode: stream init.mp4 followed by all valid chunks sequentially with backpressure
          if (isFmp4Pipe && resolvedInitPath) {
            let stdinDestroyed = false;
            child.stdin?.on('error', () => {
              stdinDestroyed = true;
            });

            const filesToStream = [resolvedInitPath, ...validChunks.map(c => path.join(folderPath, c))];
            (async () => {
              for (let fIdx = 0; fIdx < filesToStream.length; fIdx++) {
                if (stdinDestroyed || isTimedOut || Boolean(state.activeTasks[taskId]?.cancelled)) break;
                const filePath = filesToStream[fIdx];
                await streamFileToStdin(filePath, child.stdin!, () => stdinDestroyed || isTimedOut || Boolean(state.activeTasks[taskId]?.cancelled));
              }
              if (!stdinDestroyed && !child.stdin?.destroyed) {
                try { child.stdin?.end(); } catch (e) {}
              }
            })().catch(() => {});
          }

          child.on('error', (err) => {
            clearTimeout(timeoutTimer);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            activeFfmpegProcesses.delete(taskId);
            if (isTimedOut) return;
            reject(new Error(`Failed to spawn FFmpeg process: ${err.message}`));
          });

          child.on('close', (code) => {
            clearTimeout(timeoutTimer);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            activeFfmpegProcesses.delete(taskId);
            if (isTimedOut) return;
            if (code === 0) resolve();
            else {
              const errDetail = nonProgressErrLines.length > 0 
                ? nonProgressErrLines.join(' | ') 
                : ffmpegErr.slice(-500);
              reject(new Error(`FFmpeg exited with code ${code}. Error: ${errDetail}`));
            }
          });
        });
      };

      try {
        try {
          await runFfmpegProcess();
        } catch (pipeErr: any) {
          // If pipe remuxing encountered an error on fMP4, fall back to direct file assembly
          if (isFmp4Pipe && resolvedInitPath && !state.activeTasks[taskId]?.cancelled) {
            addLog(`[Video Fallback] Stdin pipe remuxing note: ${pipeErr.message}. Executing direct fMP4 assembly fallback for ${label}...`);
            const tempConcatPath = path.join(folderPath, `temp_combined_${Date.now()}.mp4`);
            try {
              const outFd = await fs.promises.open(tempConcatPath, 'w');
              const filesToCombine = [resolvedInitPath, ...validChunks.map(c => path.join(folderPath, c))];
              for (const f of filesToCombine) {
                const buf = await fs.promises.readFile(f);
                await outFd.write(buf);
              }
              await outFd.close();

              // Try remuxing the combined file with FFmpeg faststart
              let remuxOk = false;
              try {
                await new Promise<void>((resRemux, rejRemux) => {
                  const remuxChild = spawn(actualFfmpegPath, [
                    '-stats', '-loglevel', 'error',
                    '-i', tempConcatPath,
                    '-c', 'copy',
                    '-movflags', '+faststart',
                    '-y', mp4OutputName
                  ], { cwd: folderPath });
                  remuxChild.on('close', code => code === 0 ? resRemux() : rejRemux(new Error(`Exit code ${code}`)));
                  remuxChild.on('error', rejRemux);
                });
                remuxOk = true;
              } catch (remuxErr: any) {
                addLog(`[Video Fallback] Faststart remux note: ${remuxErr.message}. Utilizing combined fMP4 container directly.`);
                await fs.promises.rename(tempConcatPath, outputPath);
                remuxOk = true;
              }

              if (remuxOk && fs.existsSync(outputPath)) {
                try { await fs.promises.unlink(tempConcatPath); } catch (e) {}
                addLog(`[Video Fallback] Direct fMP4 assembly succeeded for ${label}.`);
              }
            } catch (combErr: any) {
              try { await fs.promises.unlink(tempConcatPath); } catch (e) {}
              throw new Error(`Both pipe streaming and direct assembly failed for ${label}: ${pipeErr.message} | ${combErr.message}`);
            }
          } else {
            throw pipeErr;
          }
        }

        // Verify the stitched MP4 file exists and has size > 0
        const outputStats = await fs.promises.stat(outputPath);
        if (outputStats.size > 1000) {
          const probedDuration = await getVideoDurationSeconds(outputPath, tdPath);
          addLog(`[Video] ${label} stitching successful (${containerType.toUpperCase()}). Output size: ${(outputStats.size / (1024 * 1024)).toFixed(2)} MB${probedDuration > 0 ? `, Duration: ${probedDuration.toFixed(2)}s` : ''}.`);
          successfullyStitchedMp4s.push(outputPath);
          return probedDuration;
        } else {
          throw new Error(`FFmpeg completed but output file ${mp4OutputName} is empty or corrupt (${outputStats.size} bytes).`);
        }
      } catch (err: any) {
        addLog(`[Video] ${label} stitching failed: ${err.message}`);
        throw err;
      } finally {
        if (listFilePath) {
          try {
            await fs.promises.unlink(listFilePath);
          } catch (e) {}
        }
      }
    };

    if (type === 'vod') {
      if (vodChunkFiles.length === 0) {
        addLog(`[Video] No VOD sequence files found to stitch.`);
        if (!preserveTaskOnSuccess) removeTask(taskId);
        return [];
      }

      const vodGameName = vodSpec?.gameName || taskObj?.gameName || taskObj?.currentGameName;
      const cleanName = vodGameName ? vodGameName.replace(/[^a-z0-9]/gi, '_').toLowerCase() : '';
      const outputSuffix = vodSpec?.outputSuffix || taskObj?.outputSuffix;
      const vodOutputName = cleanName 
        ? `${cleanName}_vod_backfill_${outputSuffix ? `${outputSuffix}_` : ''}${dateStr}.ts`
        : `vod_broadcast_${outputSuffix ? `${outputSuffix}_` : ''}${dateStr}.ts`;

      let probedVodDuration = 0;
      let vodStitchError: Error | null = null;
      try {
        probedVodDuration = await stitchGroup(vodChunkFiles, vodOutputName, vodGameName ? `VOD Backfill (${vodGameName})` : 'VOD Backfill');
      } catch (err: any) {
        vodStitchError = err;
        addLog(`[Video Warning] Standalone VOD video stitching failed: ${err.message}. Proceeding with paired chat creation...`);
      }

      // Generate paired chat JSON file for standalone VOD backfill if chat exists (skip in video_only mode)
      const vodChatFilePath = vodSpec?.chatFilePath || taskObj?.chatFilePath || session?.chatFilePath;
      const vodJsonOutputName = cleanName 
        ? `${cleanName}_vod_backfill_${outputSuffix ? `${outputSuffix}_` : ''}${dateStr}.json`
        : `vod_broadcast_${outputSuffix ? `${outputSuffix}_` : ''}${dateStr}.json`;
      const vodOutChatPath = path.join(folderPath, vodJsonOutputName);

      // Await any in-flight chat backfill promise so that the chat file is fully populated before slicing
      if (captureMode !== 'video_only' && session?.activeChatBackfillPromise) {
        addLog(`[VOD Chat] Waiting for chat backfill pagination to finish before slicing ${vodJsonOutputName}...`);
        try {
          await session.activeChatBackfillPromise;
          addLog(`[VOD Chat] Chat backfill pagination complete. Proceeding to slice paired chat.`);
        } catch (chatWaitErr: any) {
          addLog(`[VOD Chat] Note: Chat backfill wait encountered: ${chatWaitErr.message}`);
        }
      }

      let pairedChatReady = false;

      // 1. Check if the standalone backfill chat JSON was already generated directly upon download completion
      if (captureMode !== 'video_only' && fs.existsSync(vodOutChatPath)) {
        try {
          const existingData = safeParseChatData(await fs.promises.readFile(vodOutChatPath, 'utf8'));
          if (existingData && Array.isArray(existingData.comments) && existingData.comments.length > 0) {
            // Update with true probed video duration if available to ensure exact length parity
            if (probedVodDuration > 0 && existingData.video) {
              existingData.video.end = probedVodDuration;
              existingData.video.length = probedVodDuration;
              await writeJsonAtomic(vodOutChatPath, existingData);
            }
            addLog(`[VOD Chat] Standalone paired chat file already exists: ${vodJsonOutputName} (${existingData.comments.length} messages, duration: ${existingData.video?.length || 0}s).`);
            pairedChatReady = true;
          }
        } catch (e) {}
      }

      // 2. If not already written, slice from the unified chat journal/master dataset as fallback
      if (captureMode !== 'video_only' && !pairedChatReady && vodChatFilePath && hasChatSource(vodChatFilePath)) {
        try {
          if (session) {
            flushPendingChatWrites(session);
          }

          const vodStartOffsetSec = vodSpec?.vodStartOffsetSec ?? taskObj?.vodStartOffsetSec ?? 0;
          const fallbackChunkDur = vodSpec?.vodAvgSegmentDuration || taskObj?.vodAvgSegmentDuration || 2;
          const effectiveVodDurationSec = probedVodDuration > 0
            ? probedVodDuration
            : Math.max(1, Math.round(vodChunkFiles.length * fallbackChunkDur));

          const sliceResult = await compileChatSlice({
            sourceChatFilePath: vodChatFilePath,
            outputFilePath: vodOutChatPath,
            channelLogin,
            folderPath,
            session,
            startOffsetSec: vodStartOffsetSec,
            endOffsetSec: vodStartOffsetSec + effectiveVodDurationSec,
            durationSec: effectiveVodDurationSec,
            gameName: vodGameName,
            expandEndToMaxComment: true,
          });

          if (sliceResult) {
            addLog(`[VOD Chat] Generated paired chat file: ${vodJsonOutputName} (${sliceResult.commentCount}/${sliceResult.totalSourceComments} messages, duration: ${sliceResult.durationSec}s, range: ${vodStartOffsetSec}s - ${sliceResult.effectiveEndOffsetSec.toFixed(1)}s)`);
            pairedChatReady = true;
          }
        } catch (chatErr: any) {
          addLog(`[VOD Chat] Non-fatal error creating paired VOD chat file: ${chatErr.message}`);
        }
      }

      // Check if auto-render is enabled for this channel or globally
      if (captureMode !== 'video_only' && pairedChatReady && fs.existsSync(vodOutChatPath)) {
        const autoRender = channelLogin 
          ? (state.config.channelAutoRender?.[channelLogin] ?? state.config.autoRenderChat ?? false)
          : (state.config.autoRenderChat ?? false);

        if (autoRender && channelLogin) {
          const resDim = getChatRenderDimensionsForGame(vodGameName, vodJsonOutputName);
          addLog(`[VOD Chat] Triggering chat render for standalone VOD backfill: ${vodJsonOutputName} (${resDim.width}x${resDim.height}${resDim.isCustomProfile ? ` via profile "${resDim.matchedProfile}"` : ''})`);
          startChatRenderMultiple(channelLogin, folderPath, [{ filename: vodJsonOutputName, width: resDim.width, height: resDim.height }]);
        }
      }

      if (!vodStitchError && probedVodDuration > 0) {
        addLog(`[Video] Cleaning up ${vodChunkFiles.length} temporary VOD sequence files...`);
        for (const chunk of vodChunkFiles) {
          try {
            await fs.promises.unlink(path.join(folderPath, chunk));
          } catch (e) {}
        }
        addLog(`[Video] Successfully cleaned up temporary VOD sequence files.`);
      } else {
        addLog(`[Video] Retaining temporary VOD sequence files for recovery.`);
      }

      if (!preserveTaskOnSuccess) {
        removeTask(taskId);
      }
      return [];
    }

    const bufferMins = state.config.gameSwitchBufferMins ?? 5;
    const CHAT_BUFFER_SEC = bufferMins * 60;
    const customExportMode = liveSpec?.customExportMode ?? taskObj?.customExportMode;
    const customChunkRange = liveSpec?.customChunkRange ?? taskObj?.customChunkRange;
    const customOutputName = liveSpec?.customOutputName ?? taskObj?.customOutputName;
    const customChatOutputName = liveSpec?.customChatOutputName ?? taskObj?.customChatOutputName;
    const skipChunkCleanup = liveSpec?.skipChunkCleanup ?? taskObj?.skipChunkCleanup;
    const targetGameIdxSpec = liveSpec?.targetGameIndex ?? taskObj?.targetGameIndex;
    const specGameName = liveSpec?.gameName ?? taskObj?.gameName;
    const specInitialJoinOffsetSec = liveSpec?.initialJoinOffsetSec ?? taskObj?.initialJoinOffsetSec;
    const specFirstSeqNum = liveSpec?.firstSeqNum ?? taskObj?.firstSeqNum;
    const specStreamCreatedAtMs = liveSpec?.streamCreatedAtMs ?? taskObj?.streamCreatedAtMs;
    const specGapAdjustments = liveSpec?.gapAdjustments ?? taskObj?.gapAdjustments;
    const specVideoDurationSec = liveSpec?.videoDurationSeconds ?? recoverySpec?.videoDurationSeconds ?? taskObj?.videoDurationSeconds;

    if (liveChunkFiles.length === 0) {
      // In Chat-Only capture mode, there are no live .ts video chunks—slice the chat journal/file directly across game/custom boundaries!
      if (captureMode === 'chat_only' && chatFilePath && hasChatSource(chatFilePath)) {
        if (session) {
          flushPendingChatWrites(session);
        }
        addLog(`[Chat-Only] Slicing chat in ${folderPath} without video chunks (mode: chat_only)...`);

        // 1. Custom Export in Chat-Only Mode (Append Extension / Extract Clip)
        if (customExportMode && customChunkRange) {
          const { startIdx, endIdx } = customChunkRange;
          const chatOutputName = customChatOutputName || (customOutputName || `custom_${Date.now()}.ts`).replace(/\.ts$/, '.json');
          try {
            const avgChunkDur = getAverageSegmentDuration(folderPath, 2.0);
            const baseOffsetSec = session?.initialJoinOffsetSec ?? specInitialJoinOffsetSec ?? 0;
            const baseSeq = session?.firstSeqNum ?? specFirstSeqNum ?? 0;
            const broadcastStartMs = session?.streamCreatedAtMs || session?.videoStartTimeMs || specStreamCreatedAtMs;
            const targetGameIdx = targetGameIdxSpec;
            const targetGame = (targetGameIdx !== undefined && games[targetGameIdx])
              ? games[targetGameIdx]
              : games.find(g => g.gameName === specGameName);

            let videoStartOffset = Math.max(
              0,
              baseOffsetSec + Math.max(0, getSignedElapsedDurationBetweenChunks(folderPath, baseSeq, startIdx, avgChunkDur))
            );
            if (targetGame && targetGameIdx !== undefined && targetGameIdx > 0 && broadcastStartMs && targetGame.startTimeMs && targetGame.startTimeMs >= broadcastStartMs) {
              const gameSwitchOffsetSec = (targetGame.startTimeMs - broadcastStartMs) / 1000;
              const deltaSec = getSignedElapsedDurationBetweenChunks(folderPath, targetGame.startChunk, startIdx, avgChunkDur);
              videoStartOffset = Math.max(0, gameSwitchOffsetSec + deltaSec);
            } else if (targetGame && targetGame.startTimeOffset !== undefined && targetGame.startTimeOffset > 0 && targetGame.startChunk > 0) {
              const deltaSec = getSignedElapsedDurationBetweenChunks(folderPath, targetGame.startChunk, startIdx, avgChunkDur);
              videoStartOffset = Math.max(0, targetGame.startTimeOffset + deltaSec);
            }

            const actualVideoDurationSec = Math.max(
              1,
              Math.round(Math.abs(getSignedElapsedDurationBetweenChunks(folderPath, startIdx, Math.max(startIdx + 1, endIdx + 1), avgChunkDur)))
            );
            const videoEndOffset = videoStartOffset + actualVideoDurationSec;
            const gapAdjustments = session?.gapAdjustments || specGapAdjustments || [];
            const outChatPath = path.join(folderPath, chatOutputName);

            const sliceResult = await compileChatSlice({
              sourceChatFilePath: chatFilePath,
              outputFilePath: outChatPath,
              channelLogin,
              folderPath,
              session,
              startOffsetSec: videoStartOffset,
              endOffsetSec: videoEndOffset,
              durationSec: actualVideoDurationSec,
              gameName: specGameName || targetGame?.gameName,
              gapAdjustments,
              baseOffsetSec,
              baseSeq,
              avgChunkDur,
            });

            if (sliceResult) {
              generatedChatFiles.push(path.basename(outChatPath));
              addLog(`[Chat-Only Split] Sliced custom chat (${customExportMode}) -> ${outChatPath} (${sliceResult.commentCount} messages, ${sliceResult.eventCount} events, ${actualVideoDurationSec}s)`);
            }
          } catch (err: any) {
            addLog(`[Chat-Only Split] Error slicing custom chat: ${err.message}`);
          }
          if (!preserveTaskOnSuccess) removeTask(taskId);
          return generatedChatFiles;
        }

        // 2. Multi-Game or Buffered Game Slicing in Chat-Only Mode
        if (games.length > 0) {
          let anyChatOnlySliceError = false;
          const datasetPreview = await loadUnifiedChatDataset(chatFilePath, session);
          let maxCommentSec = 0;
          if (datasetPreview?.comments && datasetPreview.comments.length > 0) {
            for (const c of datasetPreview.comments) {
              const off = Number(c.content_offset_seconds) || 0;
              if (off > maxCommentSec) maxCommentSec = off;
            }
          }

          const avgChunkDur = getAverageSegmentDuration(folderPath, 2.0);
          for (let i = 0; i < games.length; i++) {
            if (targetGameIdxSpec !== undefined && targetGameIdxSpec !== i) continue;
            if (!isMidStreamExport && games[i].isExported) continue;

            const game = games[i];
            const nextGame = games[i + 1];
            const cleanName = game.gameName.replace(/[^a-z0-9]/gi, '_').toLowerCase();

            try {
              const baseOffsetSec = session?.initialJoinOffsetSec ?? specInitialJoinOffsetSec ?? 0;
              const baseSeq = session?.firstSeqNum ?? specFirstSeqNum ?? 0;
              const broadcastStartMs = session?.streamCreatedAtMs || session?.videoStartTimeMs || specStreamCreatedAtMs;
              const leadBufSec = ((game.customLeadingBufferMins !== undefined && Number.isFinite(game.customLeadingBufferMins) && game.customLeadingBufferMins >= 0)
                ? game.customLeadingBufferMins
                : bufferMins) * 60;
              const trailBufSec = game.overrideBuffer ? 0 : (bufferMins * 60);

              let videoStartOffset = baseOffsetSec;
              if (i > 0) {
                if (broadcastStartMs && game.startTimeMs && game.startTimeMs >= broadcastStartMs) {
                  videoStartOffset = Math.max(0, ((game.startTimeMs - broadcastStartMs) / 1000) - leadBufSec);
                } else {
                  const fallbackGameSec = game.startTimeOffset || Math.max(0, getSignedElapsedDurationBetweenChunks(folderPath, 0, game.startChunk, avgChunkDur));
                  videoStartOffset = Math.max(0, fallbackGameSec - leadBufSec);
                }
              }

              let videoEndOffset = videoStartOffset + 60;
              if (nextGame) {
                if (broadcastStartMs && nextGame.startTimeMs && nextGame.startTimeMs >= broadcastStartMs) {
                  videoEndOffset = Math.max(videoStartOffset + 1, ((nextGame.startTimeMs - broadcastStartMs) / 1000) + trailBufSec);
                } else {
                  const fallbackNextSec = nextGame.startTimeOffset || Math.max(0, getSignedElapsedDurationBetweenChunks(folderPath, 0, nextGame.startChunk, avgChunkDur));
                  videoEndOffset = Math.max(videoStartOffset + 1, fallbackNextSec + trailBufSec);
                }
              } else {
                const liveElapsed = broadcastStartMs ? Math.max(0, (Date.now() - broadcastStartMs) / 1000) : 0;
                videoEndOffset = Math.max(
                  videoStartOffset + 1,
                  session?.videoDurationSeconds || 0,
                  specVideoDurationSec || 0,
                  liveElapsed,
                  maxCommentSec
                );
              }

              const actualDurationSec = Math.max(1, Math.round(videoEndOffset - videoStartOffset));
              game.endChunk = Math.floor(videoEndOffset / avgChunkDur);

              const gapAdjustments = session?.gapAdjustments || specGapAdjustments || [];
              const outChatPath = path.join(folderPath, `${i + 1}_${cleanName}_${dateStr}.json`);

              const sliceResult = await compileChatSlice({
                sourceChatFilePath: chatFilePath,
                outputFilePath: outChatPath,
                channelLogin,
                folderPath,
                session,
                startOffsetSec: videoStartOffset,
                endOffsetSec: videoEndOffset,
                durationSec: actualDurationSec,
                gameName: game.gameName,
                gapAdjustments,
                baseOffsetSec,
                baseSeq,
                avgChunkDur,
              });

              if (!sliceResult) {
                throw new Error("Unable to compile valid chat slice from session dataset");
              }

              generatedChatFiles.push(path.basename(outChatPath));
              addLog(`[Chat-Only Split] Sliced chat for ${game.gameName} -> ${outChatPath} (${sliceResult.commentCount} messages, ${sliceResult.eventCount} events, ${actualDurationSec}s, range ${videoStartOffset.toFixed(1)}s - ${videoEndOffset.toFixed(1)}s)`);
            } catch (err: any) {
              anyChatOnlySliceError = true;
              addLog(`[Chat-Only Split] Error processing game chat ${cleanName}: ${err.message}`);
            }
          }

          if (!isMidStreamExport && !anyChatOnlySliceError && generatedChatFiles.length > 0) {
            addLog(`[Chat-Only] Cleaning up original full broadcast chat journal & master artifacts...`);
            await cleanupMasterChatArtifacts(chatFilePath);
          }
        } else if (!isMidStreamExport) {
          // Single-game broadcast conclusion without game array: seal journal into master JSON
          await repairChatJsonFile(chatFilePath);
          if (fs.existsSync(chatFilePath)) {
            generatedChatFiles.push(path.basename(chatFilePath));
          }
        }

        if (!preserveTaskOnSuccess) removeTask(taskId);
        return generatedChatFiles;
      }

      addLog(`[Video] No live sequence files found to stitch.`);
      if (!preserveTaskOnSuccess) removeTask(taskId);
      return [];
    }

    // Create Full Broadcast Backup First (Only if this is the final export, not mid-stream)
    if (!isMidStreamExport && games.length === 0) {
      if (liveChunkFiles.length > 0) {
        try {
          await stitchGroup(liveChunkFiles, `full_broadcast_${dateStr}.ts`, 'Full Broadcast');
        } catch (err: any) {
          addLog(`[Video Warning] Full broadcast stitching failed: ${err.message}`);
        }
      }
    }

    // Slice by Games
    const activeChunkList = liveChunkFiles;

    // Custom Export Handling (Option 1 Append Extension, Option 2 Extract Standalone Clip)
    if (customExportMode && customChunkRange) {
      const { startIdx, endIdx } = customChunkRange;
      const videoOutputName = customOutputName || `custom_${Date.now()}.ts`;
      const chatOutputName = customChatOutputName || videoOutputName.replace(/\.ts$/, '.json');

      const customChunks = activeChunkList.filter(f => {
        const idx = getChunkIndex(f);
        return idx >= startIdx && idx <= endIdx;
      });

      if (customChunks.length === 0) {
        addLog(`[Video Warning] No chunks found in custom range ${startIdx} - ${endIdx}`);
        if (!preserveTaskOnSuccess) removeTask(taskId);
        return [];
      }

      addLog(`[Video] Slicing custom export (${customExportMode}) with ${customChunks.length} chunks (range ${startIdx} - ${endIdx})...`);
      let customDuration = 0;
      try {
        customDuration = await stitchGroup(customChunks, videoOutputName, taskObj?.name || 'Custom Slice');
        successfullyStitchedMp4s.push(videoOutputName.replace(/\.ts$/, '.mp4'));
      } catch (err: any) {
        addLog(`[Video Warning] Custom slice video stitching failed: ${err.message}. Proceeding with chat slice...`);
      }

      // Split Chat File for Custom Slice (skip in video_only mode)
      const sessionAvgChunkDur = getAverageSegmentDuration(folderPath, 2.0);
      let customAvgChunkDur = sessionAvgChunkDur;
      if (captureMode !== 'video_only' && chatFilePath && hasChatSource(chatFilePath)) {
        try {
          if (session) {
            flushPendingChatWrites(session);
          }

          const firstChunkInVideo = getChunkIndex(customChunks[0]);
          const lastChunkInVideo = getChunkIndex(customChunks[customChunks.length - 1]);
          const fallbackCustomDur = Math.max(
            1,
            Math.round(Math.abs(getSignedElapsedDurationBetweenChunks(folderPath, firstChunkInVideo, lastChunkInVideo + 1, sessionAvgChunkDur)))
          );
          const actualVideoDurationSec = customDuration > 0 ? customDuration : fallbackCustomDur;
          const avgChunkDur = customChunks.length > 0 ? (actualVideoDurationSec / customChunks.length) : sessionAvgChunkDur;
          customAvgChunkDur = avgChunkDur;

          const baseOffsetSec = session?.initialJoinOffsetSec ?? specInitialJoinOffsetSec ?? 0;
          const baseSeq = session?.firstSeqNum ?? specFirstSeqNum ?? (activeChunkList.length > 0 ? getChunkIndex(activeChunkList[0]) : 0);
          const broadcastStartMs = session?.streamCreatedAtMs || session?.videoStartTimeMs || specStreamCreatedAtMs;
          const targetGameIdx = targetGameIdxSpec;
          const targetGame = (targetGameIdx !== undefined && games[targetGameIdx])
            ? games[targetGameIdx]
            : games.find(g => g.gameName === specGameName);

          let videoStartOffset = Math.max(
            0,
            baseOffsetSec + Math.max(0, getSignedElapsedDurationBetweenChunks(folderPath, baseSeq, firstChunkInVideo, avgChunkDur))
          );
          if (targetGame && targetGameIdx !== undefined && targetGameIdx > 0 && broadcastStartMs && targetGame.startTimeMs && targetGame.startTimeMs >= broadcastStartMs) {
            const gameSwitchOffsetSec = (targetGame.startTimeMs - broadcastStartMs) / 1000;
            const deltaSec = getSignedElapsedDurationBetweenChunks(folderPath, targetGame.startChunk, firstChunkInVideo, avgChunkDur);
            videoStartOffset = Math.max(0, gameSwitchOffsetSec + deltaSec);
          } else if (targetGame && targetGame.startTimeOffset !== undefined && targetGame.startTimeOffset > 0 && targetGame.startChunk > 0) {
            const deltaSec = getSignedElapsedDurationBetweenChunks(folderPath, targetGame.startChunk, firstChunkInVideo, avgChunkDur);
            videoStartOffset = Math.max(0, targetGame.startTimeOffset + deltaSec);
          }

          const videoEndOffset = videoStartOffset + actualVideoDurationSec;
          const gapAdjustments = session?.gapAdjustments || specGapAdjustments || [];
          const outChatPath = path.join(folderPath, chatOutputName);

          const sliceResult = await compileChatSlice({
            sourceChatFilePath: chatFilePath,
            outputFilePath: outChatPath,
            channelLogin,
            folderPath,
            session,
            startOffsetSec: videoStartOffset,
            endOffsetSec: videoEndOffset,
            durationSec: actualVideoDurationSec,
            gameName: specGameName || targetGame?.gameName,
            gapAdjustments,
            baseOffsetSec,
            baseSeq,
            avgChunkDur,
          });

          if (sliceResult) {
            generatedChatFiles.push(path.basename(outChatPath));
            addLog(`[Chat Split] Sliced chat for custom export -> ${outChatPath} (${sliceResult.commentCount} messages, ${sliceResult.eventCount} events, ${actualVideoDurationSec.toFixed(1)}s)`);
          }
        } catch (err: any) {
          addLog(`[Chat Split] Error processing custom chat slice: ${err.message}`);
        }
      }

      // Cleanup chunks if not skipped (Extract clip skips chunk cleanup to preserve stream history)
      if (!skipChunkCleanup && customExportMode === 'append_previous') {
        try {
          const leadBufferChunks = computeChunkCountForDuration(folderPath, endIdx, CHAT_BUFFER_SEC, 'backward', customAvgChunkDur);
          const nextBufferStartIdx = Math.max(0, endIdx - leadBufferChunks);
          const currentDirFiles = await fs.promises.readdir(folderPath);
          const obsoleteChunks: string[] = [];
          for (const file of currentDirFiles) {
            if (file.startsWith('seq_') && file.endsWith('.ts')) {
              const idx = getChunkIndex(file);
              if (!isNaN(idx) && idx < nextBufferStartIdx) {
                obsoleteChunks.push(file);
              }
            }
          }
          if (obsoleteChunks.length > 0) {
            addLog(`[Video] Purging ${obsoleteChunks.length} obsolete .ts sequence files (chunks < ${nextBufferStartIdx}, prior to leading buffer)...`);
            let deletedCount = 0;
            for (const chunk of obsoleteChunks) {
              try {
                await fs.promises.unlink(path.join(folderPath, chunk));
                deletedCount++;
              } catch (e) {}
            }
            addLog(`[Video] Cleaned up ${deletedCount} obsolete .ts sequence files.`);
          }
        } catch (delErr: any) {
          addLog(`[Video] Non-fatal error cleaning up obsolete sequence files: ${delErr.message}`);
        }
      }

      return generatedChatFiles;
    }

    let anyGameChatSliceFailed = false;

    if (games.length > 0 && activeChunkList.length > 0) {
      addLog(`[Video] Detected ${games.length} game segments. Slicing with ${bufferMins}-minute boundaries...`);

      for (let i = 0; i < games.length; i++) {
        if (targetGameIdxSpec !== undefined && targetGameIdxSpec !== i) continue;
        if (!isMidStreamExport && games[i].isExported) continue;

        const game = games[i];
        const nextGame = games[i + 1];
        const cleanName = game.gameName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        
        const videoOutputName = `${i + 1}_${cleanName}_${dateStr}.ts`;
        
        const leadBufSec = ((game.customLeadingBufferMins !== undefined && Number.isFinite(game.customLeadingBufferMins) && game.customLeadingBufferMins >= 0)
          ? game.customLeadingBufferMins
          : bufferMins) * 60;
        const gameLeadingBufferChunks = computeChunkCountForDuration(folderPath, game.startChunk, leadBufSec, 'backward');
        const trailingBufferChunks = nextGame
          ? computeChunkCountForDuration(folderPath, nextGame.startChunk, CHAT_BUFFER_SEC, 'forward')
          : 0;

        let startIdx = i === 0 ? 0 : Math.max(0, game.startChunk - gameLeadingBufferChunks);
        // Rule 8: preserve all recorded buffer chunks up to min(lastChunk, nextGame.startChunk + trailingBufferChunks)
        let endIdx = nextGame 
          ? Math.min(getChunkIndex(activeChunkList[activeChunkList.length - 1]), nextGame.startChunk + trailingBufferChunks)
          : Infinity;

        const gameChunks = activeChunkList.filter(f => {
          const idx = getChunkIndex(f);
          return idx >= startIdx && idx <= endIdx;
        });

        if (gameChunks.length > 0) {
          game.endChunk = getChunkIndex(gameChunks[gameChunks.length - 1]);
        }

        let gameDuration = 0;
        let stitchError: Error | null = null;
        try {
          gameDuration = await stitchGroup(gameChunks, videoOutputName, `Game ${i + 1} (${game.gameName})`);
        } catch (err: any) {
          stitchError = err;
          addLog(`[Video Warning] Video stitching failed for Game ${i + 1} (${game.gameName}): ${err.message}. Proceeding with chat slicing...`);
        }

        // Once a game is spliced, compiled, and verified (stitchGroup guarantees valid output),
        // delete .ts segments that will no longer be used (i.e. not in the buffer for the next segment)
        if (!stitchError && gameDuration > 0) {
          try {
            const currentDirFiles = await fs.promises.readdir(folderPath);
            const obsoleteChunks: string[] = [];

            if (nextGame) {
              // Next game will need chunks starting from (nextGame.startChunk - nextLeadingBufferChunks)
              const nextLeadSec = ((nextGame.customLeadingBufferMins !== undefined && Number.isFinite(nextGame.customLeadingBufferMins) && nextGame.customLeadingBufferMins >= 0)
                ? nextGame.customLeadingBufferMins
                : bufferMins) * 60;
              const nextLeadingBufferChunks = computeChunkCountForDuration(folderPath, nextGame.startChunk, nextLeadSec, 'backward');
              const nextBufferStartIdx = Math.max(0, nextGame.startChunk - nextLeadingBufferChunks);
              for (const file of currentDirFiles) {
                if (file.startsWith('seq_') && file.endsWith('.ts')) {
                  const idx = getChunkIndex(file);
                  if (!isNaN(idx) && idx < nextBufferStartIdx) {
                    obsoleteChunks.push(file);
                  }
                }
              }

              if (obsoleteChunks.length > 0) {
                addLog(`[Video] Purging ${obsoleteChunks.length} obsolete .ts sequence files (chunks < ${nextBufferStartIdx}, prior to ${nextGame.gameName} buffer)...`);
                let deletedCount = 0;
                for (const chunk of obsoleteChunks) {
                  try {
                    await fs.promises.unlink(path.join(folderPath, chunk));
                    deletedCount++;
                  } catch (e) {}
                }
                addLog(`[Video] Cleaned up ${deletedCount} obsolete .ts sequence files.`);
              }
            } else if (!isMidStreamExport) {
              // Final game of the broadcast: purge all chunks up to endIdx
              for (const file of currentDirFiles) {
                if (file.startsWith('seq_') && file.endsWith('.ts')) {
                  const idx = getChunkIndex(file);
                  if (!isNaN(idx) && idx <= endIdx) {
                    obsoleteChunks.push(file);
                  }
                }
              }

              if (obsoleteChunks.length > 0) {
                addLog(`[Video] Purging ${obsoleteChunks.length} completed .ts sequence files for final game (${game.gameName})...`);
                let deletedCount = 0;
                for (const chunk of obsoleteChunks) {
                  try {
                    await fs.promises.unlink(path.join(folderPath, chunk));
                    deletedCount++;
                  } catch (e) {}
                }
                addLog(`[Video] Cleaned up ${deletedCount} completed .ts sequence files.`);
              }
            }
          } catch (delErr: any) {
            addLog(`[Video] Non-fatal error cleaning up obsolete sequence files: ${delErr.message}`);
          }
        } else {
          addLog(`[Video] Preserving sequence files for Game ${i + 1} (${game.gameName}) for recovery.`);
        }

        // Split Chat File (skip in video_only mode)
        if (captureMode !== 'video_only' && chatFilePath && hasChatSource(chatFilePath)) {
          try {
            if (session) {
              flushPendingChatWrites(session);
            }

            const firstChunkInVideo = gameChunks.length > 0 ? getChunkIndex(gameChunks[0]) : game.startChunk;
            const lastChunkInVideo = gameChunks.length > 0 ? getChunkIndex(gameChunks[gameChunks.length - 1]) : firstChunkInVideo;
            const fallbackGameDur = gameChunks.length > 0
              ? Math.max(1, Math.round(Math.abs(getSignedElapsedDurationBetweenChunks(folderPath, firstChunkInVideo, lastChunkInVideo + 1, 2.0))))
              : 1;
            const actualVideoDurationSec = gameDuration > 0 ? gameDuration : fallbackGameDur;
            const avgChunkDur = gameChunks.length > 0 ? (actualVideoDurationSec / gameChunks.length) : getAverageSegmentDuration(folderPath, 2.0);

            // Accurate start offset determination anchored to real presentation timeline + SegmentTimelineIndex
            const baseOffsetSec = session?.initialJoinOffsetSec ?? specInitialJoinOffsetSec ?? 0;
            const baseSeq = session?.firstSeqNum ?? specFirstSeqNum ?? (activeChunkList.length > 0 ? getChunkIndex(activeChunkList[0]) : 0);
            const broadcastStartMs = session?.streamCreatedAtMs || session?.videoStartTimeMs || specStreamCreatedAtMs;
            let videoStartOffset = Math.max(
              0,
              baseOffsetSec + Math.max(0, getSignedElapsedDurationBetweenChunks(folderPath, baseSeq, firstChunkInVideo, avgChunkDur))
            );

            if (i > 0 && broadcastStartMs && game.startTimeMs && game.startTimeMs >= broadcastStartMs) {
              const gameSwitchOffsetSec = (game.startTimeMs - broadcastStartMs) / 1000;
              const deltaSec = getSignedElapsedDurationBetweenChunks(folderPath, game.startChunk, firstChunkInVideo, avgChunkDur);
              // If firstChunkInVideo is before startChunk (leading buffer), deltaSec is negative and subtracts exact recorded buffer duration
              videoStartOffset = Math.max(0, gameSwitchOffsetSec + deltaSec);
              addLog(`[Chat Split] Anchored ${game.gameName} start offset to real stream timeline: ${videoStartOffset.toFixed(1)}s (Switch: ${gameSwitchOffsetSec.toFixed(1)}s, DeltaSec: ${deltaSec.toFixed(2)}s, AvgChunk: ${avgChunkDur.toFixed(3)}s)`);
            } else if (i === 0) {
              addLog(`[Chat Split] Anchored initial game ${game.gameName} start offset to broadcast timeline: ${videoStartOffset.toFixed(1)}s (joinOffset: ${baseOffsetSec}s, firstChunk: ${firstChunkInVideo}, baseSeq: ${baseSeq}, avgChunk: ${avgChunkDur.toFixed(3)}s)`);
            } else if (game.startTimeOffset !== undefined && game.startTimeOffset > 0) {
              const deltaSec = getSignedElapsedDurationBetweenChunks(folderPath, game.startChunk, firstChunkInVideo, avgChunkDur);
              videoStartOffset = Math.max(0, game.startTimeOffset + deltaSec);
            }

            const videoEndOffset = videoStartOffset + actualVideoDurationSec;
            const gapAdjustments = session?.gapAdjustments || specGapAdjustments || [];
            const outChatPath = path.join(folderPath, `${i + 1}_${cleanName}_${dateStr}.json`);

            const sliceResult = await compileChatSlice({
              sourceChatFilePath: chatFilePath,
              outputFilePath: outChatPath,
              channelLogin,
              folderPath,
              session,
              startOffsetSec: videoStartOffset,
              endOffsetSec: videoEndOffset,
              durationSec: actualVideoDurationSec,
              gameName: game.gameName,
              gapAdjustments,
              baseOffsetSec,
              baseSeq,
              avgChunkDur,
            });

            if (!sliceResult) {
              throw new Error("Unable to compile valid chat slice from session dataset");
            }

            generatedChatFiles.push(path.basename(outChatPath));
            addLog(`[Chat Split] Sliced chat for ${game.gameName} -> ${outChatPath} (${sliceResult.commentCount} messages, ${sliceResult.eventCount} events)`);
          } catch (err: any) {
            anyGameChatSliceFailed = true;
            addLog(`[Chat Split] Error processing game chat ${cleanName}: ${err.message}`);
          }
        }
      }
    }

    // Cleanup chunks last (Only if not mid-stream export and at least one stitch succeeded)
    if (!isMidStreamExport && successfullyStitchedMp4s.length > 0) {
      try {
        const remainingEntries = await fs.promises.readdir(folderPath);
        const remainingLive = remainingEntries.filter(f => f.startsWith('seq_') && f.endsWith('.ts'));

        if (remainingLive.length > 0) {
          addLog(`[Video] Cleaning up ${remainingLive.length} remaining live sequence files...`);
          for (const chunk of remainingLive) {
            try {
              await fs.promises.unlink(path.join(folderPath, chunk));
            } catch (e) {}
          }
        }
      } catch (e) {}

      // Only cleanup full chat file & journal sidecars if game splitting was successful (and not during mid-stream export)
      if (!isMidStreamExport && games.length > 0 && chatFilePath && hasChatSource(chatFilePath)) {
        if (!anyGameChatSliceFailed && (captureMode === 'video_only' || generatedChatFiles.length > 0)) {
          addLog(`[Video] Cleaning up original full broadcast chat file & journal sidecars...`);
          await cleanupMasterChatArtifacts(chatFilePath);
        } else if (anyGameChatSliceFailed) {
          addLog(`[Video] Retaining original broadcast chat artifacts due to chat processing errors so data is not lost.`);
        }
      } else if (!isMidStreamExport && games.length === 0 && captureMode !== 'video_only' && chatFilePath && hasChatSource(chatFilePath)) {
        // Single-game full broadcast conclusion: ensure journal is sealed into master JSON
        await repairChatJsonFile(chatFilePath);
      }
    }

    if (successfullyStitchedMp4s.length === 0 && games.length > 0 && generatedChatFiles.length > 0) {
      updateTask(taskId, "Video Stitching Issue", `Video stitching encountered an issue, but ${generatedChatFiles.length} chat segment(s) were generated.`, "error", true, [
        { label: "Retry", value: "retry_stitch" },
        { label: "Dismiss", value: "dismiss" }
      ]);
      if (state.activeTasks[taskId]) {
        state.activeTasks[taskId].retrySpec = spec;
      }
    } else if (!preserveTaskOnSuccess) {
      removeTask(taskId);
    }
    return generatedChatFiles;
  } catch (err: any) {
    addLog(`[Video] Error during video stitching: ${err.message}`);
    const taskName = state.activeTasks[taskId]?.name || "Stitching Video";
    updateTask(taskId, taskName, `Notice: ${err.message}`, "error", true, [
      { label: "Retry", value: "retry_stitch" },
      { label: "Dismiss", value: "dismiss" }
    ]);
    if (state.activeTasks[taskId]) {
      state.activeTasks[taskId].folderPath = folderPath;
      state.activeTasks[taskId].retrySpec = spec;
    }
    return generatedChatFiles || [];
  }
}

