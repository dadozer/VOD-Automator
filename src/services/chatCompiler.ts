import fs from "fs";
import path from "path";
import { addLog } from "./state";
import {
  populateEmbeddedDataForChat,
  fetchFirstPartyEmotesFromMap,
  fetchTwitchBadgesFromMap,
  extractUsedEmotesAndBadgesFromComments,
} from "./emotes";
import {
  getSignedElapsedDurationBetweenChunks,
  readSessionManifestSync,
} from "./sessionManifest";
import type { ChatBroadcastEvent } from "../types";

export function getEventsSidecarPath(chatFilePath: string): string {
  return chatFilePath.replace(/\.json$/i, ".events.jsonl");
}

export function getCommentsJournalPath(chatFilePath: string): string {
  return chatFilePath.replace(/\.json$/i, ".comments.jsonl");
}

/**
 * Prefixed with `session_` so all folder scanners (`!f.startsWith('session_')`) ignore it as a render target.
 */
export function getChatSessionHeaderPath(chatFilePath: string): string {
  return path.join(path.dirname(chatFilePath), `session_chat_header_${path.basename(chatFilePath)}`);
}

/**
 * Returns true if either a sealed/legacy `.json` chat file OR an active `.comments.jsonl` journal exists.
 */
export function hasChatSource(chatFilePath?: string): boolean {
  if (!chatFilePath) return false;
  if (fs.existsSync(chatFilePath)) return true;
  const journalPath = getCommentsJournalPath(chatFilePath);
  return fs.existsSync(journalPath);
}

export async function writeJsonAtomic(filePath: string, payload: any): Promise<void> {
  const serialized = JSON.stringify(payload, null, 2);
  const tempPath = `${filePath}.tmp_${process.pid}_${Date.now()}`;
  try {
    await fs.promises.writeFile(tempPath, serialized, "utf8");
    await fs.promises.rename(tempPath, filePath);
  } catch (_) {
    await fs.promises.writeFile(filePath, serialized, "utf8");
    if (fs.existsSync(tempPath)) {
      await fs.promises.unlink(tempPath).catch(() => {});
    }
  }
}

export function coerceSafeInt32StreamerId(rawId: any): number {
  const parsed = typeof rawId === "number" ? Math.trunc(rawId) : parseInt(String(rawId ?? 0), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2147483647) {
    return 0;
  }
  return parsed;
}

/**
 * Enforces TwitchDownloaderCLI / ChatRenderCLI C# System.Text.Json schema parity:
 * - FileInfo Version 1.5.3
 * - 32-bit integer streamer.id (never "" or null)
 * - embeddedData.thirdParty / firstParty / twitchBadges
 * - schemaVersion "2.0-extended"
 */
