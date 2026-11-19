import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import WebSocket from "ws";
import { state, addLog, updateTask, removeTask, resolveTdPath, getChatRenderDimensionsForGame, getChatRenderDimensionsForChatFile, cleanChannelName } from "./state";
import { emitSessionsDelta } from "./eventBus";
import { attachHermesOverlayClient, refreshLiveChatAuth } from "./hermesClient";
import { postTwitchGql, fetchRecentVods } from "./twitch";
import {
  fetchThirdPartyEmotes,
  extractUsedEmotesAndBadgesFromComments,
  fetchFirstPartyEmotesFromMap,
  fetchTwitchBadgesFromMap,
  populateEmbeddedDataForChat
} from "./emotes";
import { ensureFfmpeg, getVideoDurationSeconds, checkVideoIsHevc } from "./ffmpeg";
import { isSessionHevcOrFmp4FromManifest } from "./sessionManifest";
import {
  getEventsSidecarPath,
  getCommentsJournalPath,
  getChatSessionHeaderPath,
  hasChatSource,
  readBroadcastEventsForChatFile,
  sliceAndCarryOverBroadcastEvents,
  findLastCompleteCommentEnd,
  extractChatCommentsFallback,
  safeParseChatData,
  writeChatSessionHeader,
  readCommentsFromJournal,
  normalizeTwitchDownloaderSchema,
  writeJsonAtomic,
  sealMasterChatFileFromJournal
} from "./chatCompiler";

import type { ChatBroadcastEvent } from "../types";

export {
  getEventsSidecarPath,
  getCommentsJournalPath,
  getChatSessionHeaderPath,
  hasChatSource,
  readBroadcastEventsForChatFile,
  sliceAndCarryOverBroadcastEvents,
  findLastCompleteCommentEnd,
  extractChatCommentsFallback,
  safeParseChatData,
  refreshLiveChatAuth
};

export function unescapeIrcTagValue(val: string): string {
  if (!val || !val.includes('\\')) return val || "";
  let out = "";
  for (let i = 0; i < val.length; i++) {
    if (val[i] === '\\' && i + 1 < val.length) {
      const next = val[i + 1];
      if (next === ':') { out += ';'; i++; }
      else if (next === 's') { out += ' '; i++; }
      else if (next === '\\') { out += '\\'; i++; }
      else if (next === 'r') { out += '\r'; i++; }
      else if (next === 'n') { out += '\n'; i++; }
      else { out += next; i++; }
    } else if (val[i] !== '\\') {
      out += val[i];
    }
  }
  return out;
}

export function parseIrcMessage(raw: string) {
  if (!raw.startsWith('@')) return null;

  const space1 = raw.indexOf(' ');
  if (space1 === -1) return null;
  const tagsPart = raw.substring(1, space1);
  const rest1 = raw.substring(space1 + 1).trimStart();

  if (!rest1.startsWith(':')) return null;
  const space2 = rest1.indexOf(' ');
  if (space2 === -1) return null;
  const prefixPart = rest1.substring(1, space2);
  const rest2 = rest1.substring(space2 + 1).trimStart();

  const space3 = rest2.indexOf(' ');
  let command = "";
  let rest3 = "";
  if (space3 === -1) {
    command = rest2.trim();
  } else {
    command = rest2.substring(0, space3);
    rest3 = rest2.substring(space3 + 1);
  }

  let channel = "";
  let message = "";
  const space4 = rest3.indexOf(' :');
  if (space4 !== -1) {
    channel = rest3.substring(0, space4).trim();
    message = rest3.substring(space4 + 2);
  } else if (rest3.startsWith(':')) {
    message = rest3.substring(1);
  } else {
    channel = rest3.trim();
  }

  const tags: Record<string, string> = {};
  tagsPart.split(';').forEach(t => {
    if (!t) return;
    const eqIdx = t.indexOf('=');
    if (eqIdx !== -1) {
      const k = t.substring(0, eqIdx);
      const v = unescapeIrcTagValue(t.substring(eqIdx + 1));
      tags[k] = v;
    } else {
      tags[t] = "";
    }
  });

  const username = prefixPart.split('!')[0];

  return { tags, username, command, channel, message };
}

export function appendBroadcastEvent(channelLogin: string, event: ChatBroadcastEvent) {
  const session = state.activeDownloadSessions[channelLogin];
  if (!session || session.isStopped) return;

  if (!event.type) {
    event.type = event.event_type;
  }
  if (!event.source) {
    event.source = ['clearchat', 'clearmsg', 'roomstate'].includes(event.event_type) ? 'irc' : 'pubsub';
  }

  if (!session.eventExistingIds) {
    session.eventExistingIds = new Set<string>();
  }
  if (session.eventExistingIds.has(event._id)) return;
  session.eventExistingIds.add(event._id);
  session.eventsWritten = (session.eventsWritten || 0) + 1;
  emitSessionsDelta();

  const sidecarPath = session.eventsFilePath || (session.chatFilePath ? getEventsSidecarPath(session.chatFilePath) : "");
  if (sidecarPath) {
    session.eventsFilePath = sidecarPath;
    fs.promises.appendFile(sidecarPath, JSON.stringify(event) + "\n", "utf8").catch(() => {});
  }
}

export function parseBadges(badgesTag: string) {
  if (!badgesTag) return [];
  return badgesTag.split(',').map(b => {
    const [id, version] = b.split('/');
    return { _id: id, version };
  });
}

