import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ActiveTask, ActiveDownloadSession, Config } from "../types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findProjectRoot(): string {
  let curr = __dirname;
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(curr, "package.json")) || fs.existsSync(path.join(curr, "config.json"))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return process.cwd();
}

export const PROJECT_ROOT = findProjectRoot();
export const CONFIG_FILE = path.join(PROJECT_ROOT, "config.json");
export const CONFIG_BAK_FILE = path.join(PROJECT_ROOT, "config.json.bak");
export const STATE_FILE = path.join(PROJECT_ROOT, "state.json");
export const LOG_FILE = path.join(PROJECT_ROOT, "system.log");
export const LOG_ROTATED_FILE = path.join(PROJECT_ROOT, "system.log.1");
export const MAX_LOG_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB max system.log before rotation
export const TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days TTL for completed tasks

export const DEFAULT_TWITCH_BROWSER_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
export const LEGACY_TWITCH_BROWSER_CLIENT_ID = "kimne78kx3ncx6brs4h587w9fpb";

export function cleanChannelName(channel: string): string {
  if (!channel) return "";
  let cleaned = channel.toLowerCase().trim().replace(/^@/, '');
  try {
    const urlString = cleaned.startsWith('http') ? cleaned : `https://${cleaned}`;
    const url = new URL(urlString);
    if (url.hostname.includes('twitch.tv')) {
      cleaned = url.pathname.split('/').filter(Boolean)[0] || cleaned;
    }
  } catch (e) {}
  cleaned = cleaned.replace(/^(https?:\/\/)?(www\.)?twitch\.tv\//, '').split('?')[0].replace(/\/$/, '').replace(/[^a-z0-9_]/g, '');
  return cleaned.trim();
}

export function normalizeConfigSavePath(inputPath: any): string {
  if (!inputPath || typeof inputPath !== "string") {
    return "downloads";
  }
  let p = inputPath.trim();
  if (!p || p === "." || p === "./" || p === ".\\") {
    return "downloads";
  }

  // If path contains NewDownloader (the old hardcoded directory)
  if (p.toLowerCase().includes("newdownloader")) {
    return "downloads";
  }

  // Disallow escaping upward with ..
  if (p.includes("..")) {
    return "downloads";
  }

  // If it's an absolute path
  if (path.isAbsolute(p)) {
    // If it points inside PROJECT_ROOT, convert to relative
    const rel = path.relative(PROJECT_ROOT, p);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel || "downloads";
    }
    // If it points to an old nonexistent absolute folder ending in "downloads"
    if (!fs.existsSync(p) && path.basename(p).toLowerCase() === "downloads") {
      return "downloads";
    }
    // If it ends with "downloads" and is not inside PROJECT_ROOT
    if (path.basename(p).toLowerCase() === "downloads") {
      return "downloads";
    }
  }

  // Normalize slashes for relative path
  return p.replace(/^[./\\]+/, "");
}

export function getResolvedSavePath(configuredPath?: string): string {
  const norm = normalizeConfigSavePath(configuredPath !== undefined ? configuredPath : state.config?.savePath);
  return path.resolve(PROJECT_ROOT, norm);
}

export function resolveTdPath(configuredTdPath?: string): string {
  const raw = (configuredTdPath !== undefined ? configuredTdPath : state.config?.tdPath)?.trim();
  if (raw) {
    const candidate = path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
    if (fs.existsSync(candidate)) return candidate;
  }
  // Check relative candidates in PROJECT_ROOT
  const rootCandidates = [
    path.join(PROJECT_ROOT, "TwitchDownloader", process.platform === "win32" ? "TwitchDownloaderCLI.exe" : "TwitchDownloaderCLI"),
    path.join(PROJECT_ROOT, process.platform === "win32" ? "TwitchDownloaderCLI.exe" : "TwitchDownloaderCLI"),
    path.join(PROJECT_ROOT, "bin", process.platform === "win32" ? "TwitchDownloaderCLI.exe" : "TwitchDownloaderCLI")
  ];
  for (const cand of rootCandidates) {
    if (fs.existsSync(cand)) return cand;
  }
  if (raw && !path.isAbsolute(raw)) {
    return path.resolve(PROJECT_ROOT, raw);
  }
  return raw || "C:\\TwitchDownloader\\TwitchDownloaderCLI.exe";
}