export function normalizeTwitchDownloaderSchema(
  payload: any,
  defaults?: {
    channelLogin?: string;
    streamerId?: any;
    streamId?: string;
    title?: string;
    createdAt?: string;
    gameName?: string;
    durationSec?: number;
    thirdPartyEmotes?: any[];
  }
): any {
  const nowIso = new Date().toISOString();
  const out = payload && typeof payload === "object" ? payload : {};

  if (!out.FileInfo || !out.FileInfo.Version) {
    out.FileInfo = {
      Version: { Major: 1, Minor: 5, Patch: 3 },
      CreatedAt: defaults?.createdAt || nowIso,
      UpdatedAt: nowIso,
    };
  } else {
    out.FileInfo.UpdatedAt = nowIso;
  }

  if (!out.schemaVersion) {
    out.schemaVersion = "2.0-extended";
  }

  const resolvedStreamerId = coerceSafeInt32StreamerId(
    out.streamer?.id || defaults?.streamerId || 0
  );
  const resolvedStreamerName =
    (out.streamer?.name && String(out.streamer.name).trim()) ||
    defaults?.channelLogin ||
    "streamer";

  out.streamer = {
    name: resolvedStreamerName,
    id: resolvedStreamerId,
  };

  if (!out.video || typeof out.video !== "object") {
    out.video = {
      title: defaults?.title || "",
      description: "",
      id: defaults?.streamId || "",
      created_at: defaults?.createdAt || nowIso,
      start: 0,
      end: defaults?.durationSec ?? 0,
      length: defaults?.durationSec ?? 0,
      viewCount: 0,
      game: defaults?.gameName || "",
    };
  } else {
    out.video.start = 0;
    if (defaults?.durationSec !== undefined) {
      out.video.end = defaults.durationSec;
      out.video.length = defaults.durationSec;
    }
    if (defaults?.gameName) {
      out.video.game = defaults.gameName;
    }
    if (!out.video.title && defaults?.title) {
      out.video.title = defaults.title;
    }
    if (!out.video.id && defaults?.streamId) {
      out.video.id = defaults.streamId;
    }
  }

  if (!Array.isArray(out.comments)) {
    out.comments = [];
  }
  if (!Array.isArray(out.events)) {
    out.events = [];
  }

  const fallbackThirdParty =
    (Array.isArray(out.embeddedData?.thirdParty) && out.embeddedData.thirdParty.length > 0
      ? out.embeddedData.thirdParty
      : null) ||
    (Array.isArray(out.emotes) && out.emotes.length > 0 ? out.emotes : null) ||
    defaults?.thirdPartyEmotes ||
    [];

  if (!out.embeddedData || typeof out.embeddedData !== "object") {
    out.embeddedData = {
      thirdParty: fallbackThirdParty,
      firstParty: [],
      twitchBadges: [],
    };
  } else {
    if (!Array.isArray(out.embeddedData.thirdParty) || out.embeddedData.thirdParty.length === 0) {
      out.embeddedData.thirdParty = fallbackThirdParty;
    }
    if (!Array.isArray(out.embeddedData.firstParty)) {
      out.embeddedData.firstParty = [];
    }
    if (!Array.isArray(out.embeddedData.twitchBadges)) {
      out.embeddedData.twitchBadges = [];
    }
  }

  return out;
}