export function buildFragments(message: string, emotesTag: string) {
  if (!emotesTag) return [{ text: message }];
  
  const placements: { start: number, end: number, id: string }[] = [];
  const emoteGroups = emotesTag.split('/');
  for (const group of emoteGroups) {
    const [id, positions] = group.split(':');
    if (!positions) continue;
    for (const pos of positions.split(',')) {
      const [start, end] = pos.split('-');
      placements.push({ start: parseInt(start), end: parseInt(end), id });
    }
  }
  
  placements.sort((a, b) => a.start - b.start);
  
  const fragments = [];
  let currentIndex = 0;
  
  for (const p of placements) {
    if (p.start > currentIndex) {
      fragments.push({ text: message.substring(currentIndex, p.start) });
    }
    // Prevent out of bounds or negative indices
    if (p.start >= 0 && p.end < message.length && p.start <= p.end) {
      fragments.push({
        text: message.substring(p.start, p.end + 1),
        emoticon: { emoticon_id: p.id, emoticon_set_id: "" }
      });
    }
    currentIndex = p.end + 1;
  }
  
  if (currentIndex < message.length) {
    fragments.push({ text: message.substring(currentIndex) });
  }
  
  // Clean up any stray unpaired surrogates that might have sneaked in from other places
  for (const frag of fragments) {
     if (frag.text && typeof frag.text.toWellFormed === 'function') {
         frag.text = frag.text.toWellFormed();
     } else if (frag.text) {
         frag.text = frag.text.replace(/[\uD800-\uDFFF]/g, '');
     }
  }
  
  return fragments;
}

  export async function downloadVodChat(
    channelLogin: string, 
    folderPath: string, 
    isBackfill: boolean = false, 
    chatFilePathOverride?: string, 
    startOffset: number = 0, 
    appendMode: boolean = false, 
    initialCommentsWritten: number = 0,
    maxOffset?: number,
    existingIds?: Set<string>
  ) {
    const taskId = `vod_chat_${Date.now()}`;
    if (!isBackfill) {
      updateTask(taskId, "Downloading VOD Chat", "Initializing...", "running", true, [{ label: "Cancel", value: "cancel" }]);
    }
    addLog(`[Chat] Starting VOD chat download for ${channelLogin}...`);
    
    let chatStream: fs.WriteStream | undefined;
    const backfillComments: any[] = [];

    try {
      // 1. Get User ID and Latest VOD
      if (!isBackfill) {
        updateTask(taskId, "Downloading VOD Chat", "Fetching VOD info...", "running", true, [{ label: "Cancel", value: "cancel" }]);
      }
      const userQuery = await fetchRecentVods(channelLogin, 1);

      const user = userQuery.data?.data?.user;
      if (!user) throw new Error("Could not fetch user ID.");
      const twitchId = user.id;

      const latestVod = user.videos?.edges?.[0]?.node;
      if (!latestVod) {
         addLog(`[Chat] No VOD found for ${channelLogin}. Skipping VOD chat download.`);
         if (!isBackfill) removeTask(taskId);
         return null;
      }

      const vodId = latestVod.id;
      const videoLength = latestVod.lengthSeconds || 0;
      if (!isBackfill) {
        updateTask(taskId, "Downloading VOD Chat", `Found VOD ID: ${vodId}. Fetching emotes...`, "running", true, [{ label: "Cancel", value: "cancel" }]);
      }

      // 2. Fetch 3rd Party Emotes
      let thirdPartyEmotes: any[] = [];
      try {
        thirdPartyEmotes = await fetchThirdPartyEmotes(twitchId);
      } catch (e) {
        addLog(`[Chat] Non-fatal error fetching some 3rd party emotes.`);
      }

      if (!isBackfill) {
        updateTask(taskId, "Downloading VOD Chat", `Fetched ${thirdPartyEmotes.length} emotes. Starting message download...`, "running", true, [{ label: "Cancel", value: "cancel" }]);
      }

      // 3. Fetch Chat Messages
      const processedIds = new Set<string>();
      const vodUsedEmotes = new Map<string, string>();
      const vodUsedBadges = new Map<string, Set<string>>();
      let cursor = "";
      let contentOffset = startOffset || 0.0;
      let pageCount = 0;
      let emptyOffsetJumps = 0;
      let consecutiveNetworkErrors = 0;
      let useCursor = true;
      let commentsWritten = initialCommentsWritten || 0;

      if (!isBackfill) {
        const chatFilePath = chatFilePathOverride || path.join(folderPath, `vod_chat.json`);
        chatStream = fs.createWriteStream(chatFilePath, { flags: appendMode ? 'a' : 'w' });

        if (!appendMode) {
          // Write JSON Header
          const headerObj = {
            FileInfo: {
              Version: { Major: 1, Minor: 5, Patch: 3 },
              CreatedAt: new Date().toISOString(),
              UpdatedAt: new Date().toISOString()
            },
            streamer: { name: channelLogin, id: parseInt(twitchId, 10) || 0 },
            video: {
              title: latestVod.title,
              description: "",
              id: vodId,
              created_at: latestVod.createdAt,
              start: 0,
              end: videoLength,
              length: videoLength,
              viewCount: 0,
              game: latestVod.game?.name || ""
            }
          };
          chatStream.write(JSON.stringify(headerObj).slice(0, -1) + ',"comments":[');
        }
      }

      while (true) {
        if (!isBackfill) {
          if (!state.activeTasks[taskId]) {
            addLog(`[Chat] Download task removed.`);
            chatStream?.end();
            throw new Error("Task removed");
          }
          if (state.activeTasks[taskId].cancelled) {
            addLog(`[Chat] Download cancelled by user.`);
            chatStream?.end();
            throw new Error("Cancelled by user");
          }
        } else {
          if (!state.activeDownloadSessions[channelLogin]) {
            addLog(`[Chat] Download session removed. Stopping backfill.`);
            throw new Error("Session removed");
          }
        }

        let chatQuery: any;
        try {
          if (cursor && useCursor) {
            chatQuery = await postTwitchGql({
              query: `query($vodId: ID!, $after: Cursor!) { video(id: $vodId) { comments(first: 100, after: $after) { edges { cursor node { id createdAt contentOffsetSeconds commenter { id login displayName } message { fragments { text emote { emoteID from } } userBadges { setID version } userColor } } } pageInfo { hasNextPage } } } }`,
              variables: { vodId, after: cursor }
            });
          } else {
            chatQuery = await postTwitchGql({
              query: `query($vodId: ID!, $offset: Int!) { video(id: $vodId) { comments(first: 100, contentOffsetSeconds: $offset) { edges { cursor node { id createdAt contentOffsetSeconds commenter { id login displayName } message { fragments { text emote { emoteID from } } userBadges { setID version } userColor } } } pageInfo { hasNextPage } } } }`,
              variables: { vodId, offset: Math.floor(contentOffset) }
            });
          }
          consecutiveNetworkErrors = 0;
        } catch (err: any) {
          consecutiveNetworkErrors++;
          if (consecutiveNetworkErrors >= 10 || (videoLength > 0 && contentOffset >= videoLength)) {
            addLog(`[Chat] Stopping VOD chat download after ${consecutiveNetworkErrors} consecutive network errors at offset ${contentOffset}s (${err.message}).`);
            break;
          }
          addLog(`[Chat] Network error at offset ${contentOffset}: ${err.message}. Retrying (${consecutiveNetworkErrors}/10)...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          if (cursor && useCursor) {
            cursor = "";
            contentOffset = Math.floor(contentOffset) + 1;
          } else {
            contentOffset = Math.floor(contentOffset) + 10;
          }
          continue;
        }

        const videoNode = chatQuery.data?.data?.video;
        if (!videoNode || !videoNode.comments) {
          if (chatQuery.data?.errors) {
            const errorMsg = JSON.stringify(chatQuery.data.errors);
            
            if (errorMsg.includes("failed integrity check")) {
               if (useCursor) {
                 addLog(`[Chat] Notice: VOD chat is incomplete or live. Switching to offset-based pagination.`);
                 useCursor = false;
               }
               cursor = "";
               continue;
            } else {
               addLog(`[Chat] GraphQL Error at offset ${contentOffset}: ${errorMsg}`);
            }
          }
          if (cursor && useCursor) {
            addLog(`[Chat] API error with cursor at offset ${contentOffset}. Dropping cursor and retrying...`);
            cursor = "";
            contentOffset = Math.floor(contentOffset) + 1;
            continue;
          } else if (videoLength > 0 && contentOffset < videoLength - 10) {
            addLog(`[Chat] API returned null at offset ${contentOffset}. Skipping forward 10s...`);
            contentOffset += 10;
            emptyOffsetJumps++;
            if (emptyOffsetJumps > 500) {
              addLog(`[Chat] Too many empty jumps. Ending chat download.`);
              break;
            }
            continue;
          } else {
            addLog(`[Chat] API returned null/error at offset ${contentOffset}. Ending.`);
            break;
          }
        }

        const edges = videoNode.comments.edges;
        
        if (edges.length === 0) {
          if (videoLength > 0 && contentOffset < videoLength - 10) {
            contentOffset += 10;
            cursor = "";
            emptyOffsetJumps++;
            if (emptyOffsetJumps > 500) {
              addLog(`[Chat] Too many empty jumps. Ending chat download.`);
              break;
            }
            continue;
          } else {
            break;
          }
        }
        
        emptyOffsetJumps = 0;
        let newMessagesCount = 0;

        let reachedMaxOffset = false;

        for (const edge of edges) {
          const node = edge.node;
          cursor = edge.cursor;
          contentOffset = node.contentOffsetSeconds;

          if (maxOffset !== undefined && node.contentOffsetSeconds > maxOffset) {
            reachedMaxOffset = true;
            break;
          }

          if (!node.commenter || processedIds.has(node.id) || (existingIds && existingIds.has(node.id))) continue;
          processedIds.add(node.id);
          newMessagesCount++;

          const tdComment = {
            _id: node.id,
            created_at: node.createdAt,
            updated_at: node.createdAt,
            channel_id: twitchId,
            content_type: "video",
            content_id: vodId,
            content_offset_seconds: node.contentOffsetSeconds,
            commenter: {
              display_name: node.commenter.displayName,
              _id: node.commenter.id,
              name: node.commenter.login,
              type: "user",
              bio: "",
              created_at: node.createdAt,
              updated_at: node.createdAt,
              logo: ""
            },
            source: "chat",
            state: "published",
            message: {
              body: node.message.fragments.map((f: any) => f.text).join(""),
              fragments: node.message.fragments.map((f: any) => ({
                text: f.text,
                emoticon: f.emote ? {
                  emoticon_id: f.emote.emoteID,
                  emoticon_set_id: ""
                } : null
              })),
              is_action: false,
              user_badges: node.message.userBadges ? node.message.userBadges.map((b: any) => ({
                _id: b.setID,
                version: b.version
              })) : [],
              user_color: node.message.userColor || null,
              user_notice_params: {}
            }
          };

          extractUsedEmotesAndBadgesFromComments([tdComment], undefined, vodUsedEmotes, vodUsedBadges);
          
          if (isBackfill) {
            backfillComments.push(tdComment);
          } else {
            if (commentsWritten > 0) {
              chatStream?.write(',');
            }
            chatStream?.write(JSON.stringify(tdComment));
          }
          commentsWritten++;
        }

        if (reachedMaxOffset) {
          addLog(`[Chat Backfill] Reached gap upper boundary at ${contentOffset.toFixed(1)}s. Finished gap backfill.`);
          break;
        }

        if (newMessagesCount === 0 && !useCursor) {
           contentOffset = Math.floor(contentOffset) + 1;
        }

        const hasNextPage = videoNode.comments.pageInfo.hasNextPage;
        if (!hasNextPage) {
          if (videoLength > 0 && contentOffset < videoLength - 10) {
            contentOffset = Math.floor(contentOffset) + 1;
            cursor = "";
          } else {
            break;
          }
        }

        pageCount++;
        if (pageCount % 50 === 0) {
          addLog(`[Chat] Downloaded ${commentsWritten} messages (Offset: ${contentOffset}s)`);
          if (!isBackfill) {
            updateTask(taskId, "Downloading VOD Chat", `Downloaded ${commentsWritten} messages so far...`, "running", true, [{ label: "Cancel", value: "cancel" }]);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      if (!isBackfill) {
        updateTask(taskId, "Downloading VOD Chat", `Downloaded ${commentsWritten} total messages. Embedding emotes & badges...`);
      }
      addLog(`[Chat] Finished downloading ${commentsWritten} messages.`);

      if (isBackfill) {
        return { backfillComments, commentsWritten, processedIds, videoLength, vodUsedEmotes, vodUsedBadges };
      }

      const dummyMessage = {
        _id: "dummy-end-message",
        created_at: new Date().toISOString(),
        channel_id: "",
        content_type: "video",
        content_id: "",
        content_offset_seconds: Math.floor(videoLength),
        commenter: {
          display_name: "System",
          _id: "0",
          name: "system",
          type: "user",
          bio: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          logo: ""
        },
        source: "chat",
        state: "published",
        message: {
          body: "",
          fragments: [{ text: "", emoticon: null }],
          is_action: false,
          user_badges: [],
          user_color: "#000000"
        }
      };

      const prefix = commentsWritten === 0 ? "" : ",";
      chatStream?.write(prefix + JSON.stringify(dummyMessage));
      commentsWritten++;

      const [firstPartyEmotes, twitchBadges] = await Promise.all([
        fetchFirstPartyEmotesFromMap(vodUsedEmotes),
        fetchTwitchBadgesFromMap(channelLogin, twitchId, vodUsedBadges)
      ]);

      // 4. Construct Final JSON
      chatStream?.write('],"embeddedData":' + JSON.stringify({
        thirdParty: thirdPartyEmotes,
        firstParty: firstPartyEmotes,
        twitchBadges
      }) + '}');
      
      chatStream?.end();
      addLog(`[Chat] Successfully saved vod_chat.json to ${folderPath} (${commentsWritten} messages)`);
      updateTask(taskId, `VOD Chat Downloaded (${channelLogin})`, `Saved to ${folderPath}`, "success", false, [
        { label: "Render Chat", value: "render_chat" },
        { label: "Open Folder", value: "open_folder" },
        { label: "Close", value: "dismiss" }
      ]);
      state.activeTasks[taskId].folderPath = folderPath;
      state.activeTasks[taskId].channelLogin = channelLogin;
      return null;
    } catch (err: any) {
      addLog(`[Chat] Error downloading VOD chat: ${err.message}`);
      if (!isBackfill) removeTask(taskId);
      
      try {
        if (typeof chatStream !== 'undefined' && chatStream && !chatStream.closed) {
          chatStream.destroy();
        }
      } catch (e) {}

      if (!isBackfill && !chatFilePathOverride) {
        const chatFilePath = path.join(folderPath, `vod_chat.json`);
        if (fs.existsSync(chatFilePath)) {
          try {
            fs.unlinkSync(chatFilePath);
          } catch (e) {}
        }
      }
      return null;
    }
  }

  /**
   * Validate and repair corrupted or concatenated chat JSON files, or seal uncompiled
   * `.comments.jsonl` journals for stopped sessions.
   * Reconstructs a valid schema for TwitchDownloaderCLI and chat rendering.
   */
  export async function repairChatJsonFile(filePath: string): Promise<boolean> {
    if (!filePath) return false;
    try {
      const resolvedTarget = path.resolve(filePath);
      const activeOpenSession = Object.values(state.activeDownloadSessions).find(
        (s: any) =>
          s &&
          !s.isStopped &&
          s.chatStream &&
          s.chatFilePath &&
          path.resolve(s.chatFilePath) === resolvedTarget
      );
      if (activeOpenSession) {
        addLog(`[Chat Repair] Skipping in-place file seal on active open live chat journal: ${path.basename(filePath)} (@${activeOpenSession.channel}).`);
        return true;
      }

      const journalPath = getCommentsJournalPath(filePath);
      if (fs.existsSync(journalPath)) {
        const sealed = await sealMasterChatFileFromJournal(filePath);
        if (sealed) {
          addLog(`[Chat Repair] Sealed append-only chat journal into ${path.basename(filePath)} (${sealed.commentCount} comments, ${sealed.eventCount} events).`);
          return true;
        }
      }

      if (!fs.existsSync(filePath)) return false;

      const raw = await fs.promises.readFile(filePath, 'utf8');
      let parsed: any = null;
      let needsResave = false;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {}

      if (parsed && Array.isArray(parsed.comments)) {
        if (!parsed.FileInfo) needsResave = true;
        if (!parsed.streamer || typeof parsed.streamer.id !== 'number' || isNaN(parsed.streamer.id)) {
          needsResave = true;
        }
        const mergedEvents = readBroadcastEventsForChatFile(filePath, parsed);
        if (mergedEvents.length > 0 && (!Array.isArray(parsed.events) || parsed.events.length !== mergedEvents.length)) {
          parsed.events = mergedEvents;
          needsResave = true;
        }
        if (!parsed.embeddedData) needsResave = true;

        if (needsResave) {
          const normalized = normalizeTwitchDownloaderSchema(parsed);
          await writeJsonAtomic(filePath, normalized);
          addLog(`[Chat Repair] Sanitized header structure (streamer.id: ${normalized.streamer.id}) in ${path.basename(filePath)}.`);
        }
        return true;
      }

      addLog(`[Chat Repair] Malformed JSON detected in ${path.basename(filePath)}. Reconstructing valid chat structure...`);

      const cleanChatObj = safeParseChatData(raw, filePath);
      if (!cleanChatObj || !Array.isArray(cleanChatObj.comments)) {
        throw new Error("Unable to extract comments from file");
      }

      const normalized = normalizeTwitchDownloaderSchema(cleanChatObj);
      await writeJsonAtomic(filePath, normalized);
      addLog(`[Chat Repair] Successfully repaired ${path.basename(filePath)} (${normalized.comments.length} comments recovered).`);
      return true;
    } catch (err: any) {
      addLog(`[Chat Repair Error] Failed to repair ${path.basename(filePath)}: ${err.message}`);
      return false;
    }
  }

  /**
   * Pre-flight sanitizer for chat JSON files before passing to TwitchDownloaderCLI.
   * Strictly enforces .NET System.Int32 streamer.id and required metadata headers.
   */
  export async function sanitizeChatJsonForRendering(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) return;
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const data = safeParseChatData(raw, filePath);
      if (!data) return;

      const needsUpdate =
        !data.FileInfo ||
        !data.streamer ||
        typeof data.streamer.id !== 'number' ||
        isNaN(data.streamer.id) ||
        !data.embeddedData;

      if (needsUpdate) {
        const normalized = normalizeTwitchDownloaderSchema(data);
        await writeJsonAtomic(filePath, normalized);
        addLog(`[Render Sanitizer] Pre-flight verified and updated ${path.basename(filePath)} (streamer.id=${normalized.streamer.id}).`);
      }
    } catch (err: any) {
      addLog(`[Render Sanitizer] Warning: Pre-flight sanitization check for ${path.basename(filePath)}: ${err.message}`);
    }
  }

  /**
   * Detects whether a chat JSON file contains some or all messages originating from a Twitch VOD chat download
   * (where timestamps are quantized to whole integer seconds) vs. purely live IRC WebSocket chat.
   */
  export function hasVodChatMessages(chatFile: string, chatData: any): boolean {
    if (/vod_chat|vod_backfill|vod_broadcast/i.test(chatFile)) {
      return true;
    }
    if (!chatData || !Array.isArray(chatData.comments)) {
      return false;
    }
    const realComments = chatData.comments.filter((c: any) => c && c._id !== "dummy-end-message");
    if (realComments.length === 0) {
      return false;
    }

    const headerVideoId = chatData.video?.id ? String(chatData.video.id) : "";
    let integerOffsetCount = 0;

    for (const c of realComments) {
      // 1. VOD GQL comments & TwitchDownloaderCLI VOD comments explicitly set `emoticon: null` on text fragments,
      // whereas live IRC comments built via buildFragments() omit the `emoticon` key on plain-text fragments.
      const frags = c?.message?.fragments;
      if (Array.isArray(frags)) {
        for (const f of frags) {
          if (f && Object.prototype.hasOwnProperty.call(f, "emoticon") && f.emoticon === null) {
            return true;
          }
        }
      }

      // 2. Backfilled VOD comments merged into a live stream chat file carry the VOD's content_id,
      // which differs from the live broadcast's streamId stored in video.id.
      if (headerVideoId && c.content_id && String(c.content_id) !== headerVideoId) {
        return true;
      }

      // 3. Track whole-integer content_offset_seconds (before syncOffset or drift scaling is applied).
      if (typeof c.content_offset_seconds === "number" && Number.isInteger(c.content_offset_seconds)) {
        integerOffsetCount++;
      }
    }

    // If a majority of comments have exact integer second offsets, it is a VOD chat log.
    if (realComments.length >= 3 && integerOffsetCount / realComments.length > 0.5) {
      return true;
    }

    return false;
  }

  const cancelledRenderTaskIds = new Set<string>();

  interface RenderJob {
    taskId: string;
    channelLogin: string;
    folderPath: string;
    segments: { filename: string; width: number; height: number }[];
    resolve: () => void;
    reject: (err: any) => void;
  }

  const renderQueue: RenderJob[] = [];
  let isRenderRunning = false;

  export function abortChatProcess(taskId: string) {
    cancelledRenderTaskIds.add(taskId);
    if (state.activeTasks[taskId]) {
      state.activeTasks[taskId].cancelled = true;
    }

    const qIdx = renderQueue.findIndex(j => j.taskId === taskId);
    if (qIdx !== -1) {
      const [removedJob] = renderQueue.splice(qIdx, 1);
      addLog(`[Render Queue] Removed cancelled task ${taskId} from render queue.`);
      removeTask(taskId);
      removedJob.resolve();
      renderQueue.forEach((qJob, idx) => {
        const qTask = state.activeTasks[qJob.taskId];
        if (qTask && qTask.status === 'running') {
          updateTask(
            qJob.taskId,
            qTask.name || "Rendering Chat",
            `Queued (Position #${idx + 1} in line)...`,
            "running",
            false,
            [{ label: "Cancel", value: "cancel_render" }]
          );
        }
      });
      return;
    }

    const child = state.activeProcesses[taskId];
    if (child && typeof child.kill === 'function') {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (e) {}
        }, 1000);
      } catch (e) {}
      delete state.activeProcesses[taskId];
    }
    removeTask(taskId);
  }

  export function startChatRenderMultiple(
    channelLogin: string,
    folderPath: string,
    segments: { filename: string; width: number; height: number }[]
  ): Promise<void> {
    const taskId = `render_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const initialFileLabel = segments.length === 1 && segments[0].filename 
      ? segments[0].filename 
      : (segments.length > 1 ? `${segments.length} files` : channelLogin);

    return new Promise<void>((resolve, reject) => {
      const job: RenderJob = {
        taskId,
        channelLogin,
        folderPath,
        segments,
        resolve,
        reject
      };

      renderQueue.push(job);

      if (isRenderRunning) {
        const queuePos = renderQueue.length;
        addLog(`[Render Queue] Chat render queued for ${initialFileLabel} (Position #${queuePos} in queue).`);
        updateTask(
          taskId,
          `Rendering Chat (${initialFileLabel})`,
          `Queued (Position #${queuePos} in line)...`,
          "running",
          false,
          [{ label: "Cancel", value: "cancel_render" }]
        );
      } else {
        processNextRenderJob();
      }
    });
  }

  async function processNextRenderJob() {
    if (isRenderRunning || renderQueue.length === 0) return;

    const job = renderQueue.shift()!;
    isRenderRunning = true;

    if (cancelledRenderTaskIds.has(job.taskId) || state.activeTasks[job.taskId]?.cancelled) {
      addLog(`[Render Queue] Skipping cancelled chat render job ${job.taskId}.`);
      removeTask(job.taskId);
      job.resolve();
      isRenderRunning = false;
      processNextRenderJob();
      return;
    }

    try {
      await executeChatRenderMultiple(job.taskId, job.channelLogin, job.folderPath, job.segments);
      job.resolve();
    } catch (err: any) {
      addLog(`[Render Queue] Chat render job ${job.taskId} failed: ${err.message}`);
      job.reject(err);
    } finally {
      isRenderRunning = false;
      renderQueue.forEach((qJob, idx) => {
        const qTask = state.activeTasks[qJob.taskId];
        if (qTask && qTask.status === 'running') {
          updateTask(
            qJob.taskId,
            qTask.name || "Rendering Chat",
            `Queued (Position #${idx + 1} in line)...`,
            "running",
            false,
            [{ label: "Cancel", value: "cancel_render" }]
          );
        }
      });
      processNextRenderJob();
    }
  }

  async function executeChatRenderMultiple(
    taskId: string,
    channelLogin: string,
    folderPath: string,
    segments: { filename: string; width: number; height: number }[]
  ) {
    const initialFileLabel = segments.length === 1 && segments[0].filename ? segments[0].filename : (segments.length > 1 ? `${segments.length} files` : channelLogin);
    updateTask(taskId, `Rendering Chat (${initialFileLabel})`, "Initializing...", "running", false, [{ label: "Cancel", value: "cancel_render" }]);

    if (segments.length === 0) {
      addLog(`[Render] No segments provided for ${folderPath}`);
      updateTask(taskId, `Rendering Chat (${initialFileLabel})`, "Error: No segments", "error", true, [{ label: "Close", value: "dismiss" }]);
      return;
    }

    let files: string[] = [];
    try {
      const dirEntries = await fs.promises.readdir(folderPath, { withFileTypes: true });
      files = dirEntries.filter(e => e.isFile()).map(e => e.name);
    } catch (e) {}

    const isTaskCancelled = () => cancelledRenderTaskIds.has(taskId) || Boolean(state.activeTasks[taskId]?.cancelled);

    for (let i = 0; i < segments.length; i++) {
      if (isTaskCancelled()) break;
      
      const segment = segments[i];
      let chatFile = segment.filename;
      
      if (!chatFile) {
         chatFile = files.find(f => f.endsWith('.json') && !f.includes('_backup_') && (f.startsWith('chat_') || f.startsWith('vod_chat'))) || "";
      }
      
      if (!chatFile) {
        addLog(`[Render] No chat JSON found for segment ${i+1} in ${folderPath}`);
        continue;
      }

      const inputPath = path.join(folderPath, chatFile);
      // Ensure chat JSON is valid and repair any syntax errors before rendering
      await repairChatJsonFile(inputPath);

      const cr = (state.config.chatRender || {}) as any;
      let format = cr.format || "mp4";
      if ((cr.codec === "vp8" || cr.codec === "vp9") && format !== "webm" && format !== "mkv") {
        format = "webm";
      } else if (cr.codec === "prores" && format !== "mov" && format !== "mkv") {
        format = "mov";
      }
      const outputPath = path.join(folderPath, `rendered_${chatFile.replace('.json', '')}.${format}`);
      
      // Look for the corresponding video file to determine true media container duration
      const matchingBase = chatFile.replace('.json', '');
      const potentialVideoFiles = [
        path.join(folderPath, `${matchingBase}.mp4`),
        path.join(folderPath, `${matchingBase}.ts`)
      ];
      let probedVideoDuration = 0;
      for (const vFile of potentialVideoFiles) {
        if (fs.existsSync(vFile)) {
          probedVideoDuration = await getVideoDurationSeconds(vFile, state.config.tdPath);
          if (probedVideoDuration > 0) break;
        }
      }

      let renderInputPath = inputPath;
      let tempPath = "";

      // Determine stream codec / container type to select correct sync offset:
      // HEVC / 1440p (Enhanced Broadcasting / CMAF fMP4) vs Standard H.264 (1080p / MPEG-TS)
      const isVodChatTarget = /vod_chat|vod_backfill|vod_broadcast/i.test(chatFile);
      const manifestHevc = isSessionHevcOrFmp4FromManifest(folderPath, isVodChatTarget);
      let isHevcStream = manifestHevc === true;

      if (manifestHevc === null) {
        // Fallback heuristics for historical folders created prior to session_manifest.json
        const matchingSession = Object.values(state.activeDownloadSessions).find(
          (s: any) => s.folderPath && path.resolve(s.folderPath) === path.resolve(folderPath)
        );
        if (matchingSession?.isFmp4) {
          isHevcStream = true;
        }

        const taskObj = state.activeTasks[taskId];
        if (taskObj?.isFmp4) {
          isHevcStream = true;
        }

        const targetInitName = isVodChatTarget ? 'vod_init.mp4' : 'init.mp4';
        if (!isHevcStream && fs.existsSync(path.join(folderPath, targetInitName))) {
          try {
            const st = await fs.promises.stat(path.join(folderPath, targetInitName));
            if (st.size > 100) isHevcStream = true;
          } catch (_) {}
        }

        if (!isHevcStream) {
          try {
            const filesInDir = await fs.promises.readdir(folderPath);
            const firstSeg = filesInDir.find(f => (f.startsWith('seq_') || f.startsWith('vod_seq_')) && (f.endsWith('.ts') || f.endsWith('.mp4')));
            if (firstSeg) {
              const segBuf = Buffer.alloc(4096);
              const fd = await fs.promises.open(path.join(folderPath, firstSeg), 'r');
              try {
                const { bytesRead } = await fd.read(segBuf, 0, 4096, 0);
                if (bytesRead > 0) {
                  if (segBuf[0] !== 0x47) {
                    isHevcStream = true;
                  } else {
                    const raw = segBuf.slice(0, bytesRead).toString('binary');
                    if (raw.includes('moof') || raw.includes('styp') || raw.includes('ftyp')) {
                      isHevcStream = true;
                    }
                  }
                }
              } finally {
                await fd.close().catch(() => {});
              }
            }
          } catch (_) {}
        }

        if (!isHevcStream) {
          for (const vFile of potentialVideoFiles) {
            if (fs.existsSync(vFile)) {
              const isHevc = await checkVideoIsHevc(vFile, state.config.tdPath);
              if (isHevc) {
                isHevcStream = true;
                break;
              }
            }
          }
        }
      }

      // Select sync offset based on detected broadcast codec
      const defaultOffset = isHevcStream ? -7.5 : -2.5;
      const configuredOffset = isHevcStream
        ? (cr.syncOffsetHevc !== undefined ? cr.syncOffsetHevc : -7.5)
        : (cr.syncOffset !== undefined ? cr.syncOffset : -2.5);
      const syncOffset = typeof configuredOffset === 'number' ? configuredOffset : (parseFloat(configuredOffset) || defaultOffset);

      addLog(`[Render] Detected stream format for ${chatFile}: ${isHevcStream ? 'HEVC / 1440p (Enhanced)' : 'Standard H.264 (1080p)'}${manifestHevc !== null ? ' [manifest]' : ''}. Using sync offset: ${syncOffset}s.`);

      // Inspect raw input chat file before syncOffset / drift scaling to detect VOD chat messages for Smart Dispersion
      let containsVodChat = /vod_chat|vod_backfill|vod_broadcast/i.test(chatFile);
      let parsedInputChatData: any = null;
      try {
        const chatDataRaw = await fs.promises.readFile(inputPath, 'utf8');
        try {
          parsedInputChatData = JSON.parse(chatDataRaw);
        } catch (jsonErr) {
          await repairChatJsonFile(inputPath);
          const repairedRaw = await fs.promises.readFile(inputPath, 'utf8');
          parsedInputChatData = JSON.parse(repairedRaw);
        }
        if (parsedInputChatData) {
          containsVodChat = hasVodChatMessages(chatFile, parsedInputChatData);
        }
      } catch (e: any) {
        addLog(`[Render] Warning reading chat data for pre-inspection: ${e.message}`);
      }

      if (syncOffset !== 0) {
        try {
          const chatData = parsedInputChatData || JSON.parse(await fs.promises.readFile(inputPath, 'utf8'));

          if (chatData && chatData.comments && Array.isArray(chatData.comments)) {
            const filteredComments = [];
            for (const c of chatData.comments) {
              if (c.content_offset_seconds !== undefined) {
                c.content_offset_seconds += syncOffset;
              }
              if (c.content_offset_seconds === undefined || c.content_offset_seconds >= 0) {
                filteredComments.push(c);
              }
            }
            chatData.comments = filteredComments;
          }
          if (chatData && Array.isArray(chatData.events)) {
            const filteredEvents = [];
            for (const evt of chatData.events) {
              if (evt.content_offset_seconds !== undefined && !evt.carried_over) {
                evt.content_offset_seconds += syncOffset;
              }
              if (evt.content_offset_seconds === undefined || evt.content_offset_seconds >= 0) {
                filteredEvents.push(evt);
              }
            }
            chatData.events = filteredEvents;
          }
          tempPath = path.join(folderPath, `temp_render_${Date.now()}_${Math.random().toString(36).substring(7)}.json`);
          await fs.promises.writeFile(tempPath, JSON.stringify(chatData), 'utf8');
          renderInputPath = tempPath;
          addLog(`[Render] Applied ${isHevcStream ? 'HEVC (-7.5s default)' : 'H.264 (-2.5s default)'} syncOffset of ${syncOffset}s to chat data.`);
        } catch(e: any) {
          addLog(`[Render] Failed to apply sync offset: ${e.message}`);
        }
      }

      // Intelligent Clock Drift Compensation for Long Broadcasts (> 1 hour)
      const enableDriftCompensation = cr.autoCompensateClockDrift ?? true;
      if (enableDriftCompensation && probedVideoDuration > 3600) {
        try {
          const rawChat = await fs.promises.readFile(renderInputPath, 'utf8');
          const chatObj = safeParseChatData(rawChat, inputPath);
          if (chatObj && Array.isArray(chatObj.comments) && chatObj.comments.length > 0) {
            const maxCommentOffset = Math.max(...chatObj.comments.map((c: any) => c.content_offset_seconds || 0));
            const chatSpan = Math.max(chatObj.video?.length || 0, maxCommentOffset);
            const deltaSec = Math.abs(chatSpan - probedVideoDuration);
            const ppm = (deltaSec / chatSpan) * 1e6;

            // Intelligent guard: Only apply linear scaling if duration is > 1 hour,
            // drift is within realistic clock/frame rate tolerance (20 to 1000 PPM, e.g. 1s to 120s over 10h),
            // and not an accidental massive gap or cut.
            if (chatSpan > 3600 && ppm >= 20 && ppm <= 1000 && deltaSec >= 1.0 && deltaSec <= 120) {
              const driftScale = probedVideoDuration / chatSpan;
              for (const c of chatObj.comments) {
                if (c.content_offset_seconds !== undefined && c.content_offset_seconds > 0) {
                  c.content_offset_seconds = parseFloat((c.content_offset_seconds * driftScale).toFixed(3));
                }
              }
              if (Array.isArray(chatObj.events)) {
                for (const evt of chatObj.events) {
                  if (evt.content_offset_seconds !== undefined && evt.content_offset_seconds > 0) {
                    evt.content_offset_seconds = parseFloat((evt.content_offset_seconds * driftScale).toFixed(3));
                  }
                }
              }
              if (chatObj.video) {
                chatObj.video.end = probedVideoDuration;
                chatObj.video.length = probedVideoDuration;
              }
              if (!tempPath) {
                tempPath = path.join(folderPath, `temp_render_${Date.now()}_${Math.random().toString(36).substring(7)}.json`);
              }
              await fs.promises.writeFile(tempPath, JSON.stringify(chatObj), 'utf8');
              renderInputPath = tempPath;
              addLog(`[Render Drift] Applied ${ppm.toFixed(0)} PPM clock drift compensation (factor: ${driftScale.toFixed(6)}) across ${chatSpan.toFixed(1)}s chat to match ${probedVideoDuration.toFixed(1)}s video.`);
            }
          }
        } catch (driftErr: any) {
          addLog(`[Render Drift Warning] Could not apply drift compensation: ${driftErr.message}`);
        }
      }

      updateTask(taskId, `Rendering Chat (${channelLogin})`, `Rendering segment ${i+1}/${segments.length}... (${chatFile})`, "running", true, [{ label: "Cancel", value: "cancel_render" }]);

      // Pre-flight check & sanitize the JSON file that ChatRenderCLI / TwitchDownloaderCLI will actually read
      await sanitizeChatJsonForRendering(renderInputPath);

      const rawWidth = Math.max(100, Math.min(7680, parseInt(String(segment.width), 10) || 350));
      const rawHeight = Math.max(100, Math.min(7680, parseInt(String(segment.height), 10) || 800));
      // Ensure even pixel dimensions required by yuv420p / yuva420p planar pipelines
      const segWidth = rawWidth % 2 === 0 ? rawWidth : rawWidth + 1;
      const segHeight = rawHeight % 2 === 0 ? rawHeight : rawHeight + 1;

      const messageColor = cr.messageColor || "#ffffff";
      const baseArgs = [
        "chatrender",
        "-i", renderInputPath,
        "-o", outputPath,
        "--chat-width", segWidth.toString(),
        "--chat-height", segHeight.toString(),
        "--background-color", cr.backgroundColor || "#111111",
        "--message-color", messageColor,
        "--font", cr.font || "Inter",
        "--font-size", (cr.fontSize || 24).toString(),
        "--framerate", (cr.framerate || 60).toString(),
        "--collision", "Overwrite"
      ];

      if (probedVideoDuration > 0) {
        baseArgs.push("-e", `${probedVideoDuration.toFixed(2)}s`);
        addLog(`[Render] Bound chat render ending to probed container duration: ${probedVideoDuration.toFixed(2)}s.`);
      }

      if (cr.updateRate) baseArgs.push("--update-rate", cr.updateRate.toString());
      if (cr.alternateBackgrounds) {
        baseArgs.push("--alternate-backgrounds");
        if (cr.altBackgroundColor) { baseArgs.push("--alt-background-color", cr.altBackgroundColor); }
      }
      const highlightUserMap = new Map<string, string>();
      const addHighlightUser = (u: string | undefined | null) => {
        if (!u) return;
        const cleaned = String(u).trim().replace(/^@/, "");
        if (!cleaned || cleaned.toLowerCase() === "manual" || cleaned.toLowerCase() === "streamer") return;
        const lower = cleaned.toLowerCase();
        if (!highlightUserMap.has(lower)) {
          highlightUserMap.set(lower, cleaned);
        }
      };
      addHighlightUser(parsedInputChatData?.streamer?.name);
      addHighlightUser(channelLogin);
      if (Array.isArray(state.config.channels)) {
        for (const ch of state.config.channels) {
          addHighlightUser(ch);
        }
      }
      if (cr.highlightUsers && String(cr.highlightUsers).trim()) {
        for (const u of String(cr.highlightUsers).split(",")) {
          addHighlightUser(u);
        }
      }
      if (highlightUserMap.size > 0) {
        baseArgs.push("--highlight-users", Array.from(highlightUserMap.values()).join(","));
        if (cr.highlightUserColor) {
          baseArgs.push("--highlight-user-color", cr.highlightUserColor);
        }
      }
      if (cr.messageFontStyle && cr.messageFontStyle !== "normal") baseArgs.push("--message-fontstyle", cr.messageFontStyle);
      if (cr.usernameFontStyle && cr.usernameFontStyle !== "bold") baseArgs.push("--username-fontstyle", cr.usernameFontStyle);
      if (cr.scaleUsername !== undefined && cr.scaleUsername !== 1.0) baseArgs.push("--scale-username", cr.scaleUsername.toString());
      if (cr.outline) {
        baseArgs.push("--outline", "--outline-size", (cr.outlineSize || 4).toString());
      }
      if (cr.generateMask) baseArgs.push("--generate-mask");
      if (cr.bttv === false) baseArgs.push("--bttv=false");
      if (cr.ffz === false) baseArgs.push("--ffz=false");
      if (cr.stv === false) baseArgs.push("--stv=false");
      if (cr.allowUnlistedEmotes === false) baseArgs.push("--allow-unlisted-emotes=false");
      if (cr.badges === false) baseArgs.push("--badges=false");
      if (cr.subMessages === false) baseArgs.push("--sub-messages=false");
      const rawDispersion = cr.dispersion;
      const dispersionMode: 'on' | 'off' | 'smart' =
        rawDispersion === true || rawDispersion === 'on'
          ? 'on'
          : rawDispersion === 'smart'
          ? 'smart'
          : 'off';
      const shouldUseDispersion =
        dispersionMode === 'on' || (dispersionMode === 'smart' && containsVodChat);
      if (dispersionMode === 'smart') {
        addLog(`[Render] Smart Dispersion: ${shouldUseDispersion ? 'ENABLED (detected VOD chat messages)' : 'DISABLED (pure live sub-second chat)'} for ${chatFile}.`);
      }
      if (shouldUseDispersion) baseArgs.push("--dispersion");
      if (cr.offline) baseArgs.push("--offline");
      if (cr.avatars) baseArgs.push("--avatars");
      if (cr.readableColors === false) baseArgs.push("--readable-colors=false");
      if (cr.sharpening) baseArgs.push("--sharpening");
      if (cr.emojiVendor && cr.emojiVendor !== "notocolor") baseArgs.push("--emoji-vendor", cr.emojiVendor);
      
      if (cr.scaleEmote !== undefined && cr.scaleEmote !== 1.0) baseArgs.push("--scale-emote", cr.scaleEmote.toString());
      if (cr.scaleBadge !== undefined && cr.scaleBadge !== 1.0) baseArgs.push("--scale-badge", cr.scaleBadge.toString());
      if (cr.scaleEmoji !== undefined && cr.scaleEmoji !== 1.0) baseArgs.push("--scale-emoji", cr.scaleEmoji.toString());
      if (cr.scaleAvatar !== undefined && cr.scaleAvatar !== 1.0) baseArgs.push("--scale-avatar", cr.scaleAvatar.toString());
      if (cr.scaleVertical !== undefined) baseArgs.push("--scale-vertical", cr.scaleVertical.toString());
      else baseArgs.push("--scale-vertical", "0.5");
      if (cr.scaleSidePadding !== undefined && cr.scaleSidePadding !== 1.0) baseArgs.push("--scale-side-padding", cr.scaleSidePadding.toString());
      if (cr.scaleSectionHeight !== undefined && cr.scaleSectionHeight !== 1.0) baseArgs.push("--scale-section-height", cr.scaleSectionHeight.toString());
      if (cr.scaleWordSpace !== undefined && cr.scaleWordSpace !== 1.0) baseArgs.push("--scale-word-space", cr.scaleWordSpace.toString());
      if (cr.scaleEmoteSpace !== undefined && cr.scaleEmoteSpace !== 1.0) baseArgs.push("--scale-emote-space", cr.scaleEmoteSpace.toString());
      if (cr.scaleHighlightStroke !== undefined && cr.scaleHighlightStroke !== 1.0) baseArgs.push("--scale-highlight-stroke", cr.scaleHighlightStroke.toString());
      if (cr.scaleHighlightIndent !== undefined && cr.scaleHighlightIndent !== 1.0) baseArgs.push("--scale-highlight-indent", cr.scaleHighlightIndent.toString());

      if (cr.ignoreUsers) baseArgs.push("--ignore-users", cr.ignoreUsers);
      if (cr.bannedWords) baseArgs.push("--ban-words", cr.bannedWords);
      if (cr.badgeFilter !== undefined && cr.badgeFilter !== 0) baseArgs.push("--badge-filter", cr.badgeFilter.toString());

      if (cr.codec) {
        let outputArgs = "";
        switch (cr.codec) {
          case "hevc": outputArgs = `-c:v libx265 -preset:v veryfast -crf 18 -pix_fmt yuv420p "{save_path}"`; break;
          case "vp8": outputArgs = `-c:v libvpx -pix_fmt yuva420p -auto-alt-ref 0 -crf 18 -b:v 0 -deadline realtime -quality realtime -cpu-used 4 -threads 0 "{save_path}"`; break;
          case "vp9": outputArgs = `-c:v libvpx-vp9 -crf 18 -b:v 0 -pix_fmt yuva420p "{save_path}"`; break;
          case "prores": outputArgs = `-c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le "{save_path}"`; break;
          default: outputArgs = `-c:v libx264 -preset:v veryfast -crf 18 -pix_fmt yuv420p "{save_path}"`; break;
        }
        baseArgs.push(`--output-args=${outputArgs}`);
      }

      baseArgs.push("--skip-drive-waiting");

      const tdPath = resolveTdPath(state.config.tdPath);
      const tdDir = path.dirname(tdPath);
      
      const actualFfmpegPath = await ensureFfmpeg(tdPath, (msg) => {
        updateTask(taskId, `Rendering Chat (${chatFile})`, msg, "running", false, [{ label: "Cancel", value: "cancel_render" }]);
      });
      
      baseArgs.push("--ffmpeg-path", actualFfmpegPath);

      // ChatRenderCLI extended options (v2.0-extended overlays, parallel jobs, Giphy, moderation & enriched chat flags)
      const extendedArgs: string[] = [];
      const jobsCount = cr.jobs !== undefined ? parseInt(String(cr.jobs), 10) : 0;
      if (Number.isFinite(jobsCount) && jobsCount >= 0) {
        extendedArgs.push("-j", jobsCount.toString());
      }
      const cacheMb = cr.imageCacheMb !== undefined ? parseInt(String(cr.imageCacheMb), 10) : 256;
      if (Number.isFinite(cacheMb) && cacheMb > 0 && cacheMb !== 256) {
        extendedArgs.push("--image-cache-mb", cacheMb.toString());
      }
      extendedArgs.push(cr.giphy === false ? "--giphy=false" : "--giphy=true");
      const gifMaxPct = cr.gifMaxHeightPercent !== undefined ? parseInt(String(cr.gifMaxHeightPercent), 10) : 33;
      if (Number.isFinite(gifMaxPct) && gifMaxPct >= 5 && gifMaxPct <= 100 && gifMaxPct !== 33) {
        extendedArgs.push("--gif-max-height-percent", gifMaxPct.toString());
      }

      // Overlay Widget Modes
      extendedArgs.push("--prediction-mode", cr.predictionMode || "StickyTop");
      extendedArgs.push("--poll-mode", cr.pollMode || "StickyTop");
      extendedArgs.push("--pinned-chat-mode", cr.pinnedChatMode || "StickyTop");
      extendedArgs.push("--hype-train-mode", cr.hypeTrainMode || "ChatScroll");

      // Moderation & Roomstate
      extendedArgs.push("--moderation-mode", cr.moderationMode || "Strikethrough");
      if (cr.moderationNotices === false) extendedArgs.push("--moderation-notices=false");
      if (cr.clearAll === true) extendedArgs.push("--clear-all");
      if (cr.roomstateNotices === false) extendedArgs.push("--roomstate-notices=false");

      // Enriched Message Features
      if (cr.replies === false) extendedArgs.push("--replies=false");
      if (cr.firstChatter === false) extendedArgs.push("--first-chatter=false");
      if (cr.announcements === false) extendedArgs.push("--announcements=false");
      if (cr.raids === false) extendedArgs.push("--raids=false");
      if (cr.channelPoints === false) extendedArgs.push("--channel-points=false");
      if (cr.hypeChat === false) extendedArgs.push("--hype-chat=false");
      if (cr.powerUps === false) extendedArgs.push("--power-ups=false");
      if (cr.sharedChatBadge === false) extendedArgs.push("--shared-chat-badge=false");
      
      let success = false;
      let renderAttempt = 1;
      let stripExtendedFlags = false;

      while (renderAttempt <= 3 && !success && !isTaskCancelled()) {
        let currentArgs = stripExtendedFlags ? [...baseArgs] : [...baseArgs, ...extendedArgs];
        addLog(`[Render] Starting ${path.basename(tdPath)} for ${chatFile} (Attempt ${renderAttempt}/3)...`);
        addLog(`[Render CLI Command] ${tdPath} ${currentArgs.join(" ")}`);

        success = await new Promise((resolveRender) => {
          if (isTaskCancelled()) {
            resolveRender(false);
            return;
          }
          try {
             fs.writeFileSync(outputPath, ""); // Create placeholder to prevent duplicate renders
          } catch(e) {}
          
          const child = spawn(tdPath, currentArgs, { cwd: tdDir });
          state.activeProcesses[taskId] = child;
          let fullRenderOutput = "";
          let killedForRetry = false;

          // 45-minute execution timeout per render attempt
          const RENDER_TIMEOUT_MS = 45 * 60 * 1000;
          let isTimedOut = false;
          let forceKillTimer: NodeJS.Timeout | null = null;
          const timeoutTimer = setTimeout(() => {
            isTimedOut = true;
            addLog(`[Render Timeout] Chat renderer exceeded 45m timeout on ${chatFile} (attempt ${renderAttempt}). Terminating child process...`);
            delete state.activeProcesses[taskId];
            try {
              child.kill('SIGTERM');
            } catch (e) {}
            forceKillTimer = setTimeout(() => {
              try {
                child.kill('SIGKILL');
              } catch (e) {}
            }, 3000);
            resolveRender(false);
          }, RENDER_TIMEOUT_MS);

          child.stdout?.on('data', (data: any) => {
            if (isTaskCancelled() || isTimedOut) return;
            const output = data.toString();
            fullRenderOutput += output;
            if (fullRenderOutput.length > 500000) {
              fullRenderOutput = fullRenderOutput.slice(-500000);
            }
            
            const lines = output.split(/\r?\n/);
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              const statusMatch = trimmed.match(/\[STATUS\] - (.*)/);
              if (statusMatch) {
                updateTask(taskId, `Rendering Chat (${chatFile})`, `[${i+1}/${segments.length}] A${renderAttempt}: ${statusMatch[1]}`, "running", false, [{ label: "Cancel", value: "cancel_render" }]);
              } else {
                const lower = trimmed.toLowerCase();
                const isDiagnosticOrError = trimmed.includes('[ERROR]') ||
                  trimmed.includes('[WARNING]') ||
                  trimmed.includes('[FATAL]') ||
                  trimmed.includes('[DEBUG]') ||
                  lower.includes('error') ||
                  lower.includes('warn') ||
                  lower.includes('exception') ||
                  lower.includes('traceback') ||
                  lower.includes('fatal') ||
                  lower.includes('fail') ||
                  lower.includes('panic') ||
                  lower.includes('unhandled');

                if (isDiagnosticOrError) {
                  // Forward error, warning, and diagnostic messages to system log immediately
                  addLog(`[Render] ${trimmed}`);
                  
                  if (lower.includes('emote') && renderAttempt < 3 && !killedForRetry && !isTaskCancelled()) {
                    addLog(`[Render] Aborting attempt ${renderAttempt} due to emote fetch failure.`);
                    killedForRetry = true;
                    child.kill();
                  }
                }
              }
            }
          });

          child.stderr?.on('data', (data: any) => {
            if (isTaskCancelled() || isTimedOut) return;
            const msg = data.toString();
            fullRenderOutput += msg;
            if (fullRenderOutput.length > 500000) {
              fullRenderOutput = fullRenderOutput.slice(-500000);
            }
            
            const lines = msg.split(/\r?\n/);
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed) {
                addLog(`[Render Stderr] ${trimmed}`);
              }
            }
          });

          child.on('error', (err: any) => {
            clearTimeout(timeoutTimer);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            delete state.activeProcesses[taskId];
            if (isTimedOut) return;
            if (isTaskCancelled()) {
              resolveRender(false);
              return;
            }
            addLog(`[Render Error] Failed to start rendering process: ${err?.stack || err?.message || err}`);
            resolveRender(false);
          });

          child.on('close', (code: number | null) => {
            clearTimeout(timeoutTimer);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            delete state.activeProcesses[taskId];
            if (isTimedOut) return;
            if (isTaskCancelled()) {
              resolveRender(false);
              return;
            }
            if (killedForRetry) {
              resolveRender(false);
              return;
            }
            if (code !== 0) {
              addLog(`[Render] Chat rendering command failed with exit code ${code} for ${chatFile}.`);
              const completeOutput = fullRenderOutput.trim();
              if (completeOutput) {
                addLog(`[Render Complete Output]\n${completeOutput}`);
                const lowerOut = completeOutput.toLowerCase();
                if (!stripExtendedFlags && (lowerOut.includes('unrecognized') || lowerOut.includes('unknown option') || lowerOut.includes('is unknown'))) {
                  stripExtendedFlags = true;
                  addLog(`[Render] Detected legacy TwitchDownloaderCLI without ChatRenderCLI flags. Retrying with standard compatibility flags...`);
                }
              }
              if (renderAttempt >= 3) {
                updateTask(taskId, `Render Failed (${chatFile})`, `Exited with code ${code}`, "error", true, [{ label: "Close", value: "dismiss" }]);
              }
              resolveRender(false);
            } else {
              resolveRender(true);
            }
          });
        });

        if (isTaskCancelled()) {
          try {
            if (fs.existsSync(outputPath)) {
              const stats = fs.statSync(outputPath);
              if (stats.size === 0) fs.unlinkSync(outputPath);
            }
          } catch (e) {}
          break;
        }

        if (!success && !isTaskCancelled()) {
          if (renderAttempt < 3) {
            renderAttempt++;
            addLog(`[Render] Preparing for retry ${renderAttempt}...`);
          } else {
            break;
          }
        }
      }

      if (tempPath && fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (e) {}
      }

      if (isTaskCancelled()) {
        addLog(`[Render] Chat render cancelled by user: ${chatFile}.`);
        break;
      }

      if (!success) {
        return; // Stop processing further segments if one fails
      }
    }

    if (isTaskCancelled()) {
      cancelledRenderTaskIds.delete(taskId);
      return;
    }

    if (state.activeTasks[taskId] && !state.activeTasks[taskId].cancelled) {
      const remainingRenders = Object.values(state.activeTasks).filter(t => t.id !== taskId && t.id.startsWith('render_') && t.status === 'running');
      const otherJobsMsg = remainingRenders.length > 0 ? ` (${remainingRenders.length} other render task${remainingRenders.length === 1 ? '' : 's'} remaining)` : '';

      if (segments.length === 1) {
        addLog(`[Render] Chat render complete: ${segments[0].filename}.${otherJobsMsg}`);
      } else {
        addLog(`[Render] Chat renders complete for ${segments.length} files (${channelLogin}): ${segments.map(s => s.filename).join(', ')}.${otherJobsMsg}`);
      }

      const completedLabel = segments.length === 1 ? segments[0].filename : `${segments.length} files`;
      updateTask(taskId, `Chat Rendered (${completedLabel})`, `Saved to ${folderPath}`, "success", false, [
        { label: "Open Folder", value: "open_folder" },
        { label: "Close", value: "dismiss" }
      ]);
      state.activeTasks[taskId].folderPath = folderPath;
    }
    cancelledRenderTaskIds.delete(taskId);
  }

  export async function startManualChatRender(filePath: string, customWidth?: number, customHeight?: number) {
    const filename = path.basename(filePath);
    const folderPath = path.dirname(filePath);
    let channelLogin = "manual";
    
    // Attempt to extract channel name from JSON or filename
    try {
      if (fs.existsSync(filePath)) {
        const raw = await fs.promises.readFile(filePath, "utf8");
        const streamerMatch = raw.match(/"name":\s*"([^"]+)"/);
        if (streamerMatch && streamerMatch[1]) {
          channelLogin = streamerMatch[1];
        }
      }
    } catch (e) {}

    const resolvedProfile = getChatRenderDimensionsForChatFile(filePath);
    const width = customWidth || resolvedProfile.width;
    const height = customHeight || resolvedProfile.height;

    addLog(`[Manual Render] Initiating manual render for ${filePath} (${width}x${height}${resolvedProfile.isCustomProfile ? ` via profile "${resolvedProfile.matchedProfile}"` : ''})...`);
    return startChatRenderMultiple(channelLogin, folderPath, [{ filename, width, height }]);
  }