export const defaultConfig: Config = {
  browserClientId: DEFAULT_TWITCH_BROWSER_CLIENT_ID,
  browserOAuthToken: "",
  channels: [],
  savePath: "downloads",
  notifyOnStart: true,
  notifyOnEnd: true,
  isMonitoring: false,
  autoStartMonitoring: false,
  autoRenderChat: false,
  channelAutoRender: {},
  gameSwitchBufferMins: 5,
  offlineGracePeriodMins: 5,
  longGameAutospliceEnabled: true,
  longGameAutospliceTriggerHours: 9,
  longGameAutospliceCutHours: 8,
  tdPath: "C:\\TwitchDownloader\\TwitchDownloaderCLI.exe",
  chatRender: {
    syncOffset: -2.5,
    syncOffsetHevc: -7.5,
    width: 350,
    height: 800,
    backgroundColor: "#111111",
    altBackgroundColor: "#191919",
    alternateBackgrounds: false,
    messageColor: "#ffffff",
    font: "Inter",
    fontSize: 24,
    messageFontStyle: "normal",
    usernameFontStyle: "bold",
    outline: false,
    outlineSize: 4,
    framerate: 60,
    updateRate: 0,
    generateMask: false,
    bttv: true,
    ffz: true,
    stv: true,
    giphy: true,
    allowUnlistedEmotes: true,
    badges: true,
    subMessages: true,
    dispersion: false,
    offline: false,
    avatars: false,
    readableColors: true,
    sharpening: false,
    emojiVendor: "notocolor",
    scaleEmote: 1.0,
    scaleBadge: 1.0,
    scaleEmoji: 1.0,
    scaleAvatar: 1.0,
    scaleVertical: 0.5,
    scaleSidePadding: 1.0,
    scaleSectionHeight: 1.0,
    scaleWordSpace: 1.0,
    scaleEmoteSpace: 1.0,
    scaleHighlightStroke: 1.0,
    scaleHighlightIndent: 1.0,
    ignoreUsers: "",
    bannedWords: "",
    format: "mp4",
    codec: "h264",
    badgeFilter: 0
  }
};

export const state = {
  config: { ...defaultConfig },
  monitoringInterval: null as NodeJS.Timeout | null,
  activeTasks: {} as Record<string, ActiveTask>,
  activeProcesses: {} as Record<string, any>,
  activeDownloadSessions: {} as Record<string, ActiveDownloadSession>,
  logs: [] as string[],
  monitoredChannels: [] as string[],
  lastCheckTime: null as number | null,
  hasLoggedInitialCheck: false
};

let logCheckCounter = 0;
let isRotatingLog = false;

export function checkAndRotateLogFile() {
  if (isRotatingLog) return;
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stats = fs.statSync(LOG_FILE);
    if (stats.size >= MAX_LOG_SIZE_BYTES) {
      isRotatingLog = true;
      try {
        if (fs.existsSync(LOG_ROTATED_FILE)) {
          try {
            fs.unlinkSync(LOG_ROTATED_FILE);
          } catch {}
        }
        fs.renameSync(LOG_FILE, LOG_ROTATED_FILE);
        const header = `[${new Date().toISOString()}] [Log Rotation] Previous log rotated to system.log.1 (reached ${(stats.size / (1024 * 1024)).toFixed(1)}MB threshold)\n`;
        fs.writeFileSync(LOG_FILE, header, "utf-8");
      } finally {
        isRotatingLog = false;
      }
    }
  } catch (err) {
    isRotatingLog = false;
    console.error("Error during log rotation check:", err);
  }
}