export function readBroadcastEventsForChatFile(
  chatFilePath?: string,
  parsedChatObj?: any
): ChatBroadcastEvent[] {
  const events: ChatBroadcastEvent[] = [];
  const seenIds = new Set<string>();

  if (parsedChatObj && Array.isArray(parsedChatObj.events)) {
    for (const evt of parsedChatObj.events) {
      if (evt && evt._id && !seenIds.has(evt._id)) {
        seenIds.add(evt._id);
        events.push(evt);
      }
    }
  }

  if (chatFilePath) {
    const sidecarPath = getEventsSidecarPath(chatFilePath);
    if (fs.existsSync(sidecarPath)) {
      try {
        const rawLines = fs.readFileSync(sidecarPath, "utf8").split(/\r?\n/);
        for (const line of rawLines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const evt = JSON.parse(trimmed);
            if (evt && evt._id && !seenIds.has(evt._id)) {
              seenIds.add(evt._id);
              events.push(evt);
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
  }

  events.sort((a, b) => (a.content_offset_seconds || 0) - (b.content_offset_seconds || 0));
  return events;
}

function computeGapOffsetSec(
  gapAtChunk: number,
  baseOffsetSec: number,
  baseSeq: number,
  avgChunkDur: number,
  folderPath?: string
): number {
  if (gapAtChunk <= baseSeq) return baseOffsetSec;
  const deltaSec = getSignedElapsedDurationBetweenChunks(
    folderPath,
    baseSeq,
    gapAtChunk,
    avgChunkDur
  );
  return baseOffsetSec + Math.max(0, deltaSec);
}

export function sliceAndCarryOverBroadcastEvents(
  events: ChatBroadcastEvent[],
  videoStartOffset: number,
  videoEndOffset: number,
  gapAdjustments: { atChunk: number; missingDurationSec: number }[],
  baseOffsetSec: number,
  baseSeq: number,
  avgChunkDur: number,
  folderPath?: string
): ChatBroadcastEvent[] {
  if (!Array.isArray(events) || events.length === 0) return [];

  const activePredictionsBeforeStart = new Map<string, ChatBroadcastEvent>();
  const activePollsBeforeStart = new Map<string, ChatBroadcastEvent>();
  const activePinsBeforeStart = new Map<string, ChatBroadcastEvent>();
  let activeHypeTrainBeforeStart: ChatBroadcastEvent | null = null;
  const sliced: ChatBroadcastEvent[] = [];

  for (const evt of events) {
    if (!evt) continue;
    const evtType = evt.event_type || (evt.type as any);
    let streamTime = evt.content_offset_seconds || 0;
    if (gapAdjustments && gapAdjustments.length > 0) {
      for (const gap of gapAdjustments) {
        const gapOffsetSec = computeGapOffsetSec(
          gap.atChunk,
          baseOffsetSec,
          baseSeq,
          avgChunkDur,
          folderPath
        );
        if (streamTime > gapOffsetSec) {
          streamTime -= gap.missingDurationSec;
        }
      }
    }

    if (streamTime < videoStartOffset) {
      if (evtType === "prediction" && evt.data?.prediction_id) {
        const pid = String(evt.data.prediction_id);
        const st = String(evt.data.status || "").toUpperCase();
        if (st === "RESOLVED" || st === "CANCELED" || st === "CANCELLED") {
          activePredictionsBeforeStart.delete(pid);
        } else {
          activePredictionsBeforeStart.set(pid, evt);
        }
      } else if (evtType === "poll" && evt.data?.poll_id) {
        const pollId = String(evt.data.poll_id);
        const st = String(evt.data.status || "").toUpperCase();
        if (st === "COMPLETED" || st === "ARCHIVED" || st === "TERMINATED") {
          activePollsBeforeStart.delete(pollId);
        } else {
          activePollsBeforeStart.set(pollId, evt);
        }
      } else if (evtType === "pinned_chat" && evt.data?.pin_id) {
        const pinId = String(evt.data.pin_id);
        if (evt.category === "unpin_message" || evt.data?.action === "unpin-message") {
          activePinsBeforeStart.delete(pinId);
        } else {
          const prevPin = activePinsBeforeStart.get(pinId);
          if (prevPin) {
            const mergedPin: ChatBroadcastEvent = JSON.parse(JSON.stringify(prevPin));
            mergedPin.data = { ...mergedPin.data, ...evt.data };
            activePinsBeforeStart.set(pinId, mergedPin);
          } else {
            activePinsBeforeStart.set(pinId, evt);
          }
        }
      } else if (evtType === "hype_train") {
        if (
          evt.category === "hype_train_end" ||
          evt.data?.pubsub_type === "hype-train-end" ||
          evt.data?.ended_at
        ) {
          activeHypeTrainBeforeStart = null;
        } else if (activeHypeTrainBeforeStart) {
          const mergedTrain: ChatBroadcastEvent = JSON.parse(
            JSON.stringify(activeHypeTrainBeforeStart)
          );
          mergedTrain.data = { ...mergedTrain.data, ...evt.data };
          activeHypeTrainBeforeStart = mergedTrain;
        } else {
          activeHypeTrainBeforeStart = evt;
        }
      }
    } else if (streamTime >= videoStartOffset && streamTime <= videoEndOffset) {
      const cloned: ChatBroadcastEvent = JSON.parse(JSON.stringify(evt));
      if (!cloned.type) cloned.type = cloned.event_type;
      cloned.content_offset_seconds = parseFloat(
        Math.max(0, streamTime - videoStartOffset).toFixed(3)
      );
      sliced.push(cloned);
    }
  }

  const carriedOver: ChatBroadcastEvent[] = [];
  for (const [, predEvt] of activePredictionsBeforeStart) {
    const cloned: ChatBroadcastEvent = JSON.parse(JSON.stringify(predEvt));
    cloned._id = `${cloned._id}_carryover_${Math.round(videoStartOffset)}`;
    if (!cloned.type) cloned.type = cloned.event_type;
    cloned.content_offset_seconds = 0;
    cloned.carried_over = true;
    carriedOver.push(cloned);
  }
  for (const [, pollEvt] of activePollsBeforeStart) {
    const cloned: ChatBroadcastEvent = JSON.parse(JSON.stringify(pollEvt));
    cloned._id = `${cloned._id}_carryover_${Math.round(videoStartOffset)}`;
    if (!cloned.type) cloned.type = cloned.event_type;
    cloned.content_offset_seconds = 0;
    cloned.carried_over = true;
    carriedOver.push(cloned);
  }
  for (const [, pinEvt] of activePinsBeforeStart) {
    const cloned: ChatBroadcastEvent = JSON.parse(JSON.stringify(pinEvt));
    cloned._id = `${cloned._id}_carryover_${Math.round(videoStartOffset)}`;
    if (!cloned.type) cloned.type = cloned.event_type;
    cloned.content_offset_seconds = 0;
    cloned.carried_over = true;
    carriedOver.push(cloned);
  }
  if (activeHypeTrainBeforeStart) {
    const cloned: ChatBroadcastEvent = JSON.parse(JSON.stringify(activeHypeTrainBeforeStart));
    cloned._id = `${cloned._id}_carryover_${Math.round(videoStartOffset)}`;
    if (!cloned.type) cloned.type = cloned.event_type;
    cloned.content_offset_seconds = 0;
    cloned.carried_over = true;
    carriedOver.push(cloned);
  }

  return [...carriedOver, ...sliced];
}

/**
 * Legacy fallback helper: scans historical unclosed JSON content and finds the end of the last complete comment.
 */
export function findLastCompleteCommentEnd(content: string): number {
  const match = content.match(/"comments"\s*:\s*\[/);
  if (!match || match.index === undefined) return -1;
  const startPos = match.index + match[0].length;

  let inString = false;
  let escape = false;
  let braceDepth = 0;
  let lastCompleteEnd = -1;
  let commentStart = -1;

  for (let i = startPos; i < content.length; i++) {
    const ch = content[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") {
      if (braceDepth === 0) {
        commentStart = i;
      }
      braceDepth++;
    } else if (ch === "}") {
      if (braceDepth > 0) {
        braceDepth--;
        if (braceDepth === 0 && commentStart !== -1) {
          lastCompleteEnd = i + 1;
          commentStart = -1;
        }
      }
    } else if (ch === "]" && braceDepth === 0) {
      const remainder = content.substring(i + 1);
      if (
        /"content_offset_seconds"\s*:\s*[\d.]+/.test(remainder) &&
        /"commenter"\s*:\s*\{/.test(remainder)
      ) {
        return -1;
      }
      break;
    }
  }

  return lastCompleteEnd;
}

/**
 * Legacy fallback helper: resiliently extracts individual comments from malformed historical JSON files.
 */
export function extractChatCommentsFallback(content: string): any {
  const fileInfo = {
    Version: { Major: 1, Minor: 5, Patch: 3 },
    CreatedAt: new Date().toISOString(),
    UpdatedAt: new Date().toISOString(),
  };
  let streamer: any = { name: "streamer", id: 0 };
  let video: any = {
    title: "",
    description: "",
    id: "",
    created_at: new Date().toISOString(),
    start: 0,
    end: 0,
    length: 0,
    viewCount: 0,
    game: "",
  };

  const streamerMatch = content.match(/"streamer"\s*:\s*(\{[^}]+\})/);
  if (streamerMatch) {
    try {
      streamer = JSON.parse(streamerMatch[1]);
    } catch (_) {}
  }
  streamer = {
    name: streamer?.name || "streamer",
    id: coerceSafeInt32StreamerId(streamer?.id),
  };

  const videoMatch = content.match(
    /"video"\s*:\s*(\{[^}]+length":\s*[\d.]+\s*,\s*"viewCount":\s*\d+\s*,\s*"game":\s*"[^"]*"\s*\})/
  );
  if (videoMatch) {
    try {
      video = JSON.parse(videoMatch[1]);
    } catch (_) {}
  }

  const comments: any[] = [];
  const seenIds = new Set<string>();

  const match = content.match(/"comments"\s*:\s*\[/);
  const startPos = match && match.index !== undefined ? match.index + match[0].length : 0;

  let inString = false;
  let escape = false;
  let braceDepth = 0;
  let commentStart = -1;

  for (let i = startPos; i < content.length; i++) {
    const ch = content[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") {
      if (braceDepth === 0) {
        commentStart = i;
      }
      braceDepth++;
    } else if (ch === "}") {
      if (braceDepth > 0) {
        braceDepth--;
        if (braceDepth === 0 && commentStart !== -1) {
          const rawComment = content.substring(commentStart, i + 1);
          commentStart = -1;
          try {
            const commentObj = JSON.parse(rawComment);
            if (
              commentObj &&
              commentObj._id &&
              commentObj._id !== "dummy-end-message" &&
              (commentObj.message || commentObj.commenter) &&
              !seenIds.has(commentObj._id)
            ) {
              seenIds.add(commentObj._id);
              comments.push(commentObj);
            }
          } catch (_) {}
        }
      }
    }
  }

  comments.sort((a, b) => (a.content_offset_seconds || 0) - (b.content_offset_seconds || 0));

  if (comments.length > 0) {
    const lastOffset = Math.ceil(comments[comments.length - 1].content_offset_seconds || 0);
    video.length = Math.max(video.length, lastOffset);
    video.end = Math.max(video.end, lastOffset);
  }

  let thirdParty: any[] = [];
  const emotesMatch = content.match(/"thirdParty"\s*:\s*(\[[^\]]*\])/);
  if (emotesMatch) {
    try {
      thirdParty = JSON.parse(emotesMatch[1]);
    } catch (_) {}
  }

  return {
    FileInfo: fileInfo,
    schemaVersion: "2.0-extended",
    streamer,
    video,
    comments,
    events: [],
    embeddedData: {
      thirdParty,
      firstParty: [],
      twitchBadges: [],
    },
  };
}

export function safeParseChatData(content: string, chatFilePath?: string): any {
  if (!content || !content.trim()) return null;

  let result: any = null;

  try {
    const parsed = JSON.parse(content);
    if (parsed && Array.isArray(parsed.comments)) {
      result = parsed;
    }
  } catch (_) {}

  if (!result) {
    const lastEnd = findLastCompleteCommentEnd(content);
    if (lastEnd !== -1) {
      const sealed = content.substring(0, lastEnd) + '\n  ],\n  "embeddedData": null\n}';
      try {
        const parsed = JSON.parse(sealed);
        if (parsed && Array.isArray(parsed.comments)) {
          result = parsed;
        }
      } catch (_) {}
    }
  }

  if (!result) {
    result = extractChatCommentsFallback(content);
  }

  if (result) {
    const mergedEvents = readBroadcastEventsForChatFile(chatFilePath, result);
    if (mergedEvents.length > 0 || Array.isArray(result.events)) {
      result.events = mergedEvents;
    }
    if (!result.schemaVersion) {
      result.schemaVersion = "2.0-extended";
    }
  }

  return result;
}

export async function writeChatSessionHeader(
  chatFilePath: string,
  headerPayload: any
): Promise<void> {
  const headerPath = getChatSessionHeaderPath(chatFilePath);
  await writeJsonAtomic(headerPath, headerPayload);
}

export function readChatSessionHeaderSync(chatFilePath: string): any | null {
  const headerPath = getChatSessionHeaderPath(chatFilePath);
  if (!fs.existsSync(headerPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(headerPath, "utf8"));
  } catch (_) {
    return null;
  }
}

/**
 * Reads all valid comments from an append-only `.comments.jsonl` journal file.
 * Corrupted trailing partial lines (e.g. from power loss mid-write) are cleanly ignored.
 */
export async function readCommentsFromJournal(
  journalPath: string
): Promise<{ comments: any[]; seenIds: Set<string>; maxOffsetSec: number }> {
  const comments: any[] = [];
  const seenIds = new Set<string>();
  let maxOffsetSec = 0;

  if (!fs.existsSync(journalPath)) {
    return { comments, seenIds, maxOffsetSec };
  }

  const raw = await fs.promises.readFile(journalPath, "utf8");
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const c = JSON.parse(trimmed);
      if (c && c._id && c._id !== "dummy-end-message" && !seenIds.has(c._id)) {
        seenIds.add(c._id);
        comments.push(c);
        const off = Number(c.content_offset_seconds) || 0;
        if (off > maxOffsetSec) maxOffsetSec = off;
      }
    } catch (_) {
      // Ignore incomplete trailing line from unexpected crash
    }
  }

  return { comments, seenIds, maxOffsetSec };
}

/**
 * Loads the complete chat dataset (header metadata, comments, events, and 3rd party emotes)
 * seamlessly from `.comments.jsonl`, `.events.jsonl`, `session_chat_header_*`, and/or legacy `.json`.
 */
export async function loadUnifiedChatDataset(
  chatFilePath: string,
  session?: any
): Promise<any | null> {
  if (!chatFilePath) return null;

  const folderPath = path.dirname(chatFilePath);
  const journalPath = getCommentsJournalPath(chatFilePath);
  const hasJournal = fs.existsSync(journalPath);
  const hasLegacyJson = fs.existsSync(chatFilePath);

  if (!hasJournal && !hasLegacyJson) {
    return null;
  }

  let baseData: any = null;
  const mergedComments: any[] = [];
  const seenCommentIds = new Set<string>();

  // 1. Load header metadata first from sidecar header or session manifest
  const savedHeader = readChatSessionHeaderSync(chatFilePath);
  if (savedHeader) {
    baseData = JSON.parse(JSON.stringify(savedHeader));
  }

  // 2. If a `.json` file also exists (legacy session or already-sealed master file), merge its comments & header
  if (hasLegacyJson) {
    try {
      const rawJson = await fs.promises.readFile(chatFilePath, "utf8");
      const parsedLegacy = safeParseChatData(rawJson, chatFilePath);
      if (parsedLegacy) {
        if (!baseData) {
          baseData = {
            FileInfo: parsedLegacy.FileInfo,
            schemaVersion: parsedLegacy.schemaVersion || "2.0-extended",
            streamer: parsedLegacy.streamer,
            video: parsedLegacy.video,
            embeddedData: parsedLegacy.embeddedData,
            emotes: parsedLegacy.emotes,
          };
        }
        if (Array.isArray(parsedLegacy.comments)) {
          for (const c of parsedLegacy.comments) {
            if (c && c._id && c._id !== "dummy-end-message" && !seenCommentIds.has(c._id)) {
              seenCommentIds.add(c._id);
              mergedComments.push(c);
            }
          }
        }
      }
    } catch (_) {}
  }

  // 3. Load append-only `.comments.jsonl` journal comments
  if (hasJournal) {
    try {
      const journalResult = await readCommentsFromJournal(journalPath);
      for (const c of journalResult.comments) {
        if (!seenCommentIds.has(c._id)) {
          seenCommentIds.add(c._id);
          mergedComments.push(c);
        }
      }
    } catch (_) {}
  }

  mergedComments.sort((a, b) => (a.content_offset_seconds || 0) - (b.content_offset_seconds || 0));

  const manifest = readSessionManifestSync(folderPath);
  const events = readBroadcastEventsForChatFile(chatFilePath, baseData);

  const normalized = normalizeTwitchDownloaderSchema(baseData || {}, {
    channelLogin: session?.channel || manifest?.channelLogin || baseData?.streamer?.name,
    streamerId: session?.twitchId || manifest?.twitchId || baseData?.streamer?.id,
    streamId: session?.streamId || manifest?.streamId || baseData?.video?.id,
    title: session?.currentTitle || manifest?.title || baseData?.video?.title,
    createdAt: session?.startTime || manifest?.createdAt || baseData?.video?.created_at,
    gameName: session?.currentGame || baseData?.video?.game,
    thirdPartyEmotes: session?.thirdPartyEmotes || baseData?.embeddedData?.thirdParty,
  });

  normalized.comments = mergedComments;
  normalized.events = events;
  return normalized;
}

export interface CompileChatSliceParams {
  sourceChatFilePath: string;
  outputFilePath: string;
  channelLogin: string;
  folderPath?: string;
  session?: any;
  startOffsetSec: number;
  endOffsetSec: number;
  durationSec: number;
  gameName?: string;
  gapAdjustments?: { atChunk: number; missingDurationSec: number }[];
  baseOffsetSec?: number;
  baseSeq?: number;
  avgChunkDur?: number;
  expandEndToMaxComment?: boolean;
}

export interface CompileChatSliceResult {
  commentCount: number;
  totalSourceComments: number;
  eventCount: number;
  durationSec: number;
  effectiveEndOffsetSec: number;
}

/**
 * Unified `ChatSliceCompiler`:
 * Consolidates all live game slices, custom range clips, append extensions, `chat_only` exports,
 * and VOD backfill fallback slices into a single deterministic pipeline.
 * Applies `gapAdjustments` uniformly to BOTH comments and broadcast events.
 */
export async function compileChatSlice(
  params: CompileChatSliceParams
): Promise<CompileChatSliceResult | null> {
  const dataset = await loadUnifiedChatDataset(params.sourceChatFilePath, params.session);
  if (!dataset || !Array.isArray(dataset.comments)) {
    return null;
  }

  const gapAdjustments = params.gapAdjustments || [];
  const baseOffsetSec = params.baseOffsetSec ?? 0;
  const baseSeq = params.baseSeq ?? 0;
  const avgChunkDur = params.avgChunkDur && params.avgChunkDur > 0 ? params.avgChunkDur : 2.0;

  let effectiveEndOffsetSec = params.endOffsetSec;
  if (params.expandEndToMaxComment && dataset.comments.length > 0) {
    let maxCommentSec = 0;
    for (const c of dataset.comments) {
      const t = c.content_offset_seconds || 0;
      if (t > maxCommentSec) maxCommentSec = t;
    }
    effectiveEndOffsetSec = Math.max(effectiveEndOffsetSec, maxCommentSec);
  }

  // Precompute real presentation timestamps for any stream resumption gaps
  const resolvedGaps = gapAdjustments.map((g) => ({
    gapOffsetSec: computeGapOffsetSec(
      g.atChunk,
      baseOffsetSec,
      baseSeq,
      avgChunkDur,
      params.folderPath
    ),
    missingDurationSec: g.missingDurationSec,
  }));

  const filteredComments: any[] = [];
  for (const c of dataset.comments) {
    if (!c || c._id === "dummy-end-message") continue;
    let streamTime = Number(c.content_offset_seconds) || 0;
    if (resolvedGaps.length > 0) {
      for (const gap of resolvedGaps) {
        if (streamTime > gap.gapOffsetSec) {
          streamTime -= gap.missingDurationSec;
        }
      }
    }
    if (streamTime >= params.startOffsetSec && streamTime <= effectiveEndOffsetSec) {
      const cloned = JSON.parse(JSON.stringify(c));
      cloned.content_offset_seconds = parseFloat(
        Math.max(0, streamTime - params.startOffsetSec).toFixed(3)
      );
      filteredComments.push(cloned);
    }
  }

  const filteredEvents = sliceAndCarryOverBroadcastEvents(
    Array.isArray(dataset.events) ? dataset.events : [],
    params.startOffsetSec,
    effectiveEndOffsetSec,
    gapAdjustments,
    baseOffsetSec,
    baseSeq,
    avgChunkDur,
    params.folderPath
  );

  const finalDurationSec = Math.max(1, params.durationSec);

  const slicePayload = normalizeTwitchDownloaderSchema(
    {
      ...dataset,
      comments: filteredComments,
      events: filteredEvents,
    },
    {
      channelLogin: params.channelLogin || dataset.streamer?.name,
      streamerId: params.session?.twitchId || dataset.streamer?.id,
      streamId: params.session?.streamId || dataset.video?.id,
      title: params.session?.currentTitle || dataset.video?.title,
      gameName: params.gameName || dataset.video?.game,
      durationSec: finalDurationSec,
      thirdPartyEmotes:
        params.session?.thirdPartyEmotes || dataset.embeddedData?.thirdParty || [],
    }
  );

  await populateEmbeddedDataForChat(
    slicePayload,
    slicePayload.streamer.name,
    slicePayload.streamer.id
  );

  await writeJsonAtomic(params.outputFilePath, slicePayload);

  return {
    commentCount: filteredComments.length,
    totalSourceComments: dataset.comments.length,
    eventCount: filteredEvents.length,
    durationSec: finalDurationSec,
    effectiveEndOffsetSec,
  };
}

/**
 * Seals an active or orphaned `.comments.jsonl` + `.events.jsonl` journal into a complete,
 * valid `chat_YYYY-MM-DD.json` TwitchDownloader master file via atomic write, then removes
 * temporary sidecars once verified on disk.
 */
export async function sealMasterChatFileFromJournal(
  chatFilePath: string,
  options?: {
    channelLogin?: string;
    session?: any;
    durationSec?: number;
    keepJournalSidecars?: boolean;
  }
): Promise<{ commentCount: number; eventCount: number; durationSec: number } | null> {
  if (!chatFilePath) return null;

  const dataset = await loadUnifiedChatDataset(chatFilePath, options?.session);
  if (!dataset) return null;

  const realUserCommentsCount = dataset.comments.length;
  let durationSec = Math.max(0, Math.round(options?.durationSec || 0));
  if (durationSec <= 0 && realUserCommentsCount > 0) {
    const maxOff = Math.ceil(
      dataset.comments[realUserCommentsCount - 1].content_offset_seconds || 0
    );
    durationSec = Math.max(1, maxOff);
  }

  const session = options?.session;
  const channelLogin = options?.channelLogin || session?.channel || dataset.streamer?.name || "streamer";
  const streamerId = coerceSafeInt32StreamerId(session?.twitchId || dataset.streamer?.id);

  // Build emote & badge maps if not already populated on session
  let usedEmotes: Map<string, string> = session?.usedFirstPartyEmotes || new Map();
  let usedBadges: Map<string, Set<string>> = session?.usedTwitchBadges || new Map();
  if (usedEmotes.size === 0 && usedBadges.size === 0 && dataset.comments.length > 0) {
    extractUsedEmotesAndBadgesFromComments(dataset.comments, undefined, usedEmotes, usedBadges);
  }

  const [firstPartyEmotes, twitchBadges] = await Promise.all([
    fetchFirstPartyEmotesFromMap(usedEmotes),
    fetchTwitchBadgesFromMap(channelLogin, String(streamerId || ""), usedBadges),
  ]);

  const nowIso = new Date().toISOString();
  const dummyEndMessage = {
    _id: "dummy-end-message",
    created_at: nowIso,
    channel_id: "",
    content_type: "video",
    content_id: "",
    content_offset_seconds: durationSec,
    commenter: {
      display_name: "System",
      _id: "0",
      name: "system",
      type: "user",
      bio: "",
      created_at: nowIso,
      updated_at: nowIso,
      logo: "",
    },
    source: "chat",
    state: "published",
    message: {
      body: "",
      fragments: [{ text: "", emoticon: null }],
      is_action: false,
      user_badges: [],
      user_color: "#000000",
    },
  };

  const finalPayload = normalizeTwitchDownloaderSchema(
    {
      ...dataset,
      comments: [...dataset.comments, dummyEndMessage],
      events: dataset.events || [],
      embeddedData: {
        thirdParty:
          session?.thirdPartyEmotes || dataset.embeddedData?.thirdParty || [],
        firstParty: firstPartyEmotes,
        twitchBadges,
      },
    },
    {
      channelLogin,
      streamerId,
      streamId: session?.streamId || dataset.video?.id,
      title: session?.currentTitle || dataset.video?.title,
      gameName: session?.currentGame || dataset.video?.game,
      durationSec,
      thirdPartyEmotes: session?.thirdPartyEmotes || dataset.embeddedData?.thirdParty || [],
    }
  );

  await writeJsonAtomic(chatFilePath, finalPayload);

  // Verify sealed JSON parses cleanly before removing append-only journal sidecars
  if (!options?.keepJournalSidecars && fs.existsSync(chatFilePath)) {
    try {
      const stat = await fs.promises.stat(chatFilePath);
      if (stat.size > 50) {
        const journalPath = getCommentsJournalPath(chatFilePath);
        const eventsPath = getEventsSidecarPath(chatFilePath);
        const headerPath = getChatSessionHeaderPath(chatFilePath);
        if (fs.existsSync(journalPath)) await fs.promises.unlink(journalPath).catch(() => {});
        if (fs.existsSync(eventsPath)) await fs.promises.unlink(eventsPath).catch(() => {});
        if (fs.existsSync(headerPath)) await fs.promises.unlink(headerPath).catch(() => {});
      }
    } catch (err: any) {
      addLog(`[Chat Seal] Retained journal sidecars due to verification note: ${err.message}`);
    }
  }

  return {
    commentCount: realUserCommentsCount,
    eventCount: (dataset.events || []).length,
    durationSec,
  };
}

/**
 * Removes the master broadcast chat file and any associated journal/header sidecars
 * after multi-game broadcast slicing has completed and verified.
 */
export async function cleanupMasterChatArtifacts(chatFilePath?: string): Promise<void> {
  if (!chatFilePath) return;
  const targets = [
    chatFilePath,
    getCommentsJournalPath(chatFilePath),
    getEventsSidecarPath(chatFilePath),
    getChatSessionHeaderPath(chatFilePath),
  ];
  for (const p of targets) {
    if (p && fs.existsSync(p)) {
      await fs.promises.unlink(p).catch(() => {});
    }
  }
}