export function flushPendingChatWrites(session: any) {
  if (!session) return;
  if (session.chatFlushTimer) {
    clearTimeout(session.chatFlushTimer);
    session.chatFlushTimer = null;
  }
  if (!session.pendingChatWrites || session.pendingChatWrites.length === 0 || !session.chatStream) {
    return;
  }

  const batch = session.pendingChatWrites;
  session.pendingChatWrites = [];

  if (!session.usedFirstPartyEmotes) {
    session.usedFirstPartyEmotes = new Map<string, string>();
  }
  if (!session.usedTwitchBadges) {
    session.usedTwitchBadges = new Map<string, Set<string>>();
  }
  extractUsedEmotesAndBadgesFromComments(batch, undefined, session.usedFirstPartyEmotes, session.usedTwitchBadges);

  let ndjsonBatch = "";
  for (let i = 0; i < batch.length; i++) {
    ndjsonBatch += JSON.stringify(batch[i]) + "\n";
    session.commentsWritten = (session.commentsWritten || 0) + 1;
  }

  try {
    session.chatStream.write(ndjsonBatch);
    emitSessionsDelta();
  } catch (err: any) {
    console.error("[Chat] Error writing batched NDJSON comments:", err);
  }
}

export async function startLiveChatDownload(channelLogin: string, folderPath: string, streamId: string, twitchId: string, startTime: string) {
    const activeSession = state.activeDownloadSessions[channelLogin];
    if (activeSession && !activeSession.isStopped) {
      if (activeSession.chatWs && (activeSession.chatWs.readyState === WebSocket.OPEN || activeSession.chatWs.readyState === WebSocket.CONNECTING) && activeSession.chatStream) {
        return;
      }
    }

    addLog(`[Chat] Starting live chat recording for ${channelLogin} (append-only journal + Hermes overlays)...`);
    const dateStr = startTime.split('T')[0];
    const chatFilePath = path.join(folderPath, `chat_${dateStr}.json`);
    const commentsJournalPath = getCommentsJournalPath(chatFilePath);

    let isRecovery = false;
    let recoveredOffset = 0;
    let recoveredCommentsWritten = 0;
    const existingIds = new Set<string>();

    // 1. Recover from append-only `.comments.jsonl` journal if present
    if (fs.existsSync(commentsJournalPath)) {
      try {
        const journalRes = await readCommentsFromJournal(commentsJournalPath);
        for (const id of journalRes.seenIds) {
          existingIds.add(id);
        }
        recoveredOffset = journalRes.maxOffsetSec;
        recoveredCommentsWritten = journalRes.comments.length;
        if (recoveredCommentsWritten > 0) {
          isRecovery = true;
          addLog(`[Chat Recovery] Resuming append-only chat journal from offset ${recoveredOffset.toFixed(1)}s (${recoveredCommentsWritten} messages).`);
        }
      } catch (e: any) {
        addLog(`[Chat Recovery] Note reading .comments.jsonl journal: ${e.message}`);
      }
    }

    // 2. Seamless migration if resuming a pre-5.3.0 session that still has an open/legacy `chat_YYYY-MM-DD.json`
    if (fs.existsSync(chatFilePath)) {
      try {
        const legacyContent = await fs.promises.readFile(chatFilePath, 'utf8');
        const legacyParsed = safeParseChatData(legacyContent, chatFilePath);
        if (legacyParsed && Array.isArray(legacyParsed.comments) && legacyParsed.comments.length > 0) {
          let migratedLines = "";
          let migratedCount = 0;
          for (const c of legacyParsed.comments) {
            if (c && c._id && c._id !== "dummy-end-message" && !existingIds.has(c._id)) {
              existingIds.add(c._id);
              migratedLines += JSON.stringify(c) + "\n";
              migratedCount++;
              recoveredCommentsWritten++;
              const off = Number(c.content_offset_seconds) || 0;
              if (off > recoveredOffset) recoveredOffset = off;
            }
          }
          if (migratedLines) {
            await fs.promises.appendFile(commentsJournalPath, migratedLines, 'utf8');
          }
          isRecovery = true;
          // Remove unclosed legacy JSON now that all comments are safely persisted in `.comments.jsonl`
          await fs.promises.unlink(chatFilePath).catch(() => {});
          addLog(`[Chat Recovery] Migrated ${migratedCount} legacy chat messages into append-only journal (resume offset: ${recoveredOffset.toFixed(1)}s).`);
        }
      } catch (e: any) {
        addLog(`[Chat Recovery] Note inspecting legacy chat file: ${e.message}`);
      }
    }

    const chatStream = fs.createWriteStream(commentsJournalPath, { flags: 'a' });
    const eventsFilePath = getEventsSidecarPath(chatFilePath);
    const eventExistingIds = new Set<string>();
    let recoveredEventsCount = 0;
    if (fs.existsSync(eventsFilePath)) {
      try {
        const existingEvtLines = fs.readFileSync(eventsFilePath, 'utf8').split(/\r?\n/);
        for (const line of existingEvtLines) {
          if (!line.trim()) continue;
          try {
            const parsedEvt = JSON.parse(line);
            if (parsedEvt && parsedEvt._id && !eventExistingIds.has(parsedEvt._id)) {
              eventExistingIds.add(parsedEvt._id);
              recoveredEventsCount++;
            }
          } catch (_) {}
        }
      } catch (_) {}
    }

    if (state.activeDownloadSessions[channelLogin]) {
      state.activeDownloadSessions[channelLogin].chatStream = chatStream;
      state.activeDownloadSessions[channelLogin].chatFilePath = chatFilePath;
      state.activeDownloadSessions[channelLogin].commentsJournalPath = commentsJournalPath;
      state.activeDownloadSessions[channelLogin].eventsFilePath = eventsFilePath;
      state.activeDownloadSessions[channelLogin].eventExistingIds = eventExistingIds;
      state.activeDownloadSessions[channelLogin].commentsWritten = isRecovery ? recoveredCommentsWritten : 0;
      state.activeDownloadSessions[channelLogin].eventsWritten = recoveredEventsCount;
    }

    let thirdPartyEmotes: any[] = [];
    try {
      thirdPartyEmotes = await fetchThirdPartyEmotes(twitchId);
    } catch (e) {
      addLog(`[Chat] Non-fatal error fetching some 3rd party emotes.`);
    }

    const headerObj = normalizeTwitchDownloaderSchema(
      {},
      {
        channelLogin,
        streamerId: twitchId,
        streamId,
        title: state.activeDownloadSessions[channelLogin]?.currentTitle || "",
        createdAt: startTime,
        gameName: state.activeDownloadSessions[channelLogin]?.currentGame || "",
        durationSec: 0,
        thirdPartyEmotes,
      }
    );

    if (state.activeDownloadSessions[channelLogin]) {
      state.activeDownloadSessions[channelLogin].thirdPartyEmotes = thirdPartyEmotes;
      state.activeDownloadSessions[channelLogin].twitchId = twitchId;
    }

    await writeChatSessionHeader(chatFilePath, headerObj).catch(() => {});

    const startTimestamp = new Date(startTime).getTime();
    const session = state.activeDownloadSessions[channelLogin];
    const currentVideoStartMs = session?.streamCreatedAtMs || session?.videoStartTimeMs || startTimestamp;
    const currentLiveOffset = Math.max(0, (Date.now() - currentVideoStartMs) / 1000.0);

    const shouldAutoBackfill = isRecovery && ((currentLiveOffset - recoveredOffset) > 15);
    const awaitsUserChoice = !isRecovery && (currentLiveOffset > 120);
    let isBackfilling = shouldAutoBackfill;
    let liveBuffer: any[] = [];

    if (session) {
      session.isAwaitingBackfillChoice = awaitsUserChoice;
      session.liveChatBuffer = liveBuffer;
      session.chatExistingIds = existingIds;
    }

    const appendJournalBatch = (commentsToWrite: any[]): number => {
      let count = 0;
      let ndjson = "";
      const s = state.activeDownloadSessions[channelLogin];
      for (const comment of commentsToWrite) {
        if (!comment || !comment._id || existingIds.has(comment._id)) continue;
        ndjson += JSON.stringify(comment) + "\n";
        existingIds.add(comment._id);
        if (s) s.commentsWritten = (s.commentsWritten || 0) + 1;
        count++;
      }
      if (ndjson) {
        chatStream.write(ndjson);
      }
      return count;
    };

    if (awaitsUserChoice) {
      addLog(`[Chat] Stream was already live (${Math.round(currentLiveOffset / 60)}m). Buffering live chat awaiting user backfill selection...`);
    } else if (shouldAutoBackfill) {
      addLog(`[Chat] Recovering missing gap (${recoveredOffset.toFixed(1)}s -> ${currentLiveOffset.toFixed(1)}s) chat backfill...`);
      const autoBackfillPromise = downloadVodChat(
        channelLogin,
        folderPath,
        true,
        chatFilePath,
        recoveredOffset,
        isRecovery,
        recoveredCommentsWritten,
        currentLiveOffset + 15,
        existingIds
      ).then((result) => {
        if (!result || !result.backfillComments || result.backfillComments.length === 0) {
          addLog(`[Chat] No missing gap messages returned from VOD chat or VOD not yet published.`);
        } else {
          const gapCount = appendJournalBatch(result.backfillComments);
          addLog(`[Chat] Backfill appended ${gapCount} missing gap messages.`);
        }

        const liveCount = appendJournalBatch(liveBuffer);
        addLog(`[Chat] Merged ${liveCount} buffered live messages. Seamless chat resume active.`);
        isBackfilling = false;
        liveBuffer = [];
      }).catch(err => {
        addLog(`[Chat] Backfill error: ${err.message}. Resuming normal live chat.`);
        appendJournalBatch(liveBuffer);
        isBackfilling = false;
        liveBuffer = [];
      }).finally(() => {
        if (state.activeDownloadSessions[channelLogin]?.activeChatBackfillPromise === autoBackfillPromise) {
          state.activeDownloadSessions[channelLogin].activeChatBackfillPromise = null;
        }
      });

      if (session) {
        session.activeChatBackfillPromise = autoBackfillPromise;
      }
    }

    const enqueueComment = (tdComment: any) => {
      const curSessionForTrack = state.activeDownloadSessions[channelLogin];
      if (curSessionForTrack) {
        if (!curSessionForTrack.usedFirstPartyEmotes) {
          curSessionForTrack.usedFirstPartyEmotes = new Map<string, string>();
        }
        if (!curSessionForTrack.usedTwitchBadges) {
          curSessionForTrack.usedTwitchBadges = new Map<string, Set<string>>();
        }
        extractUsedEmotesAndBadgesFromComments(
          [tdComment],
          undefined,
          curSessionForTrack.usedFirstPartyEmotes,
          curSessionForTrack.usedTwitchBadges
        );
      }

      if (isBackfilling || state.activeDownloadSessions[channelLogin]?.isAwaitingBackfillChoice) {
        liveBuffer.push(tdComment);
      } else if (state.activeDownloadSessions[channelLogin]) {
        const curSession = state.activeDownloadSessions[channelLogin];
        if (existingIds.has(tdComment._id)) {
          return;
        }
        existingIds.add(tdComment._id);

        if (!curSession.pendingChatWrites) {
          curSession.pendingChatWrites = [];
        }
        curSession.pendingChatWrites.push(tdComment);

        if (curSession.pendingChatWrites.length >= 25) {
          flushPendingChatWrites(curSession);
        } else if (!curSession.chatFlushTimer) {
          curSession.chatFlushTimer = setTimeout(() => {
            curSession.chatFlushTimer = null;
            flushPendingChatWrites(curSession);
          }, 1500);
        }
      }
    };

    const computeOffsetSec = (eventTsMs: number): number => {
      const curSession = state.activeDownloadSessions[channelLogin];
      const startMs = (curSession && curSession.videoStartTimeMs) ? curSession.videoStartTimeMs : startTimestamp;
      return Math.max(0, parseFloat(((eventTsMs - startMs) / 1000.0).toFixed(3)));
    };

      const gifterSenderCountCache = new Map<string, number>();
      const rewardMetadataCache = new Map<string, { title: string; cost: number; prompt: string; background_color: string }>();
      const lastRoomState: {
        emote_only?: boolean;
        subs_only?: boolean;
        slow_seconds?: number;
        followers_only_minutes?: number;
        r9k?: boolean;
      } = {};

    function connectWebSocket() {
      const activeSession = state.activeDownloadSessions[channelLogin];
      if (!activeSession || activeSession.isStopped) {
        return;
      }

      let lastActivityMs = Date.now();
      let heartbeatInterval: NodeJS.Timeout | null = null;

      const clearHeartbeat = () => {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }
        if (activeSession.chatHeartbeatInterval) {
          clearInterval(activeSession.chatHeartbeatInterval);
          activeSession.chatHeartbeatInterval = null;
        }
      };

      const recordActivity = () => {
        lastActivityMs = Date.now();
      };

      const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
      activeSession.chatWs = ws;

      const handleOpen = () => {
        if (!state.activeDownloadSessions[channelLogin] || state.activeDownloadSessions[channelLogin].isStopped) {
          clearHeartbeat();
          try { ws.terminate(); } catch (e) { ws.close(); }
          return;
        }
        recordActivity();
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        ws.send('PASS SCHMOOPIIE');
        ws.send('NICK justinfan' + Math.floor(Math.random() * 100000));
        ws.send(`JOIN #${channelLogin}`);
        state.activeDownloadSessions[channelLogin].ircConnected = true;
        emitSessionsDelta(true);
        addLog(`[Chat] Connected to live IRCv3 chat for ${channelLogin} (capturing PRIVMSG, USERNOTICE, CLEARCHAT, CLEARMSG, ROOMSTATE).`);

        clearHeartbeat();
        heartbeatInterval = setInterval(() => {
          const curSession = state.activeDownloadSessions[channelLogin];
          if (!curSession || curSession.isStopped || ws.readyState !== WebSocket.OPEN) {
            clearHeartbeat();
            return;
          }

          const idleMs = Date.now() - lastActivityMs;
          if (idleMs > 90_000) {
            addLog(`[Chat] WebSocket silence for ${(idleMs / 1000).toFixed(0)}s on @${channelLogin} (half-open socket detected). Terminating connection to force reconnect...`);
            clearHeartbeat();
            try {
              ws.terminate();
            } catch (e) {
              try { ws.close(); } catch (err) {}
            }
          } else if (idleMs > 60_000) {
            try {
              ws.send('PING :tmi.twitch.tv');
            } catch (err: any) {
              addLog(`[Chat] Failed to send heartbeat PING for @${channelLogin}: ${err.message}`);
            }
          }
        }, 15_000);
        activeSession.chatHeartbeatInterval = heartbeatInterval;
      };

      const handleMessage = (data: WebSocket.Data) => {
        recordActivity();
        const currentSession = state.activeDownloadSessions[channelLogin];
        if (!currentSession || currentSession.isStopped) return;

        const messages = data.toString().split('\r\n');
        for (const msg of messages) {
          if (!msg) continue;
          if (msg.startsWith('PING')) {
            ws.send('PONG :tmi.twitch.tv');
            continue;
          }

          if (!msg.startsWith('@')) continue;
          const parsed = parseIrcMessage(msg);
          if (!parsed) continue;

          const chatSentTs = parseInt(parsed.tags['tmi-sent-ts'] || Date.now().toString(), 10) || Date.now();
          const contentOffsetSeconds = computeOffsetSec(chatSentTs);

          // 1. Standard & Enriched Chat Messages (PRIVMSG)
          if (parsed.command === 'PRIVMSG') {
            let msgBody = parsed.message;
            let isAction = false;
            let emotesTag = parsed.tags.emotes || "";

            if (msgBody.startsWith('\x01ACTION ') && msgBody.endsWith('\x01')) {
              msgBody = msgBody.substring(8, msgBody.length - 1);
              isAction = true;

              if (emotesTag) {
                const shiftedEmotes = [];
                for (const group of emotesTag.split('/')) {
                  const [id, positions] = group.split(':');
                  if (!positions) continue;
                  const shiftedPositions = positions.split(',').map(pos => {
                    const [start, end] = pos.split('-');
                    return `${Math.max(0, parseInt(start, 10) - 8)}-${Math.max(0, parseInt(end, 10) - 8)}`;
                  }).join(',');
                  shiftedEmotes.push(`${id}:${shiftedPositions}`);
                }
                emotesTag = shiftedEmotes.join('/');
              }
            }

            const isFirstMsg = parsed.tags['first-msg'] === '1';
            const isReturningChatter = parsed.tags['returning-chatter'] === '1';
            const isSubscriber = parsed.tags['subscriber'] === '1';
            const isMod = parsed.tags['mod'] === '1';
            const isVip = parsed.tags['vip'] === '1' || (parsed.tags.badges || '').includes('vip/');
            const msgIdType = parsed.tags['msg-id'] || "";
            const isHighlighted = msgIdType === 'highlighted-message';
            const customRewardId = parsed.tags['custom-reward-id'] || "";
            const bitsSpent = parseInt(parsed.tags['bits'] || '0', 10) || 0;

            const userNoticeParams: Record<string, string> = {};
            for (const key of [
              'first-msg', 'returning-chatter', 'msg-id', 'custom-reward-id', 'animation-id',
              'msg-param-emote-id',
              'reply-parent-msg-id', 'reply-parent-user-id', 'reply-parent-user-login',
              'reply-parent-display-name', 'reply-parent-msg-body',
              'reply-thread-parent-msg-id', 'reply-thread-parent-user-login',
              'pinned-chat-paid-amount', 'pinned-chat-paid-currency',
              'pinned-chat-paid-exponent', 'pinned-chat-paid-level', 'pinned-chat-paid-is-system-message',
              'source-room-id', 'source-id', 'source-badges'
            ]) {
              if (parsed.tags[key] !== undefined && parsed.tags[key] !== "") {
                userNoticeParams[key] = parsed.tags[key];
              }
            }

            const eventData: Record<string, any> = {
              msg_id: msgIdType || null,
              msg_id_type: msgIdType || null,
              is_first_message: isFirstMsg,
              first_msg: isFirstMsg,
              is_returning_chatter: isReturningChatter,
              returning_chatter: isReturningChatter,
              is_highlighted: isHighlighted,
              is_subscriber: isSubscriber,
              is_mod: isMod,
              is_vip: isVip,
              bits_spent: bitsSpent,
              custom_reward_id: customRewardId || null
            };

            if (customRewardId && rewardMetadataCache.has(customRewardId)) {
              const cachedReward = rewardMetadataCache.get(customRewardId)!;
              eventData.reward_title = cachedReward.title;
              eventData.reward_cost = cachedReward.cost;
              eventData.reward_prompt = cachedReward.prompt;
              eventData.reward_background_color = cachedReward.background_color;
            }

            if (parsed.tags['reply-parent-msg-id']) {
              eventData.reply = {
                parent_msg_id: parsed.tags['reply-parent-msg-id'],
                parent_user_id: parsed.tags['reply-parent-user-id'] || "",
                parent_user_login: parsed.tags['reply-parent-user-login'] || "",
                parent_display_name: parsed.tags['reply-parent-display-name'] || "",
                parent_msg_body: parsed.tags['reply-parent-msg-body'] || "",
                thread_parent_msg_id: parsed.tags['reply-thread-parent-msg-id'] || "",
                thread_user_login: parsed.tags['reply-thread-parent-user-login'] || ""
              };
            }

            if (msgIdType === 'gigantified-emote-message' || msgIdType === 'animated-message' || msgIdType === 'message-effect' || parsed.tags['animation-id']) {
              let powerUpEmoteId = parsed.tags['msg-param-emote-id'] || null;
              if (!powerUpEmoteId && emotesTag) {
                const groups = emotesTag.split('/').filter(Boolean);
                if (groups.length > 0) {
                  powerUpEmoteId = groups[groups.length - 1].split(':')[0] || null;
                }
              }
              eventData.power_up = {
                type: msgIdType || 'message-effect',
                emote_id: powerUpEmoteId,
                animation_id: parsed.tags['animation-id'] || null
              };
            }

            if (parsed.tags['pinned-chat-paid-amount']) {
              const rawAmt = parseInt(parsed.tags['pinned-chat-paid-amount'], 10) || 0;
              const exp = parseInt(parsed.tags['pinned-chat-paid-exponent'] || '2', 10);
              const decAmt = parseFloat((rawAmt / Math.pow(10, exp)).toFixed(Math.max(0, exp)));
              eventData.hype_chat = {
                amount: rawAmt,
                exponent: exp,
                DecimalAmount: decAmt,
                decimal_amount: decAmt,
                currency: parsed.tags['pinned-chat-paid-currency'] || "USD",
                level: parsed.tags['pinned-chat-paid-level'] || "ONE",
                is_system_message: parsed.tags['pinned-chat-paid-is-system-message'] === '1'
              };
            }

            if (parsed.tags['source-room-id']) {
              eventData.shared_chat = {
                source_room_id: parsed.tags['source-room-id'],
                source_msg_id: parsed.tags['source-id'] || "",
                source_badges: parsed.tags['source-badges'] || ""
              };
            }

            const tdComment: any = {
              _id: parsed.tags.id || `msg-${chatSentTs}-${Math.random().toString(36).slice(2, 8)}`,
              created_at: new Date(chatSentTs).toISOString(),
              updated_at: new Date(chatSentTs).toISOString(),
              channel_id: twitchId,
              content_type: "video",
              content_id: streamId,
              content_offset_seconds: contentOffsetSeconds,
              commenter: {
                display_name: parsed.tags['display-name'] || parsed.username,
                _id: parsed.tags['user-id'] || "",
                name: parsed.username,
                type: "user",
                bio: "",
                created_at: new Date(chatSentTs).toISOString(),
                updated_at: new Date(chatSentTs).toISOString(),
                logo: ""
              },
              source: "chat",
              state: "published",
              bits_spent: bitsSpent,
              user_notice_params: userNoticeParams,
              first_msg: isFirstMsg,
              returning_chatter: isReturningChatter,
              message: {
                body: msgBody,
                fragments: buildFragments(msgBody, emotesTag),
                is_action: isAction,
                user_badges: parseBadges(parsed.tags.badges || ""),
                user_color: parsed.tags.color || null,
                bits_spent: bitsSpent,
                user_notice_params: userNoticeParams
              },
              event_type: customRewardId ? "channel_points_custom_reward_redemption" : "chat_message",
              event_data: eventData
            };

            enqueueComment(tdComment);
            continue;
          }

          // 2. Subscriptions, Gift Subs, Raids, Announcements, Watch Streaks (USERNOTICE)
          if (parsed.command === 'USERNOTICE') {
            const msgId = parsed.tags['msg-id'] || 'usernotice';
            const systemMsg = parsed.tags['system-msg'] || "";
            const userMsg = parsed.message || "";
            const emotesTag = parsed.tags.emotes || "";
            const displayBody = userMsg || systemMsg;
            const fragments = userMsg
              ? buildFragments(userMsg, emotesTag)
              : [{ text: systemMsg }];

            const userNoticeParams: Record<string, string> = {};
            for (const [k, v] of Object.entries(parsed.tags)) {
              if (k === 'msg-id' || k === 'system-msg' || k.startsWith('msg-param-') || k === 'login' || k === 'display-name') {
                userNoticeParams[k] = v;
              }
            }

            const loginName = parsed.tags['login'] || parsed.username || "twitch";
            const displayName = parsed.tags['display-name'] || loginName || "Twitch";
            const userId = parsed.tags['user-id'] || "0";
            const originId = parsed.tags['msg-param-origin-id'] || "";

            // Resolve sender lifetime gift count across submysterygift and child subgift notices
            const rawSenderCountStr = parsed.tags['msg-param-sender-count'] ?? parsed.tags['msg-param-cumulative-gift-count'];
            const parsedSenderCount = rawSenderCountStr !== undefined && rawSenderCountStr !== ""
              ? parseInt(rawSenderCountStr, 10)
              : NaN;

            let effectiveSenderCount: number | null = (!isNaN(parsedSenderCount) && parsedSenderCount > 0)
              ? parsedSenderCount
              : null;

            if (effectiveSenderCount !== null) {
              if (originId) gifterSenderCountCache.set(`origin:${originId}`, effectiveSenderCount);
              if (userId && userId !== "0") gifterSenderCountCache.set(`uid:${userId}`, effectiveSenderCount);
              if (loginName && loginName !== "twitch") gifterSenderCountCache.set(`login:${loginName.toLowerCase()}`, effectiveSenderCount);
            } else if (msgId === 'subgift' || msgId === 'submysterygift' || msgId === 'communitypayforward') {
              const cachedCount =
                (originId ? gifterSenderCountCache.get(`origin:${originId}`) : undefined) ??
                (userId && userId !== "0" ? gifterSenderCountCache.get(`uid:${userId}`) : undefined) ??
                (loginName ? gifterSenderCountCache.get(`login:${loginName.toLowerCase()}`) : undefined);
              if (cachedCount !== undefined && cachedCount > 0) {
                effectiveSenderCount = cachedCount;
              }
            }

            if (effectiveSenderCount !== null && effectiveSenderCount > 0) {
              userNoticeParams['msg-param-sender-count'] = String(effectiveSenderCount);
            } else if (userNoticeParams['msg-param-sender-count'] === '0' || userNoticeParams['msg-param-sender-count'] === '') {
              delete userNoticeParams['msg-param-sender-count'];
            }

            const commentEventType = 'usernotice';

            const tdNoticeComment: any = {
              _id: parsed.tags.id || `usernotice-${chatSentTs}-${Math.random().toString(36).slice(2, 8)}`,
              created_at: new Date(chatSentTs).toISOString(),
              updated_at: new Date(chatSentTs).toISOString(),
              channel_id: twitchId,
              content_type: "video",
              content_id: streamId,
              content_offset_seconds: contentOffsetSeconds,
              commenter: {
                display_name: displayName,
                _id: userId,
                name: loginName,
                type: "user",
                bio: "",
                created_at: new Date(chatSentTs).toISOString(),
                updated_at: new Date(chatSentTs).toISOString(),
                logo: ""
              },
              source: "chat",
              state: "published",
              bits_spent: 0,
              user_notice_params: userNoticeParams,
              message: {
                body: displayBody,
                fragments,
                is_action: false,
                user_badges: parseBadges(parsed.tags.badges || ""),
                user_color: parsed.tags.color || null,
                bits_spent: 0,
                user_notice_params: userNoticeParams
              },
              event_type: commentEventType,
              event_data: {
                notice_type: msgId,
                category: msgId,
                system_message: systemMsg,
                user_message: userMsg,
                announcement_color: parsed.tags['msg-param-color'] || null,
                cumulative_months: parsed.tags['msg-param-cumulative-months'] ? parseInt(parsed.tags['msg-param-cumulative-months'], 10) : null,
                streak_months: parsed.tags['msg-param-streak-months'] ? parseInt(parsed.tags['msg-param-streak-months'], 10) : null,
                sub_plan: parsed.tags['msg-param-sub-plan'] || null,
                sub_plan_name: parsed.tags['msg-param-sub-plan-name'] || null,
                recipient_id: parsed.tags['msg-param-recipient-id'] || null,
                recipient_user_id: parsed.tags['msg-param-recipient-id'] || null,
                recipient_user_name: parsed.tags['msg-param-recipient-user-name'] || null,
                recipient_user_login: parsed.tags['msg-param-recipient-user-name'] || null,
                recipient_display_name: parsed.tags['msg-param-recipient-display-name'] || null,
                mass_gift_count: parsed.tags['msg-param-mass-gift-count'] ? parseInt(parsed.tags['msg-param-mass-gift-count'], 10) : null,
                sender_total_gifts: effectiveSenderCount,
                raid_viewer_count: parsed.tags['msg-param-viewerCount'] ? parseInt(parsed.tags['msg-param-viewerCount'], 10) : null,
                raid_display_name: parsed.tags['msg-param-displayName'] || null,
                milestone_category: parsed.tags['msg-param-category'] || null,
                milestone_value: parsed.tags['msg-param-value'] ? parseInt(parsed.tags['msg-param-value'], 10) : null,
                milestone_reward: parsed.tags['msg-param-copoReward'] ? parseInt(parsed.tags['msg-param-copoReward'], 10) : null,
                params: userNoticeParams
              }
            };

            enqueueComment(tdNoticeComment);
            currentSession.eventsWritten = (currentSession.eventsWritten || 0) + 1;
            continue;
          }

          // 3. Moderator Timeouts, Permanent Bans & Chat Clears (CLEARCHAT)
          if (parsed.command === 'CLEARCHAT') {
            const targetUserLogin = (parsed.message || "").trim();
            const targetUserId = parsed.tags['target-user-id'] || "";
            const banDurationRaw = parsed.tags['ban-duration'];
            const banDurationSeconds = banDurationRaw !== undefined && banDurationRaw !== "" ? parseInt(banDurationRaw, 10) : null;
            const action = !targetUserLogin
              ? 'clear_all'
              : banDurationSeconds !== null
              ? 'timeout'
              : 'ban';

            appendBroadcastEvent(channelLogin, {
              _id: parsed.tags.id || `clearchat-${chatSentTs}-${targetUserLogin || 'all'}-${Math.random().toString(36).slice(2, 6)}`,
              created_at: new Date(chatSentTs).toISOString(),
              content_offset_seconds: contentOffsetSeconds,
              source: 'irc',
              type: 'clearchat',
              event_type: 'clearchat',
              category: action === 'clear_all' ? 'clear_chat' : action,
              action,
              data: {
                action,
                target_user_id: targetUserId || null,
                target_user_login: targetUserLogin || null,
                ban_duration_seconds: banDurationSeconds,
                room_id: parsed.tags['room-id'] || twitchId
              }
            });
            continue;
          }

          // 4. Single Message Deletion by Moderator (CLEARMSG)
          if (parsed.command === 'CLEARMSG') {
            const targetMsgId = parsed.tags['target-msg-id'] || "";
            const targetUserLogin = parsed.tags['login'] || "";
            const deletedBody = parsed.message || "";

            appendBroadcastEvent(channelLogin, {
              _id: `clearmsg-${chatSentTs}-${targetMsgId || Math.random().toString(36).slice(2, 7)}`,
              created_at: new Date(chatSentTs).toISOString(),
              content_offset_seconds: contentOffsetSeconds,
              source: 'irc',
              type: 'clearmsg',
              event_type: 'clearmsg',
              category: 'delete_message',
              data: {
                target_msg_id: targetMsgId,
                target_user_login: targetUserLogin,
                deleted_body: deletedBody,
                deleted_message_body: deletedBody,
                room_id: parsed.tags['room-id'] || twitchId
              }
            });
            continue;
          }

          // 5. Chat Room Mode Changes (ROOMSTATE)
          if (parsed.command === 'ROOMSTATE') {
            const stateChanges: Record<string, any> = {
              emote_only: null,
              subs_only: null,
              slow_seconds: null,
              followers_only_minutes: null,
              r9k: null
            };
            let hasDelta = false;

            if (parsed.tags['emote-only'] !== undefined) {
              const val = parsed.tags['emote-only'] === '1';
              if (lastRoomState.emote_only !== val) {
                lastRoomState.emote_only = val;
                stateChanges.emote_only = val;
                hasDelta = true;
              }
            }
            if (parsed.tags['subs-only'] !== undefined) {
              const val = parsed.tags['subs-only'] === '1';
              if (lastRoomState.subs_only !== val) {
                lastRoomState.subs_only = val;
                stateChanges.subs_only = val;
                hasDelta = true;
              }
            }
            if (parsed.tags['slow'] !== undefined) {
              const val = parseInt(parsed.tags['slow'], 10) || 0;
              if (lastRoomState.slow_seconds !== val) {
                lastRoomState.slow_seconds = val;
                stateChanges.slow_seconds = val;
                stateChanges.slow_mode_seconds = val;
                hasDelta = true;
              }
            }
            if (parsed.tags['followers-only'] !== undefined) {
              const val = parseInt(parsed.tags['followers-only'], 10);
              const normVal = Number.isFinite(val) ? val : -1;
              if (lastRoomState.followers_only_minutes !== normVal) {
                lastRoomState.followers_only_minutes = normVal;
                stateChanges.followers_only_minutes = normVal;
                hasDelta = true;
              }
            }
            if (parsed.tags['r9k'] !== undefined) {
              const val = parsed.tags['r9k'] === '1';
              if (lastRoomState.r9k !== val) {
                lastRoomState.r9k = val;
                stateChanges.r9k = val;
                stateChanges.r9k_unique_chat = val;
                hasDelta = true;
              }
            }

            if (hasDelta) {
              appendBroadcastEvent(channelLogin, {
                _id: `roomstate-${chatSentTs}-${Math.random().toString(36).slice(2, 7)}`,
                created_at: new Date(chatSentTs).toISOString(),
                content_offset_seconds: contentOffsetSeconds,
                source: 'irc',
                type: 'roomstate',
                event_type: 'roomstate',
                category: 'roomstate_updated',
                data: stateChanges
              });
            }
            continue;
          }
        }
      };

      const cleanupListeners = () => {
        clearHeartbeat();
        ws.removeListener('open', handleOpen);
        ws.removeListener('message', handleMessage);
        ws.removeListener('close', handleClose);
        ws.removeListener('error', handleError);
        ws.removeListener('ping', recordActivity);
        ws.removeListener('pong', recordActivity);
      };

      const handleClose = () => {
        cleanupListeners();
        addLog(`[Chat] Live chat connection closed.`);
        const currentSession = state.activeDownloadSessions[channelLogin];
        if (currentSession) {
          currentSession.ircConnected = false;
          emitSessionsDelta(true);
          flushPendingChatWrites(currentSession);
        }
        if (currentSession && !currentSession.isStopped) {
          if (currentSession.chatReconnectTimer) {
            clearTimeout(currentSession.chatReconnectTimer);
          }
          addLog(`[Chat] Reconnecting to live chat for ${channelLogin} in 5 seconds...`);
          currentSession.chatReconnectTimer = setTimeout(() => {
            if (state.activeDownloadSessions[channelLogin] && !state.activeDownloadSessions[channelLogin].isStopped) {
              connectWebSocket();
            }
          }, 5000);
        }
      };

      const handleError = (err: any) => {
        addLog(`[Chat] WebSocket error: ${err.message}`);
      };

      ws.on('open', handleOpen);
      ws.on('message', handleMessage);
      ws.on('ping', recordActivity);
      ws.on('pong', recordActivity);
      ws.on('close', handleClose);
      ws.on('error', handleError);
    }

    connectWebSocket();
    attachHermesOverlayClient({
      channelLogin,
      twitchId,
      rewardMetadataCache,
      computeOffsetSec,
      appendBroadcastEvent,
    });
  }

  /**
   * Resolves a pending backfill choice for live chat (Full VOD, Current Game Only, or No Backfill).
   * Appends cleanly to `.comments.jsonl` ensuring seamless ordering and zero duplicate messages.
   */
  export async function resolveLiveChatBackfill(
    channelLogin: string,
    mode: 'full' | 'current_game' | 'none',
    startOffsetSec = 0,
    gameName?: string
  ) {
    const session = state.activeDownloadSessions[channelLogin];
    if (!session || !session.chatStream) return;

    const chatStream = session.chatStream;
    const existingIds = session.chatExistingIds || new Set<string>();
    const liveBuffer = session.liveChatBuffer || [];

    const writeJournalLines = (comments: any[], recomputeBroadcastOffsetMs?: number): number => {
      let count = 0;
      let ndjson = "";
      for (const comment of comments) {
        if (!comment || !comment._id || existingIds.has(comment._id)) continue;
        if (recomputeBroadcastOffsetMs && comment.created_at) {
          const t = new Date(comment.created_at).getTime();
          if (Number.isFinite(t)) {
            comment.content_offset_seconds = Math.max(0, parseFloat(((t - recomputeBroadcastOffsetMs) / 1000.0).toFixed(3)));
          }
        }
        ndjson += JSON.stringify(comment) + "\n";
        session.commentsWritten = (session.commentsWritten || 0) + 1;
        existingIds.add(comment._id);
        count++;
      }
      if (ndjson) {
        chatStream.write(ndjson);
      }
      return count;
    };

    if (mode === 'none') {
      session.isAwaitingBackfillChoice = false;
      const liveCount = writeJournalLines(liveBuffer);
      session.liveChatBuffer = [];
      addLog(`[Chat] User chose No Backfill. Appended ${liveCount} buffered live messages. Continuing live chat.`);
      return;
    }

    const offsetToStart = mode === 'full' ? 0 : Math.max(0, startOffsetSec);
    const broadcastStartMs = session.streamCreatedAtMs || session.videoStartTimeMs || (session.startTime ? new Date(session.startTime).getTime() : Date.now());
    const currentLiveOffset = Math.max(offsetToStart + 300, (Date.now() - broadcastStartMs) / 1000.0);

    // Align active session timeline to broadcast timeline so live IRC offsets remain synchronized with backfill
    session.videoStartTimeMs = broadcastStartMs;

    addLog(`[Chat] Starting VOD chat backfill (${mode === 'full' ? 'Full VOD' : `Current Game from ${offsetToStart}s`}) up to ${currentLiveOffset.toFixed(1)}s...`);

    try {
      const result = await downloadVodChat(
        channelLogin,
        session.folderPath,
        true,
        session.chatFilePath!,
        offsetToStart,
        false,
        session.commentsWritten,
        currentLiveOffset + 60,
        existingIds
      );

      if (result && result.backfillComments && result.backfillComments.length > 0) {
        if (!session.usedFirstPartyEmotes) session.usedFirstPartyEmotes = new Map<string, string>();
        if (!session.usedTwitchBadges) session.usedTwitchBadges = new Map<string, Set<string>>();
        extractUsedEmotesAndBadgesFromComments(result.backfillComments, undefined, session.usedFirstPartyEmotes, session.usedTwitchBadges);

        const gapCount = writeJournalLines(result.backfillComments);
        addLog(`[Chat] Backfill appended ${gapCount} messages from VOD.`);

        // Immediately generate paired standalone VOD backfill chat JSON directly from in-memory backfill dataset
        try {
          const dateMatch = session.folderPath.match(/_(\d{4}-\d{2}-\d{2})_/);
          const dateStr = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];
          const vodGameName = gameName || session.currentGame;
          const cleanName = vodGameName ? vodGameName.replace(/[^a-z0-9]/gi, '_').toLowerCase() : '';
          const vodJsonOutputName = cleanName
            ? `${cleanName}_vod_backfill_${dateStr}.json`
            : `vod_broadcast_${dateStr}.json`;
          const vodOutChatPath = path.join(session.folderPath, vodJsonOutputName);

          const standaloneComments: any[] = [];
          for (const c of result.backfillComments) {
            const streamTime = c.content_offset_seconds || 0;
            const newC = JSON.parse(JSON.stringify(c));
            newC.content_offset_seconds = Math.max(0, streamTime - offsetToStart);
            standaloneComments.push(newC);
          }

          let standaloneDuration = 1;
          if (standaloneComments.length > 0) {
            const lastOffset = Math.ceil(standaloneComments[standaloneComments.length - 1].content_offset_seconds || 0);
            standaloneDuration = Math.max(1, lastOffset);
          }

          const standalonePayload = normalizeTwitchDownloaderSchema(
            {
              comments: standaloneComments,
              events: [],
              ...(session.thirdPartyEmotes ? { emotes: session.thirdPartyEmotes } : {}),
            },
            {
              channelLogin,
              streamerId: session.twitchId,
              streamId: session.streamId || "",
              title: session.currentTitle || "",
              createdAt: session.startTime || new Date(broadcastStartMs).toISOString(),
              gameName: vodGameName || "",
              durationSec: standaloneDuration,
              thirdPartyEmotes: session.thirdPartyEmotes || [],
            }
          );

          await populateEmbeddedDataForChat(
            standalonePayload,
            standalonePayload.streamer.name,
            standalonePayload.streamer.id
          );

          await writeJsonAtomic(vodOutChatPath, standalonePayload);
          addLog(`[VOD Chat] Successfully generated standalone paired chat: ${vodJsonOutputName} (${standaloneComments.length} messages, duration: ${standaloneDuration}s, streamer.id: ${standalonePayload.streamer.id}).`);

          if (session.captureMode === 'chat_only') {
            const vodChatTaskId = `vod_chat_backfill_${session.streamId}_${Date.now()}`;
            updateTask(
              vodChatTaskId,
              `VOD Chat Backfill Complete (${vodGameName || 'Backfill'})`,
              `Saved standalone VOD chat (${standaloneComments.length.toLocaleString()} messages) to ${session.folderPath}`,
              "success",
              false,
              [
                { label: "Render Chat", value: "render_chat" },
                { label: "Open Folder", value: "open_folder" },
                { label: "Close", value: "dismiss" }
              ]
            );
            if (state.activeTasks[vodChatTaskId]) {
              state.activeTasks[vodChatTaskId].folderPath = session.folderPath;
              state.activeTasks[vodChatTaskId].channelLogin = channelLogin;
              state.activeTasks[vodChatTaskId].captureMode = 'chat_only';
            }

            const autoRender = state.config.channelAutoRender?.[channelLogin] ?? state.config.autoRenderChat ?? session.autoRenderChat ?? false;
            if (autoRender) {
              const resDim = getChatRenderDimensionsForGame(vodGameName, vodJsonOutputName);
              addLog(`[VOD Chat] Triggering automatic chat render for Chat-Only VOD backfill: ${vodJsonOutputName} (${resDim.width}x${resDim.height}${resDim.isCustomProfile ? ` via profile "${resDim.matchedProfile}"` : ''})`);
              startChatRenderMultiple(channelLogin, session.folderPath, [
                { filename: vodJsonOutputName, width: resDim.width, height: resDim.height }
              ]).catch(err => {
                addLog(`[VOD Chat Auto-Render Error] ${err.message}`);
              });
            }
          }
        } catch (standaloneErr: any) {
          addLog(`[VOD Chat] Non-fatal error creating standalone backfill chat JSON: ${standaloneErr.message}`);
        }
      } else {
        addLog(`[Chat] No VOD messages returned for backfill range.`);
      }
    } catch (err: any) {
      addLog(`[Chat] Non-fatal error backfilling chat: ${err.message}`);
    } finally {
      session.isAwaitingBackfillChoice = false;
      const liveCount = writeJournalLines(liveBuffer, broadcastStartMs);
      session.liveChatBuffer = [];
      addLog(`[Chat] Merged ${liveCount} live messages. Seamless chat active.`);
    }
  }

  export function abortAllChatProcesses() {
    for (const job of renderQueue) {
      cancelledRenderTaskIds.add(job.taskId);
      removeTask(job.taskId);
      job.resolve();
    }
    renderQueue.length = 0;
    for (const taskId of Object.keys(state.activeProcesses)) {
      abortChatProcess(taskId);
    }
  }