export const addLog = (msg: string) => {
  if (!msg) return;
  const now = new Date();
  const timestamp = now.toLocaleTimeString();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const localDateStr = `${year}-${month}-${day}`;

  logCheckCounter++;
  if (logCheckCounter >= 25) {
    logCheckCounter = 0;
    checkAndRotateLogFile();
  }

  // If msg contains multiple lines (e.g. stack traces, multi-line error outputs), preserve every line
  const rawLines = String(msg).split(/\r?\n/);
  for (const line of rawLines) {
    if (!line && rawLines.length > 1) continue;
    const logMsg = `[${timestamp}] ${line}`;
    console.log(logMsg);
    state.logs.push(logMsg);
    // Keep last 300 logs in memory for debugging inspection
    if (state.logs.length > 300) state.logs.shift();

    const fileLogMessage = `[${localDateStr} ${timestamp}] ${line}\n`;
    fs.appendFile(LOG_FILE, fileLogMessage, (err) => {
      if (err) console.error("Failed to write to log file:", err);
    });
  }
};

export function serializeDownloadedSegments(set: Set<string | number> | undefined): any {
  if (!set || set.size === 0) return { liveRanges: [], vodRanges: [] };

  const liveNums: number[] = [];
  const vodNums: number[] = [];
  const other: (string | number)[] = [];

  for (const item of set) {
    if (typeof item === 'number') {
      liveNums.push(item);
    } else if (typeof item === 'string' && item.startsWith('vod_')) {
      const n = parseInt(item.slice(4), 10);
      if (!isNaN(n)) vodNums.push(n);
      else other.push(item);
    } else {
      other.push(item);
    }
  }

  const toRanges = (nums: number[]): [number, number][] => {
    if (nums.length === 0) return [];
    nums.sort((a, b) => a - b);
    const ranges: [number, number][] = [];
    let start = nums[0];
    let end = nums[0];

    for (let i = 1; i < nums.length; i++) {
      if (nums[i] === end + 1) {
        end = nums[i];
      } else if (nums[i] > end + 1) {
        ranges.push([start, end]);
        start = nums[i];
        end = nums[i];
      }
    }
    ranges.push([start, end]);
    return ranges;
  };

  return {
    liveRanges: toRanges(liveNums),
    vodRanges: toRanges(vodNums),
    ...(other.length > 0 ? { other } : {})
  };
}

export function deserializeDownloadedSegments(data: any): Set<string | number> {
  const set = new Set<string | number>();
  if (!data) return set;

  // Backward compatibility: if data is a raw array from older versions
  if (Array.isArray(data)) {
    for (const item of data) {
      set.add(item);
    }
    return set;
  }

  // New compact format with ranges
  if (Array.isArray(data.liveRanges)) {
    for (const range of data.liveRanges) {
      if (Array.isArray(range) && range.length === 2) {
        for (let i = range[0]; i <= range[1]; i++) {
          set.add(i);
        }
      }
    }
  }

  if (Array.isArray(data.vodRanges)) {
    for (const range of data.vodRanges) {
      if (Array.isArray(range) && range.length === 2) {
        for (let i = range[0]; i <= range[1]; i++) {
          set.add(`vod_${i}`);
        }
      }
    }
  }

  if (Array.isArray(data.other)) {
    for (const item of data.other) {
      set.add(item);
    }
  }

  return set;
}

function getSerializableSessions() {
  return Object.fromEntries(
    Object.entries(state.activeDownloadSessions).map(([channel, session]) => [
      channel,
      {
        channel: session.channel,
        streamId: session.streamId,
        startTime: session.startTime,
        chunksDownloaded: session.chunksDownloaded,
        folderPath: session.folderPath,
        segmentsFile: session.segmentsFile,
        currentTitle: session.currentTitle,
        currentGame: session.currentGame,
        viewersCount: session.viewersCount,
        previewImageUrl: session.previewImageUrl,
        mediaPlaylistUrl: session.mediaPlaylistUrl,
        highestSeq: session.highestSeq,
        commentsWritten: session.commentsWritten,
        games: session.games,
        chatFilePath: session.chatFilePath,
        videoDurationSeconds: session.videoDurationSeconds,
        videoStartTimeMs: session.videoStartTimeMs,
        streamCreatedAtMs: session.streamCreatedAtMs,
        initialJoinOffsetSec: session.initialJoinOffsetSec,
        firstSeqNum: session.firstSeqNum,
        gapAdjustments: session.gapAdjustments,
        missingCount: session.missingCount,
        downloadedSegments: serializeDownloadedSegments(session.downloadedSegments),
        autoRenderChat: session.autoRenderChat
      }
    ])
  );
}

