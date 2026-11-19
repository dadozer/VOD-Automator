import fs from "fs";
import path from "path";

export const SESSION_MANIFEST_FILENAME = "session_manifest.json";
export const SEGMENT_TIMELINE_FILENAME = "segments.jsonl";

export interface MediaTrackManifest {
  container: "fmp4" | "ts";
  codec?: string | null;
  width?: number;
  height?: number;
  fps?: number;
  initFilename?: string | null;
  avgSegmentDurationSec?: number;
  vodId?: string;
  updatedAtMs: number;
}

export interface SessionManifest {
  schemaVersion: 1;
  channelLogin: string;
  twitchId: number;
  streamId: string;
  title: string;
  streamCreatedAtMs: number;
  videoStartTimeMs: number;
  initialJoinOffsetSec: number;
  firstSeqNum?: number;
  captureMode: "both" | "video_only" | "chat_only";
  liveTrack?: MediaTrackManifest | null;
  vodTrack?: MediaTrackManifest | null;
  createdAt: string;
  updatedAt: string;
}

export interface SegmentTimelineEntry {
  seq: number;
  dur: number;
  ts: number;
  disc?: boolean;
}

// Per-folder cached timeline map: resolvedFolderPath -> Map<seqNum, durationSec>
const timelineCache = new Map<string, Map<number, number>>();
// Per-folder cached manifest: resolvedFolderPath -> SessionManifest
const manifestCache = new Map<string, SessionManifest>();
// Serialized write chain per folder to avoid concurrent rename races on Windows
const manifestWriteLocks = new Map<string, Promise<void>>();

export function getSessionManifestPath(folderPath: string): string {
  return path.join(folderPath, SESSION_MANIFEST_FILENAME);
}

export function getSegmentTimelinePath(folderPath: string): string {
  return path.join(folderPath, SEGMENT_TIMELINE_FILENAME);
}

export function readSessionManifestSync(folderPath?: string): SessionManifest | null {
  if (!folderPath) return null;
  const key = path.resolve(folderPath);
  const cached = manifestCache.get(key);
  if (cached) return cached;

  const manifestPath = getSessionManifestPath(folderPath);
  if (!fs.existsSync(manifestPath)) return null;

  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.schemaVersion === 1) {
      manifestCache.set(key, parsed as SessionManifest);
      return parsed as SessionManifest;
    }
  } catch (_) {}
  return null;
}

export async function updateSessionManifest(
  folderPath: string,
  patch: Partial<Omit<SessionManifest, "schemaVersion" | "createdAt" | "updatedAt">>
): Promise<SessionManifest | null> {
  if (!folderPath) return null;
  const key = path.resolve(folderPath);

  const runUpdate = async (): Promise<SessionManifest | null> => {
    try {
      if (!fs.existsSync(folderPath)) {
        await fs.promises.mkdir(folderPath, { recursive: true });
      }
      const existing = readSessionManifestSync(folderPath);
      const nowIso = new Date().toISOString();

      const merged: SessionManifest = {
        schemaVersion: 1,
        channelLogin: patch.channelLogin ?? existing?.channelLogin ?? "",
        twitchId:
          typeof patch.twitchId === "number" && Number.isFinite(patch.twitchId)
            ? Math.max(0, Math.trunc(patch.twitchId))
            : existing?.twitchId ?? 0,
        streamId: patch.streamId ?? existing?.streamId ?? "",
        title: patch.title ?? existing?.title ?? "",
        streamCreatedAtMs: patch.streamCreatedAtMs ?? existing?.streamCreatedAtMs ?? Date.now(),
        videoStartTimeMs: patch.videoStartTimeMs ?? existing?.videoStartTimeMs ?? Date.now(),
        initialJoinOffsetSec: patch.initialJoinOffsetSec ?? existing?.initialJoinOffsetSec ?? 0,
        firstSeqNum: patch.firstSeqNum !== undefined ? patch.firstSeqNum : existing?.firstSeqNum,
        captureMode: patch.captureMode ?? existing?.captureMode ?? "both",
        liveTrack:
          patch.liveTrack !== undefined
            ? patch.liveTrack
              ? { ...(existing?.liveTrack || {}), ...patch.liveTrack }
              : null
            : existing?.liveTrack ?? null,
        vodTrack:
          patch.vodTrack !== undefined
            ? patch.vodTrack
              ? { ...(existing?.vodTrack || {}), ...patch.vodTrack }
              : null
            : existing?.vodTrack ?? null,
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
      };

      manifestCache.set(key, merged);

      const targetPath = getSessionManifestPath(folderPath);
      const tempPath = `${targetPath}.tmp_${process.pid}_${Date.now()}`;
      await fs.promises.writeFile(tempPath, JSON.stringify(merged, null, 2), "utf8");
      await fs.promises.rename(tempPath, targetPath).catch(async () => {
        await fs.promises.writeFile(targetPath, JSON.stringify(merged, null, 2), "utf8");
        await fs.promises.unlink(tempPath).catch(() => {});
      });
      return merged;
    } catch (_) {
      return null;
    }
  };

  const prevLock = manifestWriteLocks.get(key) || Promise.resolve();
  let resultManifest: SessionManifest | null = null;
  const nextLock = prevLock
    .catch(() => {})
    .then(async () => {
      resultManifest = await runUpdate();
    });
  manifestWriteLocks.set(key, nextLock);
  await nextLock;
  if (manifestWriteLocks.get(key) === nextLock) {
    manifestWriteLocks.delete(key);
  }
  return resultManifest;
}

