import fs from "fs";
import path from "path";
import { ActiveDownloadSession, ActiveTask } from "../types";
import { PROJECT_ROOT } from "./configRepository";

export const STATE_FILE = path.join(PROJECT_ROOT, "state.json");
export const TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days TTL for completed tasks

export function serializeDownloadedSegments(set: Set<string | number> | undefined): {
  liveRanges: [number, number][];
  vodRanges: [number, number][];
  other?: (string | number)[];
} {
  if (!set || set.size === 0) return { liveRanges: [], vodRanges: [] };

  const liveNums: number[] = [];
  const vodNums: number[] = [];
  const other: (string | number)[] = [];

  for (const item of set) {
    if (typeof item === "number") {
      liveNums.push(item);
    } else if (typeof item === "string" && item.startsWith("vod_")) {
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
    ...(other.length > 0 ? { other } : {}),
  };
}

export function deserializeDownloadedSegments(data: any): Set<string | number> {
  const set = new Set<string | number>();
  if (!data) return set;

  if (Array.isArray(data)) {
    for (const item of data) {
      set.add(item);
    }
    return set;
  }

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

export function serializeActiveSessions(
  sessions: Record<string, ActiveDownloadSession>
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(sessions).map(([channel, session]) => [
      channel,
      {
        channel: session.channel,
        streamId: session.streamId,
        twitchId: session.twitchId,
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
        eventsWritten: session.eventsWritten,
        games: session.games,
        chatFilePath: session.chatFilePath,
        commentsJournalPath: session.commentsJournalPath,
        videoDurationSeconds: session.videoDurationSeconds,
        videoStartTimeMs: session.videoStartTimeMs,
        streamCreatedAtMs: session.streamCreatedAtMs,
        initialJoinOffsetSec: session.initialJoinOffsetSec,
        firstSeqNum: session.firstSeqNum,
        gapAdjustments: session.gapAdjustments,
        missingCount: session.missingCount,
        downloadedSegments: serializeDownloadedSegments(session.downloadedSegments),
        autoRenderChat: session.autoRenderChat,
        captureMode: session.captureMode || "both",
      },
    ])
  );
}

export class SessionJournalRepository {
  private stateSaveTimeout: NodeJS.Timeout | null = null;
  private isSavingState = false;
  private pendingStateSave = false;

  constructor(
    private readonly getSnapshot: () => {
      activeDownloadSessions: Record<string, ActiveDownloadSession>;
      activeTasks: Record<string, ActiveTask>;
    }
  ) {}

  private executeSave(): void {
    if (this.isSavingState) {
      this.pendingStateSave = true;
      return;
    }
    this.isSavingState = true;
    try {
      const snapshot = this.getSnapshot();
      const serializableSessions = serializeActiveSessions(snapshot.activeDownloadSessions);
      const tempFile = `${STATE_FILE}.tmp`;
      fs.promises
        .writeFile(
          tempFile,
          JSON.stringify({
            activeDownloadSessions: serializableSessions,
            activeTasks: snapshot.activeTasks,
          }),
          "utf-8"
        )
        .then(() => fs.promises.rename(tempFile, STATE_FILE))
        .catch((err) => console.error("Failed to save state.json dynamically", err))
        .finally(() => {
          this.isSavingState = false;
          if (this.pendingStateSave) {
            this.pendingStateSave = false;
            this.executeSave();
          }
        });
    } catch (err) {
      this.isSavingState = false;
      console.error("Failed to save state.json", err);
      if (this.pendingStateSave) {
        this.pendingStateSave = false;
        this.executeSave();
      }
    }
  }

  public scheduleSave(immediate = false): void {
    if (immediate) {
      if (this.stateSaveTimeout) {
        clearTimeout(this.stateSaveTimeout);
        this.stateSaveTimeout = null;
      }
      this.executeSave();
      return;
    }
    if (this.stateSaveTimeout) return;
    this.stateSaveTimeout = setTimeout(() => {
      this.stateSaveTimeout = null;
      this.executeSave();
    }, 2500);
  }

  public flushSync(): void {
    if (this.stateSaveTimeout) {
      clearTimeout(this.stateSaveTimeout);
      this.stateSaveTimeout = null;
    }
    try {
      const snapshot = this.getSnapshot();
      const serializableSessions = serializeActiveSessions(snapshot.activeDownloadSessions);
      const tempFile = `${STATE_FILE}.tmp`;
      fs.writeFileSync(
        tempFile,
        JSON.stringify({
          activeDownloadSessions: serializableSessions,
          activeTasks: snapshot.activeTasks,
        }),
        "utf-8"
      );
      fs.renameSync(tempFile, STATE_FILE);
    } catch (err) {
      console.error("Failed to flush state.json synchronously", err);
    }
  }

  public restoreFromDisk(options: {
    currentSavePath: string;
    onOrphanedSession?: (session: any) => void;
  }): {
    restoredTasks: Record<string, ActiveTask>;
    restoredSessions: Record<string, ActiveDownloadSession>;
  } {
    const restoredTasks: Record<string, ActiveTask> = {};
    const restoredSessions: Record<string, ActiveDownloadSession> = {};

    if (!fs.existsSync(STATE_FILE)) {
      return { restoredTasks, restoredSessions };
    }

    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      if (data.activeTasks) {
        for (const taskId of Object.keys(data.activeTasks)) {
          const task: ActiveTask = data.activeTasks[taskId];
          if (taskId.startsWith("prompt_backfill_")) continue;

          if (task.folderPath) {
            const folderBase = path.basename(task.folderPath);
            const reanchoredPath = path.join(options.currentSavePath, folderBase);
            if (
              task.folderPath.toLowerCase().includes("newdownloader") ||
              !fs.existsSync(task.folderPath)
            ) {
              if (fs.existsSync(reanchoredPath)) {
                task.folderPath = reanchoredPath;
                if (task.retrySpec) {
                  task.retrySpec.folderPath = reanchoredPath;
                }
              }
            }
          }

          if (task.status === "running") {
            task.status = "error";
            task.progressText = "Process interrupted (App Restarted). Select an action below.";
            task.actionRequired = true;
            if (task.name.includes("Stitch") || taskId.includes("stitch") || task.retrySpec) {
              task.actions = [
                { label: "Retry Stitching", value: "retry_stitch" },
                { label: "Dismiss", value: "dismiss" },
              ];
            } else if (task.name.includes("Render") || taskId.includes("render")) {
              task.actions = [
                { label: "Retry Render", value: "render_chat" },
                { label: "Dismiss", value: "dismiss" },
              ];
            } else if (task.name.includes("Download VOD") || taskId.includes("download")) {
              task.actions = [
                { label: "Retry Download", value: "download_vod_chat" },
                { label: "Dismiss", value: "dismiss" },
              ];
            } else {
              task.actions = [{ label: "Dismiss", value: "dismiss" }];
            }
          }

          restoredTasks[taskId] = task;
        }
      }

      if (data.activeDownloadSessions) {
        for (const channel of Object.keys(data.activeDownloadSessions)) {
          const savedSession = data.activeDownloadSessions[channel];

          if (savedSession.folderPath) {
            const folderBase = path.basename(savedSession.folderPath);
            const reanchoredPath = path.join(options.currentSavePath, folderBase);

            if (
              savedSession.folderPath.toLowerCase().includes("newdownloader") ||
              !fs.existsSync(savedSession.folderPath)
            ) {
              if (fs.existsSync(reanchoredPath)) {
                console.log(
                  `[State] Re-anchoring session folder from ${savedSession.folderPath} to ${reanchoredPath}`
                );
                savedSession.folderPath = reanchoredPath;
                if (savedSession.segmentsFile) {
                  savedSession.segmentsFile = path.join(
                    reanchoredPath,
                    path.basename(savedSession.segmentsFile)
                  );
                }
                if (savedSession.chatFilePath) {
                  savedSession.chatFilePath = path.join(
                    reanchoredPath,
                    path.basename(savedSession.chatFilePath)
                  );
                }
                if (savedSession.commentsJournalPath) {
                  savedSession.commentsJournalPath = path.join(
                    reanchoredPath,
                    path.basename(savedSession.commentsJournalPath)
                  );
                }
              }
            }
          }

          // Rule 5: If the user deleted the session's download folder, discard the stale session
          if (savedSession.folderPath && !fs.existsSync(savedSession.folderPath)) {
            console.log(
              `[State] Session download folder ${savedSession.folderPath} does not exist (deleted by user). Discarding stale session for ${channel}.`
            );
            continue;
          }

          const deserializedSegments = deserializeDownloadedSegments(
            savedSession.downloadedSegments
          );
          if (savedSession.highestSeq && savedSession.highestSeq > 1000) {
            const pruneBefore = savedSession.highestSeq - 1000;
            for (const item of deserializedSegments) {
              if (typeof item === "number" && item < pruneBefore) {
                deserializedSegments.delete(item);
              }
            }
          }

          restoredSessions[channel] = {
            ...savedSession,
            downloadedSegments: deserializedSegments,
            playlistPollInterval: null,
            isRefreshingPlaylist: false,
            isResumingFromRestart: true,
            chatWs: null,
            hermesWs: null,
            pubsubWs: null,
            ircConnected: false,
            hermesConnected: false,
            chatStream: null,
          };

          if (options.onOrphanedSession) {
            options.onOrphanedSession(savedSession);
          }
        }
      }
    } catch (err) {
      console.error("Failed to read state.json", err);
    }

    return { restoredTasks, restoredSessions };
  }
}