let stateSaveTimeout: NodeJS.Timeout | null = null;
let isSavingState = false;
let pendingStateSave = false;

function executeStateSave() {
  if (isSavingState) {
    pendingStateSave = true;
    return;
  }
  isSavingState = true;
  try {
    const serializableSessions = getSerializableSessions();
    const tempFile = `${STATE_FILE}.tmp`;
    fs.promises.writeFile(tempFile, JSON.stringify({
      activeDownloadSessions: serializableSessions,
      activeTasks: state.activeTasks
    }), "utf-8")
      .then(() => fs.promises.rename(tempFile, STATE_FILE))
      .catch(err => console.error("Failed to save state.json dynamically", err))
      .finally(() => {
        isSavingState = false;
        if (pendingStateSave) {
          pendingStateSave = false;
          executeStateSave();
        }
      });
  } catch (err) {
    isSavingState = false;
    console.error("Failed to save state.json", err);
    if (pendingStateSave) {
      pendingStateSave = false;
      executeStateSave();
    }
  }
}

export function scheduleStateSave(immediate = false) {
  if (immediate) {
    if (stateSaveTimeout) {
      clearTimeout(stateSaveTimeout);
      stateSaveTimeout = null;
    }
    executeStateSave();
    return;
  }
  if (stateSaveTimeout) return;
  stateSaveTimeout = setTimeout(() => {
    stateSaveTimeout = null;
    executeStateSave();
  }, 2500);
}

export function flushStateSync() {
  if (stateSaveTimeout) {
    clearTimeout(stateSaveTimeout);
    stateSaveTimeout = null;
  }
  try {
    const serializableSessions = getSerializableSessions();
    const tempFile = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify({
      activeDownloadSessions: serializableSessions,
      activeTasks: state.activeTasks
    }), "utf-8");
    fs.renameSync(tempFile, STATE_FILE);
  } catch (err) {
    console.error("Failed to flush state.json synchronously", err);
  }
}

export const updateTask = (
  id: string,
  name: string,
  progressText: string,
  status: 'running' | 'success' | 'error' | 'cancelled' = 'running',
  actionRequired = false,
  actions?: { label: string; value: string }[]
) => {
  const now = Date.now();
  const existing = state.activeTasks[id];
  const createdAt = existing?.createdAt || now;
  const isTerminal = status === 'success' || status === 'cancelled';
  const completedAt = isTerminal ? (existing?.completedAt || now) : undefined;

  if (existing) {
    state.activeTasks[id] = {
      ...existing,
      name,
      progressText,
      status,
      actionRequired,
      actions,
      createdAt,
      ...(completedAt ? { completedAt } : {})
    };
  } else {
    state.activeTasks[id] = {
      id,
      name,
      progressText,
      status,
      actionRequired,
      actions,
      createdAt,
      ...(completedAt ? { completedAt } : {})
    };
  }
  scheduleStateSave();
};

export const removeTask = (id: string) => {
  delete state.activeTasks[id];
  scheduleStateSave();
};