/**
 * Authoritatively checks `session_manifest.json` for container format ('fmp4' | 'ts')
 * for either the Live track or the VOD backfill track. Returns null if unrecorded.
 */
export function detectSessionContainerFromManifest(
  folderPath?: string,
  isVod = false
): "fmp4" | "ts" | null {
  const manifest = readSessionManifestSync(folderPath);
  if (!manifest) return null;
  const track = isVod ? manifest.vodTrack : manifest.liveTrack;
  if (track?.container === "fmp4" || track?.container === "ts") {
    return track.container;
  }
  return null;
}

/**
 * Authoritatively checks `session_manifest.json` to determine whether a recording folder
 * (or specific VOD vs Live track) uses Enhanced Broadcasting CMAF/HEVC.
 * Returns null if no manifest track metadata is recorded yet.
 */
export function isSessionHevcOrFmp4FromManifest(
  folderPath?: string,
  isVodFile = false
): boolean | null {
  const manifest = readSessionManifestSync(folderPath);
  if (!manifest) return null;
  const track = isVodFile ? (manifest.vodTrack || manifest.liveTrack) : (manifest.liveTrack || manifest.vodTrack);
  if (!track) return null;
  if (track.codec) {
    const lower = track.codec.toLowerCase();
    if (lower.includes("hev1") || lower.includes("hvc1") || lower.includes("hevc") || lower.includes("av01")) {
      return true;
    }
    if (lower.includes("avc1") || lower.includes("avc3") || lower.includes("h264")) {
      return track.container === "fmp4";
    }
  }
  return track.container === "fmp4";
}

/**
 * Hydrates or retrieves the per-folder Map<seqNum, durationSec> from segments.jsonl.
 */
