import fs from "fs";
import path from "path";
import { ActiveTask, ActiveDownloadSession, Config, TaskStatus } from "../types";
import {
  PROJECT_ROOT,
  CONFIG_FILE,
  CONFIG_BAK_FILE,
  DEFAULT_TWITCH_BROWSER_CLIENT_ID,
  LEGACY_TWITCH_BROWSER_CLIENT_ID,
  cleanChannelName,
  normalizeConfigSavePath,
  resolveSavePathFromRoot,
  resolveTdExecutablePath,
  defaultConfig,
  normalizeGameSlug,
  resolveChatRenderDimensionsForGame,
  resolveChatRenderDimensionsForChatFile,
  loadConfigFromDisk,
  saveConfigToDiskAtomic,
} from "./configRepository";
import {
  STATE_FILE,
  TASK_TTL_MS,
  serializeDownloadedSegments,
  deserializeDownloadedSegments,
  SessionJournalRepository,
} from "./sessionRepository";
import { emitConfigDelta, emitLogLine, emitTasksDelta } from "./eventBus";

export {
  PROJECT_ROOT,
  CONFIG_FILE,
  CONFIG_BAK_FILE,
  STATE_FILE,
  TASK_TTL_MS,
  DEFAULT_TWITCH_BROWSER_CLIENT_ID,
  LEGACY_TWITCH_BROWSER_CLIENT_ID,
  cleanChannelName,
  normalizeConfigSavePath,
  defaultConfig,
  normalizeGameSlug,
  serializeDownloadedSegments,
  deserializeDownloadedSegments,
};

export const LOG_FILE = path.join(PROJECT_ROOT, "system.log");
export const LOG_ROTATED_FILE = path.join(PROJECT_ROOT, "system.log.1");
export const MAX_LOG_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB max system.log before rotation

export const state = {
  config: { ...defaultConfig, chatRender: { ...defaultConfig.chatRender! } } as Config,
  monitoringInterval: null as NodeJS.Timeout | null,
  activeTasks: {} as Record<string, ActiveTask>,
  activeProcesses: {} as Record<string, any>,
  activeDownloadSessions: {} as Record<string, ActiveDownloadSession>,
  logs: [] as string[],
  monitoredChannels: [] as string[],
  lastCheckTime: null as number | null,
  hasLoggedInitialCheck: false,
};

const sessionJournal = new SessionJournalRepository(() => ({
  activeDownloadSessions: state.activeDownloadSessions,
  activeTasks: state.activeTasks,
}));

export function getResolvedSavePath(configuredPath?: string): string {
  return resolveSavePathFromRoot(configuredPath !== undefined ? configuredPath : state.config?.savePath);
}

export function resolveTdPath(configuredTdPath?: string): string {
  return resolveTdExecutablePath(configuredTdPath !== undefined ? configuredTdPath : state.config?.tdPath);
}

export function getChatRenderDimensionsForGame(
  gameName?: string | null,
  filename?: string | null
): { width: number; height: number; matchedProfile?: string; isCustomProfile: boolean } {
  return resolveChatRenderDimensionsForGame(state.config, gameName, filename);
}

export function getChatRenderDimensionsForChatFile(
  chatFilePath: string,
  fallbackGameName?: string | null
): { width: number; height: number; gameName: string; matchedProfile?: string; isCustomProfile: boolean } {
  return resolveChatRenderDimensionsForChatFile(state.config, chatFilePath, fallbackGameName);
}

let logCheckCounter = 0;
let isRotatingLog = false;

export function checkAndRotateLogFile(): void {
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

export const addLog = (msg: string): void => {
  if (!msg) return;
  const now = new Date();
  const timestamp = now.toLocaleTimeString();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const localDateStr = `${year}-${month}-${day}`;

  logCheckCounter++;
  if (logCheckCounter >= 25) {
    logCheckCounter = 0;
    checkAndRotateLogFile();
  }

  const rawLines = String(msg).split(/\r?\n/);
  for (const line of rawLines) {
    if (!line && rawLines.length > 1) continue;
    const logMsg = `[${localDateStr} ${timestamp}] ${line}`;
    console.log(logMsg);
    state.logs.push(logMsg);
    if (state.logs.length > 300) state.logs.shift();
    emitLogLine(logMsg);

    const fileLogMessage = `${logMsg}\n`;
    fs.appendFile(LOG_FILE, fileLogMessage, (err) => {
      if (err) console.error("Failed to write to log file:", err);
    });
  }
};

export function scheduleStateSave(immediate = false): void {
  sessionJournal.scheduleSave(immediate);
}

export function flushStateSync(): void {
  sessionJournal.flushSync();
}

export const updateTask = (
  id: string,
  name: string,
  progressText: string,
  status: TaskStatus = "running",
  actionRequired = false,
  actions?: { label: string; value: string }[]
): void => {
  const now = Date.now();
  const existing = state.activeTasks[id];
  const createdAt = existing?.createdAt || now;
  const isTerminal = status === "success" || status === "warning" || status === "cancelled";
  const completedAt = isTerminal ? existing?.completedAt || now : undefined;
  const statusChanged = !existing || existing.status !== status || existing.actionRequired !== actionRequired;

  if (existing) {
    state.activeTasks[id] = {
      ...existing,
      name,
      progressText,
      status,
      actionRequired,
      actions,
      createdAt,
      ...(completedAt ? { completedAt } : {}),
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
      ...(completedAt ? { completedAt } : {}),
    };
  }
  scheduleStateSave();
  emitTasksDelta(() => Object.values(state.activeTasks), statusChanged);
};

export const removeTask = (id: string): void => {
  delete state.activeTasks[id];
  scheduleStateSave();
  emitTasksDelta(() => Object.values(state.activeTasks), true);
};

export function pruneExpiredTasks(): number {
  const now = Date.now();
  let prunedCount = 0;
  for (const [taskId, task] of Object.entries(state.activeTasks)) {
    if (task.status === "success" || task.status === "warning" || task.status === "cancelled") {
      let taskAgeMs: number | null = null;
      if (task.completedAt) {
        taskAgeMs = now - task.completedAt;
      } else if (task.createdAt) {
        taskAgeMs = now - task.createdAt;
      } else {
        const match = taskId.match(/_(\d{10,13})(?:_|$)/);
        if (match) {
          const ts = parseInt(match[1], 10);
          if (!isNaN(ts)) {
            const ms = ts < 1e12 ? ts * 1000 : ts;
            taskAgeMs = now - ms;
          }
        }
      }

      if (taskAgeMs !== null && taskAgeMs > TASK_TTL_MS) {
        delete state.activeTasks[taskId];
        prunedCount++;
      }
    }
  }

  if (prunedCount > 0) {
    addLog(`[Task Hygiene] Evicted ${prunedCount} completed task(s) older than 7 days.`);
    scheduleStateSave();
    emitTasksDelta(() => Object.values(state.activeTasks), true);
  }
  return prunedCount;
}

setInterval(pruneExpiredTasks, 60 * 60 * 1000).unref();

export async function saveConfigAtomic(config: Config): Promise<void> {
  const normalized = await saveConfigToDiskAtomic(config);
  state.config = normalized;
  emitConfigDelta(state.config);
}

export function loadState(onOrphanedSession?: (session: any) => void): void {
  state.config = loadConfigFromDisk();

  const { restoredTasks, restoredSessions } = sessionJournal.restoreFromDisk({
    currentSavePath: getResolvedSavePath(),
    onOrphanedSession,
  });

  state.activeTasks = restoredTasks;
  pruneExpiredTasks();
  state.activeDownloadSessions = restoredSessions;
}