export function pruneExpiredTasks(): number {
  const now = Date.now();
  let prunedCount = 0;
  for (const [taskId, task] of Object.entries(state.activeTasks)) {
    // Only prune completed or cancelled tasks
    if (task.status === 'success' || task.status === 'cancelled') {
      let taskAgeMs: number | null = null;
      if (task.completedAt) {
        taskAgeMs = now - task.completedAt;
      } else if (task.createdAt) {
        taskAgeMs = now - task.createdAt;
      } else {
        // Attempt to extract timestamp from taskId (e.g. recovery_1730000000000)
        const match = taskId.match(/_(\d{10,13})(?:_|$)/);
        if (match) {
          const ts = parseInt(match[1], 10);
          if (!isNaN(ts)) {
            const ms = ts < 1e12 ? ts * 1000 : ts;
            taskAgeMs = now - ms;
          }
        }
      }

      // If task has been finished for > 7 days, prune it
      if (taskAgeMs !== null && taskAgeMs > TASK_TTL_MS) {
        delete state.activeTasks[taskId];
        prunedCount++;
      }
    }
  }

  if (prunedCount > 0) {
    addLog(`[Task Hygiene] Evicted ${prunedCount} completed task(s) older than 7 days.`);
    scheduleStateSave();
  }
  return prunedCount;
}

// Hourly automated task pruning cycle
setInterval(pruneExpiredTasks, 60 * 60 * 1000).unref();

export async function saveConfigAtomic(config: Config): Promise<void> {
  const normalizedConfig: Config = {
    ...config,
    savePath: normalizeConfigSavePath(config.savePath)
  };
  const configStr = JSON.stringify(normalizedConfig, null, 2);
  const tempFile = `${CONFIG_FILE}.tmp`;
  try {
    await fs.promises.writeFile(tempFile, configStr, "utf-8");
    await fs.promises.rename(tempFile, CONFIG_FILE);
    await fs.promises.writeFile(CONFIG_BAK_FILE, configStr, "utf-8").catch(() => {});
  } catch (err) {
    console.error("Failed to save config.json atomically", err);
    if (fs.existsSync(tempFile)) {
      await fs.promises.unlink(tempFile).catch(() => {});
    }
    throw err;
  }
}