export function loadSegmentTimelineMapSync(folderPath?: string): Map<number, number> {
  if (!folderPath) return new Map();
  const key = path.resolve(folderPath);
  const existing = timelineCache.get(key);
  if (existing) return existing;

  const map = new Map<number, number>();
  const timelinePath = getSegmentTimelinePath(folderPath);
  if (fs.existsSync(timelinePath)) {
    try {
      const content = fs.readFileSync(timelinePath, "utf8");
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as SegmentTimelineEntry;
          if (
            entry &&
            typeof entry.seq === "number" &&
            Number.isFinite(entry.seq) &&
            typeof entry.dur === "number" &&
            entry.dur > 0
          ) {
            map.set(entry.seq, entry.dur);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  timelineCache.set(key, map);
  return map;
}

/**
 * Appends a live HLS segment's exact #EXTINF duration to the in-memory timeline index
 * and persists it asynchronously to `segments.jsonl`.
 */
export function appendSegmentTimelineEntry(
  folderPath: string,
  seq: number,
  durationSec: number,
  discontinuity = false
): void {
  if (!folderPath || !Number.isFinite(seq)) return;
  const validDur = Number.isFinite(durationSec) && durationSec > 0 ? parseFloat(durationSec.toFixed(6)) : 2.0;
  const map = loadSegmentTimelineMapSync(folderPath);
  if (map.has(seq)) return;
  map.set(seq, validDur);

  const record: SegmentTimelineEntry = {
    seq,
    dur: validDur,
    ts: Date.now(),
    ...(discontinuity ? { disc: true } : {}),
  };

  const timelinePath = getSegmentTimelinePath(folderPath);
  fs.promises.appendFile(timelinePath, JSON.stringify(record) + "\n", "utf8").catch(() => {});
}

/**
 * Computes the true average segment duration recorded in `segments.jsonl` for a session folder,
 * falling back to `fallbackSec` (default 2.0s) when no segment durations are recorded.
 */
export function getAverageSegmentDuration(folderPath?: string, fallbackSec = 2.0): number {
  const map = loadSegmentTimelineMapSync(folderPath);
  if (map.size === 0) return fallbackSec;

  let sum = 0;
  let count = 0;
  for (const dur of map.values()) {
    if (dur > 0 && dur < 30) {
      sum += dur;
      count++;
    }
  }
  return count > 0 ? sum / count : fallbackSec;
}

/**
 * Computes the exact signed elapsed media duration in seconds between `fromSeq` and `toSeq`
 * using recorded `#EXTINF` durations from `segments.jsonl` (falling back to `fallbackAvgDur`
 * for any unindexed sequence numbers).
 * - If `toSeq > fromSeq`, returns positive seconds.
 * - If `toSeq < fromSeq`, returns negative seconds (e.g. leading buffer before a game switch).
 */
export function getSignedElapsedDurationBetweenChunks(
  folderPath: string | undefined,
  fromSeq: number,
  toSeq: number,
  fallbackAvgDur?: number
): number {
  if (fromSeq === toSeq) return 0;
  const map = loadSegmentTimelineMapSync(folderPath);
  const avgDur =
    fallbackAvgDur && Number.isFinite(fallbackAvgDur) && fallbackAvgDur > 0
      ? fallbackAvgDur
      : getAverageSegmentDuration(folderPath, 2.0);

  // Fast path if no segment index exists (e.g. historical folder or chat_only mode)
  if (map.size === 0) {
    return (toSeq - fromSeq) * avgDur;
  }

  const sign = toSeq > fromSeq ? 1 : -1;
  const low = Math.min(fromSeq, toSeq);
  const high = Math.max(fromSeq, toSeq);

  // Guard huge unindexed spans
  if (high - low > 200_000) {
    return (toSeq - fromSeq) * avgDur;
  }

  let totalSec = 0;
  for (let s = low; s < high; s++) {
    const dur = map.get(s);
    totalSec += dur !== undefined && dur > 0 ? dur : avgDur;
  }
  return sign * totalSec;
}

/**
 * Determines how many sequence chunks correspond to `targetDurationSec` walking either
 * backward or forward from `referenceSeq` using exact recorded `#EXTINF` durations.
 * Never assumes fixed 2.000s chunks when real segment durations are available.
 */
export function computeChunkCountForDuration(
  folderPath: string | undefined,
  referenceSeq: number,
  targetDurationSec: number,
  direction: "backward" | "forward" = "backward",
  fallbackAvgDur?: number
): number {
  if (targetDurationSec <= 0) return 0;
  const map = loadSegmentTimelineMapSync(folderPath);
  const avgDur =
    fallbackAvgDur && Number.isFinite(fallbackAvgDur) && fallbackAvgDur > 0
      ? fallbackAvgDur
      : getAverageSegmentDuration(folderPath, 2.0);

  if (map.size === 0) {
    return Math.max(0, Math.floor(targetDurationSec / avgDur));
  }

  let accumulated = 0;
  let chunks = 0;
  const maxSteps = Math.ceil((targetDurationSec / Math.max(0.25, avgDur)) * 3) + 60;

  while (accumulated < targetDurationSec && chunks < maxSteps) {
    const probeSeq = direction === "backward" ? referenceSeq - 1 - chunks : referenceSeq + chunks;
    if (probeSeq < 0) break;
    const segDur = map.get(probeSeq);
    const stepDur = segDur !== undefined && segDur > 0 ? segDur : avgDur;
    if (accumulated + stepDur > targetDurationSec && chunks > 0) {
      // Match Math.floor semantics if adding another chunk overshoots significantly
      if (targetDurationSec - accumulated < stepDur * 0.5) {
        break;
      }
    }
    accumulated += stepDur;
    chunks++;
  }

  return chunks;
}

export function clearSessionManifestMemoryCache(folderPath?: string): void {
  if (!folderPath) return;
  const key = path.resolve(folderPath);
  timelineCache.delete(key);
  manifestCache.delete(key);
}