export function loadState(onOrphanedSession?: (session: any) => void) {
  let loadedConfig = false;
  const configCandidatePaths = [
    CONFIG_FILE,
    CONFIG_BAK_FILE,
    path.join(process.cwd(), "config.json"),
    path.join(process.cwd(), "config.json.bak")
  ];

  for (const candidate of configCandidatePaths) {
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, "utf-8").trim();
        if (raw) {
          const configData = JSON.parse(raw);
          if (configData.browserClientId === LEGACY_TWITCH_BROWSER_CLIENT_ID) {
            configData.browserClientId = DEFAULT_TWITCH_BROWSER_CLIENT_ID;
          }
          const rawSavePath = configData.savePath;
          configData.savePath = normalizeConfigSavePath(configData.savePath);
          state.config = {
            ...defaultConfig,
            ...configData,
            chatRender: {
              ...defaultConfig.chatRender,
              ...(configData.chatRender || {})
            }
          };
          if (state.config.chatRender.syncOffset === 0 || state.config.chatRender.syncOffset === undefined) {
            state.config.chatRender.syncOffset = -2.5;
          }
          if (state.config.chatRender.syncOffsetHevc === undefined || state.config.chatRender.syncOffsetHevc === 0) {
            state.config.chatRender.syncOffsetHevc = -7.5;
          }
          if (state.config.chatRender.giphy === undefined) {
            state.config.chatRender.giphy = true;
          }
          loadedConfig = true;
          // If we restored from a backup or alternate path, or healed a hardcoded/legacy savePath, synchronize to primary CONFIG_FILE
          if (candidate !== CONFIG_FILE || (typeof rawSavePath === 'string' && rawSavePath.toLowerCase().includes("newdownloader")) || rawSavePath !== configData.savePath) {
            try {
              fs.writeFileSync(CONFIG_FILE, JSON.stringify(state.config, null, 2), "utf-8");
              console.log(`[Config] Healed and synced configuration from ${candidate} to ${CONFIG_FILE} (savePath: "${state.config.savePath}")`);
            } catch {}
          }
          break;
        }
      } catch (err) {
        console.error(`Failed to parse config from ${candidate}`, err);
      }
    }
  }

  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      if (data.activeTasks) {
        Object.keys(data.activeTasks).forEach(taskId => {
          const task = data.activeTasks[taskId];
          if (taskId.startsWith('prompt_backfill_')) return; // Ignore stale prompts

          if (task.folderPath) {
            const folderBase = path.basename(task.folderPath);
            const currentSavePath = getResolvedSavePath();
            const reanchoredPath = path.join(currentSavePath, folderBase);
            if (task.folderPath.toLowerCase().includes("newdownloader") || !fs.existsSync(task.folderPath)) {
              if (fs.existsSync(reanchoredPath)) {
                task.folderPath = reanchoredPath;
              }
            }
          }

          if (task.status === 'running') {
            task.status = 'error';
            task.progressText = 'Process interrupted (App Restarted). Select an action below.';
            task.actionRequired = true;
            if (task.name.includes("Stitch") || taskId.includes("stitch")) {
              task.actions = [{ label: "Retry Stitching", value: "retry_stitch" }, { label: "Dismiss", value: "dismiss" }];
            } else if (task.name.includes("Render") || taskId.includes("render")) {
              task.actions = [{ label: "Retry Render", value: "render_chat" }, { label: "Dismiss", value: "dismiss" }];
            } else if (task.name.includes("Download VOD") || taskId.includes("download")) {
              task.actions = [{ label: "Retry Download", value: "download_vod_chat" }, { label: "Dismiss", value: "dismiss" }];
            } else {
              task.actions = [{ label: "Dismiss", value: "dismiss" }];
            }
          }
          state.activeTasks[taskId] = task;
        });
        // Prune any tasks older than 7 days upon application boot
        pruneExpiredTasks();
      }
      if (data.activeDownloadSessions) {
        Object.keys(data.activeDownloadSessions).forEach(channel => {
          const savedSession = data.activeDownloadSessions[channel];
          // Re-anchor folderPath if it was previously saved under an old location (e.g. C:\NewDownloader\downloads)
          if (savedSession.folderPath) {
            const folderBase = path.basename(savedSession.folderPath);
            const currentSavePath = getResolvedSavePath();
            const reanchoredPath = path.join(currentSavePath, folderBase);

            if (savedSession.folderPath.toLowerCase().includes("newdownloader") || !fs.existsSync(savedSession.folderPath)) {
              if (fs.existsSync(reanchoredPath)) {
                console.log(`[State] Re-anchoring session folder from ${savedSession.folderPath} to ${reanchoredPath}`);
                savedSession.folderPath = reanchoredPath;
                if (savedSession.segmentsFile) {
                  savedSession.segmentsFile = path.join(reanchoredPath, path.basename(savedSession.segmentsFile));
                }
                if (savedSession.chatFilePath) {
                  savedSession.chatFilePath = path.join(reanchoredPath, path.basename(savedSession.chatFilePath));
                }
              }
            }
          }

          // If the user deleted the session's download folder, discard the stale session so a fresh download/backfill occurs
          if (savedSession.folderPath && !fs.existsSync(savedSession.folderPath)) {
            console.log(`[State] Session download folder ${savedSession.folderPath} does not exist (deleted by user). Discarding stale session for ${channel}.`);
            return;
          }

          const deserializedSegments = deserializeDownloadedSegments(savedSession.downloadedSegments);
          // Bound restored segment set to most recent 1,000 sequence watermark to keep memory footprint bounded
          if (savedSession.highestSeq && savedSession.highestSeq > 1000) {
            const pruneBefore = savedSession.highestSeq - 1000;
            for (const item of deserializedSegments) {
              if (typeof item === 'number' && item < pruneBefore) {
                deserializedSegments.delete(item);
              }
            }
          }

          state.activeDownloadSessions[channel] = {
            ...savedSession,
            downloadedSegments: deserializedSegments,
            playlistPollInterval: null,
            isRefreshingPlaylist: false,
            isResumingFromRestart: true,
            chatWs: null,
            chatStream: null
          };
          if (onOrphanedSession) onOrphanedSession(savedSession);
        });
      }
    } catch (err) {
      console.error("Failed to read state.json", err);
    }
  }
}
