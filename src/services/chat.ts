import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import WebSocket from "ws";
import { state, addLog, updateTask, removeTask, resolveTdPath, getChatRenderDimensionsForGame, getChatRenderDimensionsForChatFile } from "./state";
import { postTwitchGql, fetchRecentVods } from "./twitch";
import {
  fetchThirdPartyEmotes,
  extractUsedEmotesAndBadgesFromComments,
  fetchFirstPartyEmotesFromMap,
  fetchTwitchBadgesFromMap,
  populateEmbeddedDataForChat
} from "./emotes";
import { ensureFfmpeg, getVideoDurationSeconds, checkVideoIsHevc } from "./ffmpeg";

import type { ChatBroadcastEvent } from "../types";

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

export function getEventsSidecarPath(chatFilePath: string): string {
  return chatFilePath.replace(/\.json$/i, '.events.jsonl');
}

export function readBroadcastEventsForChatFile(chatFilePath?: string, parsedChatObj?: any): ChatBroadcastEvent[] {
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
        const rawLines = fs.readFileSync(sidecarPath, 'utf8').split(/\r?\n/);
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

  const sidecarPath = session.eventsFilePath || (session.chatFilePath ? getEventsSidecarPath(session.chatFilePath) : "");
  if (sidecarPath) {
    session.eventsFilePath = sidecarPath;
    fs.promises.appendFile(sidecarPath, JSON.stringify(event) + "\n", "utf8").catch(() => {});
  }
}

export function sliceAndCarryOverBroadcastEvents(
  events: ChatBroadcastEvent[],
  videoStartOffset: number,
  videoEndOffset: number,
  gapAdjustments: { atChunk: number; missingDurationSec: number }[],
  baseOffsetSec: number,
  baseSeq: number,
  avgChunkDur: number
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
        const gapOffsetSec = baseOffsetSec + Math.max(0, gap.atChunk - baseSeq) * avgChunkDur;
        if (streamTime > gapOffsetSec) {
          streamTime -= gap.missingDurationSec;
        }
      }
    }

    if (streamTime < videoStartOffset) {
      if (evtType === 'prediction' && evt.data?.prediction_id) {
        const pid = String(evt.data.prediction_id);
        const st = String(evt.data.status || '').toUpperCase();
        if (st === 'RESOLVED' || st === 'CANCELED' || st === 'CANCELLED') {
          activePredictionsBeforeStart.delete(pid);
        } else {
          activePredictionsBeforeStart.set(pid, evt);
        }
      } else if (evtType === 'poll' && evt.data?.poll_id) {
        const pollId = String(evt.data.poll_id);
        const st = String(evt.data.status || '').toUpperCase();
        if (st === 'COMPLETED' || st === 'ARCHIVED' || st === 'TERMINATED') {
          activePollsBeforeStart.delete(pollId);
        } else {
          activePollsBeforeStart.set(pollId, evt);
        }
      } else if (evtType === 'pinned_chat' && evt.data?.pin_id) {
        const pinId = String(evt.data.pin_id);
        if (evt.category === 'unpin_message' || evt.data?.action === 'unpin-message') {
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
      } else if (evtType === 'hype_train') {
        if (evt.category === 'hype_train_end' || evt.data?.pubsub_type === 'hype-train-end' || evt.data?.ended_at) {
          activeHypeTrainBeforeStart = null;
        } else if (activeHypeTrainBeforeStart) {
          const mergedTrain: ChatBroadcastEvent = JSON.parse(JSON.stringify(activeHypeTrainBeforeStart));
          mergedTrain.data = { ...mergedTrain.data, ...evt.data };
          activeHypeTrainBeforeStart = mergedTrain;
        } else {
          activeHypeTrainBeforeStart = evt;
        }
      }
    } else if (streamTime >= videoStartOffset && streamTime <= videoEndOffset) {
      const cloned: ChatBroadcastEvent = JSON.parse(JSON.stringify(evt));
      if (!cloned.type) cloned.type = cloned.event_type;
      cloned.content_offset_seconds = parseFloat(Math.max(0, streamTime - videoStartOffset).toFixed(3));
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
   * Scans chat JSON content and returns the index immediately following the closing '}'
   * of the last complete comment object inside the "comments" array.
   * Correctly accounts for string quotation, escape characters, and nested objects.
   * Returns -1 if no complete comment is found.
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
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === '{') {
        if (braceDepth === 0) {
          commentStart = i;
        }
        braceDepth++;
      } else if (ch === '}') {
        if (braceDepth > 0) {
          braceDepth--;
          if (braceDepth === 0 && commentStart !== -1) {
            lastCompleteEnd = i + 1;
            commentStart = -1;
          }
        }
      } else if (ch === ']' && braceDepth === 0) {
        // If a premature mid-stream seal wrote a closing ']' followed by additional live comments,
        // return -1 so safeParseChatData falls back to full-file comment extraction across the seam.
        const remainder = content.substring(i + 1);
        if (/"content_offset_seconds"\s*:\s*[\d.]+/.test(remainder) && /"commenter"\s*:\s*\{/.test(remainder)) {
          return -1;
        }
        break;
      }
    }

    return lastCompleteEnd;
  }

  /**
   * Resiliently extracts all complete, valid comments and metadata from a potentially
   * malformed, incomplete, or corrupted chat JSON string.
   */
  export function extractChatCommentsFallback(content: string): any {
    let fileInfo = {
      Version: { Major: 1, Minor: 5, Patch: 3 },
      CreatedAt: new Date().toISOString(),
      UpdatedAt: new Date().toISOString()
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
      game: ""
    };

    const streamerMatch = content.match(/"streamer"\s*:\s*(\{[^}]+\})/);
    if (streamerMatch) {
      try { streamer = JSON.parse(streamerMatch[1]); } catch (_) {}
    }
    if (!streamer || typeof streamer.id !== 'number' || isNaN(streamer.id)) {
      streamer = {
        name: streamer?.name || "streamer",
        id: parseInt(String(streamer?.id || 0), 10) || 0
      };
    }
    const videoMatch = content.match(/"video"\s*:\s*(\{[^}]+length":\s*[\d.]+\s*,\s*"viewCount":\s*\d+\s*,\s*"game":\s*"[^"]*"\s*\})/);
    if (videoMatch) {
      try { video = JSON.parse(videoMatch[1]); } catch (_) {}
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
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (ch === '{') {
        if (braceDepth === 0) {
          commentStart = i;
        }
        braceDepth++;
      } else if (ch === '}') {
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
            } catch (_) {
              // Skip malformed comment
            }
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
      try { thirdParty = JSON.parse(emotesMatch[1]); } catch (_) {}
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
        twitchBadges: []
      }
    };
  }

  /**
   * Safely parses chat data from raw JSON string, handling:
   * 1. Valid closed JSON.
   * 2. Unclosed live stream JSON being actively written (seals cleanly after the last complete comment).
   * 3. Malformed/partially corrupted files with broken seams (extracts all individual valid comments).
   */
  export function safeParseChatData(content: string, chatFilePath?: string): any {
    if (!content || !content.trim()) return null;

    let result: any = null;

    // 1. Direct parse attempt
    try {
      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.comments)) {
        result = parsed;
      }
    } catch (_) {}

    // 2. Clean truncation at last complete comment
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

    // 3. Fallback extraction of individual comments
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

  /**
   * Validate and repair corrupted or concatenated chat JSON files.
   * Reconstructs a valid schema for TwitchDownloaderCLI and chat rendering.
   */
  export async function repairChatJsonFile(filePath: string): Promise<boolean> {
    if (!fs.existsSync(filePath)) return false;
    try {
      const resolvedTarget = path.resolve(filePath);
      const activeOpenSession = Object.values(state.activeDownloadSessions).find(
        (s: any) => s && !s.isStopped && s.chatStream && s.chatFilePath && path.resolve(s.chatFilePath) === resolvedTarget
      );
      if (activeOpenSession) {
        addLog(`[Chat Repair] Skipping in-place file seal on active open live chat stream: ${path.basename(filePath)} (@${activeOpenSession.channel}).`);
        return true;
      }

      const raw = await fs.promises.readFile(filePath, 'utf8');
      let parsed: any = null;
      let needsResave = false;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        // JSON is malformed, proceed to repair via safeParseChatData
      }

      if (parsed && Array.isArray(parsed.comments)) {
        // Validate and sanitize critical header fields required by TwitchDownloaderCLI (.NET System.Int32)
        if (!parsed.FileInfo) {
          parsed.FileInfo = {
            Version: { Major: 1, Minor: 5, Patch: 3 },
            CreatedAt: new Date().toISOString(),
            UpdatedAt: new Date().toISOString()
          };
          needsResave = true;
        }
        if (!parsed.streamer || typeof parsed.streamer.id !== 'number' || isNaN(parsed.streamer.id)) {
          const rawId = parsed.streamer?.id;
          const numId = parseInt(String(rawId || 0), 10) || 0;
          parsed.streamer = {
            name: parsed.streamer?.name || "streamer",
            id: numId
          };
          needsResave = true;
        }
        const mergedEvents = readBroadcastEventsForChatFile(filePath, parsed);
        if (mergedEvents.length > 0 && (!Array.isArray(parsed.events) || parsed.events.length !== mergedEvents.length)) {
          parsed.events = mergedEvents;
          needsResave = true;
        }
        if (!parsed.embeddedData) {
          parsed.embeddedData = {
            thirdParty: Array.isArray(parsed.emotes) ? parsed.emotes : [],
            firstParty: [],
            twitchBadges: []
          };
          needsResave = true;
        }
        if (needsResave) {
          await fs.promises.writeFile(filePath, JSON.stringify(parsed, null, 2), 'utf8');
          addLog(`[Chat Repair] Sanitized header structure (streamer.id: ${parsed.streamer.id}) in ${path.basename(filePath)}.`);
        }
        return true;
      }

      addLog(`[Chat Repair] Malformed JSON detected in ${path.basename(filePath)}. Reconstructing valid chat structure...`);

      const cleanChatObj = safeParseChatData(raw, filePath);
      if (!cleanChatObj || !Array.isArray(cleanChatObj.comments)) {
        throw new Error("Unable to extract comments from file");
      }

      // Guarantee streamer.id is numeric integer
      if (!cleanChatObj.streamer || typeof cleanChatObj.streamer.id !== 'number' || isNaN(cleanChatObj.streamer.id)) {
        cleanChatObj.streamer = {
          name: cleanChatObj.streamer?.name || "streamer",
          id: parseInt(String(cleanChatObj.streamer?.id || 0), 10) || 0
        };
      }
      if (!cleanChatObj.FileInfo) {
        cleanChatObj.FileInfo = {
          Version: { Major: 1, Minor: 5, Patch: 3 },
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString()
        };
      }
      if (!cleanChatObj.embeddedData) {
        cleanChatObj.embeddedData = {
          thirdParty: Array.isArray(cleanChatObj.emotes) ? cleanChatObj.emotes : [],
          firstParty: [],
          twitchBadges: []
        };
      }

      await fs.promises.writeFile(filePath, JSON.stringify(cleanChatObj, null, 2), 'utf8');
      addLog(`[Chat Repair] Successfully repaired ${path.basename(filePath)} (${cleanChatObj.comments.length} comments recovered).`);
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
      let data = safeParseChatData(raw, filePath);
      if (!data) return;
      let modified = false;

      if (!data.FileInfo) {
        data.FileInfo = {
          Version: { Major: 1, Minor: 5, Patch: 3 },
          CreatedAt: new Date().toISOString(),
          UpdatedAt: new Date().toISOString()
        };
        modified = true;
      }

      if (!data.streamer || typeof data.streamer.id !== 'number' || isNaN(data.streamer.id)) {
        const rawId = data.streamer?.id;
        const numId = parseInt(String(rawId || 0), 10) || 0;
        data.streamer = {
          name: data.streamer?.name || "streamer",
          id: numId
        };
        modified = true;
      }

      if (!data.embeddedData) {
        data.embeddedData = {
          thirdParty: Array.isArray(data.emotes) ? data.emotes : [],
          firstParty: [],
          twitchBadges: []
        };
        modified = true;
      }

      if (modified) {
        await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
        addLog(`[Render Sanitizer] Pre-flight verified and updated ${path.basename(filePath)} (streamer.id=${data.streamer.id}).`);
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
      let isHevcStream = false;

      // Check 1: Active session or cached session metadata matching this folder
      const matchingSession = Object.values(state.activeDownloadSessions).find(
        (s: any) => s.folderPath && path.resolve(s.folderPath) === path.resolve(folderPath)
      );
      if (matchingSession?.isFmp4) {
        isHevcStream = true;
      }

      // Check 2: Task object metadata
      const taskObj = state.activeTasks[taskId];
      if ((taskObj as any)?.isFmp4) {
        isHevcStream = true;
      }

      // Check 3: Presence of initialization segment in folder (authoritative for CMAF fMP4 / Enhanced)
      if (!isHevcStream && fs.existsSync(path.join(folderPath, 'init.mp4'))) {
        try {
          const st = await fs.promises.stat(path.join(folderPath, 'init.mp4'));
          if (st.size > 100) isHevcStream = true;
        } catch (_) {}
      }

      // Check 4: Inspect existing segment files in folder
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

      // Check 5: Probe video file stream codec directly with ffprobe
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

      // Select sync offset based on detected broadcast codec
      const defaultOffset = isHevcStream ? -7.5 : -2.5;
      const configuredOffset = isHevcStream
        ? (cr.syncOffsetHevc !== undefined ? cr.syncOffsetHevc : -7.5)
        : (cr.syncOffset !== undefined ? cr.syncOffset : -2.5);
      const syncOffset = typeof configuredOffset === 'number' ? configuredOffset : (parseFloat(configuredOffset) || defaultOffset);

      addLog(`[Render] Detected stream format for ${chatFile}: ${isHevcStream ? 'HEVC / 1440p (Enhanced)' : 'Standard H.264 (1080p)'}. Using sync offset: ${syncOffset}s.`);

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

  let batchStr = "";
  for (let i = 0; i < batch.length; i++) {
    if (session.commentsWritten > 0 || i > 0) {
      batchStr += ',\n    ';
    } else {
      batchStr += '    ';
    }
    batchStr += JSON.stringify(batch[i]);
    session.commentsWritten++;
  }

  try {
    session.chatStream.write(batchStr);
  } catch (err: any) {
    console.error("[Chat] Error writing batched comments:", err);
  }
}

export async function startLiveChatDownload(channelLogin: string, folderPath: string, streamId: string, twitchId: string, startTime: string) {
    const activeSession = state.activeDownloadSessions[channelLogin];
    if (activeSession && !activeSession.isStopped) {
      if (activeSession.chatWs && (activeSession.chatWs.readyState === WebSocket.OPEN || activeSession.chatWs.readyState === WebSocket.CONNECTING) && activeSession.chatStream) {
        // Chat recording is already actively streaming; prevent duplicate sockets and backups
        return;
      }
    }

    addLog(`[Chat] Starting live chat recording for ${channelLogin}...`);
    const dateStr = startTime.split('T')[0];
    const chatFilePath = path.join(folderPath, `chat_${dateStr}.json`);
    
    // Phase 3: Recovery Check
    let isRecovery = false;
    let recoveredOffset = 0;
    let recoveredCommentsWritten = 0;
    const existingIds = new Set<string>();

    if (fs.existsSync(chatFilePath)) {
      try {
        const stats = fs.statSync(chatFilePath);
        // Only create backup if the file has meaningful content (> 1KB)
        if (stats.size > 1024) {
          let shouldCreateBackup = true;
          try {
            const files = fs.readdirSync(folderPath);
            const backupFiles = files.filter(f => f.startsWith(`chat_${dateStr}_backup_`));
            if (backupFiles.length > 0) {
              const latestBackup = backupFiles.sort().reverse()[0];
              const match = latestBackup.match(/backup_(\d+)\.json/);
              if (match) {
                const lastBackupTime = parseInt(match[1], 10);
                if (Date.now() - lastBackupTime < 15 * 60 * 1000) {
                  shouldCreateBackup = false; // Backed up within the last 15 minutes
                }
              }
            }
          } catch (e) {}

          if (shouldCreateBackup) {
            const backupFilePath = path.join(folderPath, `chat_${dateStr}_backup_${Date.now()}.json`);
            try {
              fs.copyFileSync(chatFilePath, backupFilePath);
              addLog(`[Chat Recovery] Created safety backup of existing chat: ${path.basename(backupFilePath)}`);

              // Keep at most 5 recent backups to prevent folder clutter
              try {
                const files = fs.readdirSync(folderPath);
                const backups = files.filter(f => f.startsWith(`chat_${dateStr}_backup_`)).sort();
                if (backups.length > 5) {
                  const toDelete = backups.slice(0, backups.length - 5);
                  for (const delFile of toDelete) {
                    try { fs.unlinkSync(path.join(folderPath, delFile)); } catch (err) {}
                  }
                }
              } catch (e) {}
            } catch (backupErr: any) {
              addLog(`[Chat Recovery] Note: Could not create chat backup: ${backupErr.message}`);
            }
          }
        }

        const content = fs.readFileSync(chatFilePath, 'utf8');
        const commentsStartMatch = content.match(/"comments"\s*:\s*\[/);

        if (commentsStartMatch && commentsStartMatch.index !== undefined) {
          // If a dummy end message exists, slice before it so we don't truncate inside it
          let contentToScan = content;
          const dummyPos = content.indexOf('"_id": "dummy-end-message"');
          if (dummyPos !== -1) {
            const dummyStart = content.lastIndexOf('{', dummyPos);
            if (dummyStart > commentsStartMatch.index) {
              contentToScan = content.substring(0, dummyStart);
            }
          }

          const lastCommentEnd = findLastCompleteCommentEnd(contentToScan);

          if (lastCommentEnd !== -1 && lastCommentEnd > commentsStartMatch.index) {
            let fd: number | null = null;
            try {
              fd = fs.openSync(chatFilePath, 'r+');
              fs.ftruncateSync(fd, Buffer.byteLength(content.substring(0, lastCommentEnd), 'utf8'));
            } finally {
              if (fd !== null) {
                try { fs.closeSync(fd); } catch (e) {}
              }
            }

            const validPart = content.substring(0, lastCommentEnd);
            for (const m of validPart.matchAll(/"_id":\s*"([^"]+)"/g)) {
              if (m[1] !== "dummy-end-message") {
                existingIds.add(m[1]);
              }
            }

            const validOffsets = [...validPart.matchAll(/"content_offset_seconds":\s*([\d.]+)/g)];
            if (validOffsets.length > 0) {
              recoveredOffset = parseFloat(validOffsets[validOffsets.length - 1][1]);
            }
            recoveredCommentsWritten = validOffsets.length;
            isRecovery = true;
            addLog(`[Chat Recovery] Found existing chat file. Resuming from offset ${recoveredOffset.toFixed(1)}s (${recoveredCommentsWritten} messages, ${existingIds.size} unique IDs).`);
          } else {
            const fallbackExtracted = extractChatCommentsFallback(contentToScan);
            const openCommentsEnd = commentsStartMatch.index + commentsStartMatch[0].length;
            if (fallbackExtracted && Array.isArray(fallbackExtracted.comments) && fallbackExtracted.comments.length > 0) {
              const headerPrefix = content.substring(0, openCommentsEnd);
              const rebuiltComments = fallbackExtracted.comments
                .map((c: any, idx: number) => (idx === 0 ? "\n    " : ",\n    ") + JSON.stringify(c))
                .join("");
              fs.writeFileSync(chatFilePath, headerPrefix + rebuiltComments, 'utf8');
              for (const c of fallbackExtracted.comments) {
                if (c._id && c._id !== "dummy-end-message") {
                  existingIds.add(c._id);
                }
              }
              const lastComment = fallbackExtracted.comments[fallbackExtracted.comments.length - 1];
              recoveredOffset = parseFloat(String(lastComment?.content_offset_seconds || 0));
              recoveredCommentsWritten = fallbackExtracted.comments.length;
              isRecovery = true;
              addLog(`[Chat Recovery] Reconstructed multi-segment chat file across mid-stream seal. Resuming from offset ${recoveredOffset.toFixed(1)}s (${recoveredCommentsWritten} messages, ${existingIds.size} unique IDs).`);
            } else {
              let fd: number | null = null;
              try {
                fd = fs.openSync(chatFilePath, 'r+');
                fs.ftruncateSync(fd, Buffer.byteLength(content.substring(0, openCommentsEnd), 'utf8'));
              } finally {
                if (fd !== null) {
                  try { fs.closeSync(fd); } catch (e) {}
                }
              }
              recoveredCommentsWritten = 0;
              isRecovery = true;
              addLog(`[Chat Recovery] Found existing chat file header without messages. Ready for recording.`);
            }
          }
        }
      } catch (e: any) {
        addLog(`[Chat Recovery Error] Failed to parse existing chat file: ${e.message}`);
      }
    }

    let chatStream = fs.createWriteStream(chatFilePath, { flags: isRecovery ? 'a' : 'w' });
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

    const headerObj = {
      FileInfo: {
        Version: { Major: 1, Minor: 5, Patch: 3 },
        CreatedAt: new Date().toISOString(),
        UpdatedAt: new Date().toISOString()
      },
      schemaVersion: "2.0-extended",
      streamer: { name: channelLogin, id: parseInt(twitchId, 10) || 0 },
      video: {
        title: state.activeDownloadSessions[channelLogin]?.currentTitle || "",
        description: "",
        id: streamId,
        created_at: startTime,
        start: 0,
        end: 0,
        length: 0,
        viewCount: 0,
        game: ""
      }
    };

    if (state.activeDownloadSessions[channelLogin]) {
      state.activeDownloadSessions[channelLogin].thirdPartyEmotes = thirdPartyEmotes;
      state.activeDownloadSessions[channelLogin].twitchId = twitchId;
    }

    let headerStr = JSON.stringify(headerObj, null, 2);
    headerStr = headerStr.replace('"end": 0,', '"end": 0       ,');
    headerStr = headerStr.replace('"length": 0', '"length": 0       ');
    headerStr = headerStr.replace(/}$/, ',\n  "comments": [\n');

    if (!isRecovery) {
      chatStream.write(headerStr);
    }

    const startTimestamp = new Date(startTime).getTime();
    const session = state.activeDownloadSessions[channelLogin];
    const currentVideoStartMs = session?.streamCreatedAtMs || session?.videoStartTimeMs || startTimestamp;
    const currentLiveOffset = Math.max(0, (Date.now() - currentVideoStartMs) / 1000.0);

    // If recovery, only backfill if there is a gap between recovered offset and current live offset (> 15s)
    // If fresh start, wait for user prompt decision if stream was already live > 2m
    const shouldAutoBackfill = isRecovery && ((currentLiveOffset - recoveredOffset) > 15);
    const awaitsUserChoice = !isRecovery && (currentLiveOffset > 120);
    let isBackfilling = shouldAutoBackfill;
    let liveBuffer: any[] = [];

    if (session) {
      session.isAwaitingBackfillChoice = awaitsUserChoice;
      session.liveChatBuffer = liveBuffer;
      session.chatExistingIds = existingIds;
    }

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
          let gapCount = 0;
          let gapBatchStr = "";
          for (const comment of result.backfillComments) {
            if (!existingIds.has(comment._id)) {
              if (state.activeDownloadSessions[channelLogin] && state.activeDownloadSessions[channelLogin].commentsWritten > 0) {
                gapBatchStr += ',\n    ';
              } else {
                gapBatchStr += '    ';
              }
              gapBatchStr += JSON.stringify(comment);
              if (state.activeDownloadSessions[channelLogin]) {
                state.activeDownloadSessions[channelLogin].commentsWritten++;
              }
              existingIds.add(comment._id);
              gapCount++;
            }
          }
          if (gapBatchStr) {
            chatStream.write(gapBatchStr);
          }
          addLog(`[Chat] Backfill appended ${gapCount} missing gap messages.`);
        }

        // Drain buffered live messages in order with a single batched write
        let liveCount = 0;
        let liveBatchStr = "";
        for (const comment of liveBuffer) {
          if (!existingIds.has(comment._id)) {
            if (state.activeDownloadSessions[channelLogin] && state.activeDownloadSessions[channelLogin].commentsWritten > 0) {
              liveBatchStr += ',\n    ';
            } else {
              liveBatchStr += '    ';
            }
            liveBatchStr += JSON.stringify(comment);
            if (state.activeDownloadSessions[channelLogin]) {
              state.activeDownloadSessions[channelLogin].commentsWritten++;
            }
            existingIds.add(comment._id);
            liveCount++;
          }
        }
        if (liveBatchStr) {
          chatStream.write(liveBatchStr);
        }
        addLog(`[Chat] Merged ${liveCount} buffered live messages. Seamless chat resume active.`);
        isBackfilling = false;
        liveBuffer = [];
      }).catch(err => {
        addLog(`[Chat] Backfill error: ${err.message}. Resuming normal live chat.`);
        let errBatchStr = "";
        for (const comment of liveBuffer) {
          if (!existingIds.has(comment._id)) {
            if (state.activeDownloadSessions[channelLogin] && state.activeDownloadSessions[channelLogin].commentsWritten > 0) {
              errBatchStr += ',\n    ';
            } else {
              errBatchStr += '    ';
            }
            errBatchStr += JSON.stringify(comment);
            if (state.activeDownloadSessions[channelLogin]) {
              state.activeDownloadSessions[channelLogin].commentsWritten++;
            }
            existingIds.add(comment._id);
          }
        }
        if (errBatchStr) {
          chatStream.write(errBatchStr);
        }
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

    // Companion Twitch PubSub WebSocket Client for Predictions, Polls, Pinned Messages, Channel Points, Hype Trains & Raids
    const lastPredictionTracker = new Map<string, { sig: string; ts: number; status: string }>();
    const lastPollTracker = new Map<string, { sig: string; ts: number; status: string }>();
    const activePinnedChatTracker = new Map<string, Record<string, any>>();
    let latestActivePinId: string | null = null;
    let activeHypeTrainState: Record<string, any> | null = null;
    const gifterSenderCountCache = new Map<string, number>();
    const rewardMetadataCache = new Map<string, { title: string; cost: number; prompt: string; background_color: string }>();
    const lastRoomState: {
      emote_only?: boolean;
      subs_only?: boolean;
      slow_seconds?: number;
      followers_only_minutes?: number;
      r9k?: boolean;
    } = {};

    function connectPubSubWebSocket() {
      const activeSession = state.activeDownloadSessions[channelLogin];
      if (!activeSession || activeSession.isStopped || !twitchId) {
        return;
      }

      if (activeSession.pubsubWs) {
        try {
          activeSession.pubsubWs.removeAllListeners();
          activeSession.pubsubWs.terminate();
        } catch (_) {}
        activeSession.pubsubWs = null;
      }

      let pubsubHeartbeat: NodeJS.Timeout | null = null;
      const clearPubsubHeartbeat = () => {
        if (pubsubHeartbeat) {
          clearInterval(pubsubHeartbeat);
          pubsubHeartbeat = null;
        }
        if (activeSession.pubsubHeartbeatInterval) {
          clearInterval(activeSession.pubsubHeartbeatInterval);
          activeSession.pubsubHeartbeatInterval = null;
        }
      };

      const pubWs = new WebSocket('wss://pubsub-edge.twitch.tv/v1');
      activeSession.pubsubWs = pubWs;

      const handlePubOpen = () => {
        const curSession = state.activeDownloadSessions[channelLogin];
        if (!curSession || curSession.isStopped) {
          clearPubsubHeartbeat();
          try { pubWs.terminate(); } catch (_) {}
          return;
        }

        const topics = [
          `predictions-channel-v1.${twitchId}`,
          `polls.${twitchId}`,
          `pinned-chat-updates-v1.${twitchId}`,
          `community-points-channel-v1.${twitchId}`,
          `hype-train-events-v1.${twitchId}`,
          `raid.${twitchId}`
        ];

        try {
          pubWs.send(JSON.stringify({
            type: "LISTEN",
            nonce: `vod_auto_${channelLogin}_${Date.now()}`,
            data: { topics }
          }));
          addLog(`[PubSub] Subscribed to live broadcast overlay events for @${channelLogin} (Predictions, Polls, Pinned Messages, Channel Points, Hype Trains, Raids).`);
        } catch (err: any) {
          addLog(`[PubSub] Failed to send LISTEN packet for @${channelLogin}: ${err.message}`);
        }

        clearPubsubHeartbeat();
        pubsubHeartbeat = setInterval(() => {
          const s = state.activeDownloadSessions[channelLogin];
          if (!s || s.isStopped || pubWs.readyState !== WebSocket.OPEN) {
            clearPubsubHeartbeat();
            return;
          }
          try {
            pubWs.send(JSON.stringify({ type: "PING" }));
          } catch (_) {}
        }, 210_000 + Math.floor(Math.random() * 15_000)); // ~3.5m keepalive
        activeSession.pubsubHeartbeatInterval = pubsubHeartbeat;
      };

      const handlePubMessage = (rawData: WebSocket.Data) => {
        const curSession = state.activeDownloadSessions[channelLogin];
        if (!curSession || curSession.isStopped) return;

        let packet: any;
        try {
          packet = JSON.parse(rawData.toString());
        } catch (_) {
          return;
        }

        if (packet.type === "RECONNECT") {
          addLog(`[PubSub] Server requested RECONNECT for @${channelLogin}. Cycling PubSub connection...`);
          try { pubWs.close(); } catch (_) {}
          return;
        }

        if (packet.type !== "MESSAGE" || !packet.data?.topic || !packet.data?.message) {
          return;
        }

        const topic: string = packet.data.topic;
        let inner: any;
        try {
          inner = JSON.parse(packet.data.message);
        } catch (_) {
          return;
        }

        const nowMs = Date.now();
        const offsetSec = computeOffsetSec(nowMs);

        // Topic 1: Predictions (predictions-channel-v1)
        if (topic.startsWith('predictions-channel-v1.')) {
          const ev = inner?.data?.event;
          if (!ev || !ev.id) return;

          const predId = String(ev.id);
          const status = String(ev.status || 'ACTIVE').toUpperCase();
          const outcomes = Array.isArray(ev.outcomes) ? ev.outcomes.map((o: any) => ({
            id: o.id,
            title: o.title,
            color: o.color,
            total_points: o.total_points || 0,
            total_users: o.total_users || 0,
            top_predictors: Array.isArray(o.top_predictors) ? o.top_predictors.slice(0, 5).map((tp: any) => ({
              user_id: tp.user_id,
              user_display_name: tp.user_display_name,
              points: tp.points
            })) : []
          })) : [];

          const sig = `${status}|${outcomes.map((o: any) => `${o.id}:${o.total_points}:${o.total_users}`).join(',')}`;
          const prev = lastPredictionTracker.get(predId);

          if (inner.type === 'event-updated' && status === 'ACTIVE' && prev) {
            if (prev.sig === sig || (nowMs - prev.ts) < 900) {
              return;
            }
          }

          let category = 'prediction_updated';
          if (inner.type === 'event-created' || !prev) {
            category = 'prediction_created';
            addLog(`[PubSub] Prediction started on @${channelLogin}: "${ev.title}" (${outcomes.map((o: any) => o.title).join(' vs ')})`);
          } else if (inner.type === 'event-locked' || (status === 'LOCKED' && prev.status !== 'LOCKED')) {
            category = 'prediction_locked';
            addLog(`[PubSub] Prediction locked on @${channelLogin}: "${ev.title}"`);
          } else if (status === 'RESOLVED' && prev.status !== 'RESOLVED') {
            category = 'prediction_resolved';
            const winner = outcomes.find((o: any) => o.id === ev.winning_outcome_id);
            addLog(`[PubSub] Prediction resolved on @${channelLogin}: "${ev.title}" -> Winner: "${winner?.title || ev.winning_outcome_id}"`);
          } else if ((status === 'CANCELED' || status === 'CANCELLED') && prev.status !== status) {
            category = 'prediction_canceled';
            addLog(`[PubSub] Prediction canceled on @${channelLogin}: "${ev.title}"`);
          }

          lastPredictionTracker.set(predId, { sig, ts: nowMs, status });

          appendBroadcastEvent(channelLogin, {
            _id: `pred-${predId}-${category}-${nowMs}`,
            created_at: new Date(nowMs).toISOString(),
            content_offset_seconds: offsetSec,
            source: 'pubsub',
            type: 'prediction',
            event_type: 'prediction',
            category,
            data: {
              pubsub_type: inner.type || 'event-updated',
              prediction_id: predId,
              title: ev.title || "",
              status,
              prediction_window_seconds: ev.prediction_window_seconds || 0,
              created_at: ev.created_at || new Date(nowMs).toISOString(),
              locked_at: ev.locked_at || null,
              ended_at: ev.ended_at || null,
              winning_outcome_id: ev.winning_outcome_id || null,
              outcomes
            }
          });
          return;
        }

        // Topic 2: Polls (polls.<twitchId>)
        if (topic.startsWith('polls.')) {
          const poll = inner?.data?.poll;
          if (!poll || !poll.poll_id) return;

          const pollId = String(poll.poll_id);
          const status = String(poll.status || 'ACTIVE').toUpperCase();
          const choices = Array.isArray(poll.choices) ? poll.choices.map((c: any) => ({
            choice_id: c.choice_id,
            title: c.title,
            total_voters: c.votes?.total ?? c.total_voters ?? 0,
            bits_votes: c.votes?.bits ?? 0,
            channel_points_votes: c.votes?.channel_points ?? 0
          })) : [];
          const totalVoters = choices.reduce((sum: number, c: any) => sum + (c.total_voters || 0), 0);

          const sig = `${status}|${choices.map((c: any) => `${c.choice_id}:${c.total_voters}`).join(',')}`;
          const prev = lastPollTracker.get(pollId);

          if (inner.type === 'POLL_UPDATE' && status === 'ACTIVE' && prev) {
            if (prev.sig === sig || (nowMs - prev.ts) < 900) {
              return;
            }
          }

          let category = 'poll_updated';
          if (inner.type === 'POLL_CREATE' || !prev) {
            category = 'poll_created';
            addLog(`[PubSub] Poll started on @${channelLogin}: "${poll.title}"`);
          } else if (inner.type === 'POLL_COMPLETE' || status === 'COMPLETED') {
            category = 'poll_completed';
            addLog(`[PubSub] Poll completed on @${channelLogin}: "${poll.title}"`);
          } else if (inner.type === 'POLL_ARCHIVE' || status === 'ARCHIVED') {
            category = 'poll_archived';
          } else if (inner.type === 'POLL_TERMINATE' || status === 'TERMINATED') {
            category = 'poll_terminated';
          }

          lastPollTracker.set(pollId, { sig, ts: nowMs, status });

          appendBroadcastEvent(channelLogin, {
            _id: `poll-${pollId}-${category}-${nowMs}`,
            created_at: new Date(nowMs).toISOString(),
            content_offset_seconds: offsetSec,
            source: 'pubsub',
            type: 'poll',
            event_type: 'poll',
            category,
            data: {
              pubsub_type: inner.type || 'POLL_UPDATE',
              poll_id: pollId,
              title: poll.title || "",
              status,
              duration_seconds: poll.duration_seconds || 0,
              started_at: poll.started_at || new Date(nowMs).toISOString(),
              ended_at: poll.ended_at || null,
              total_voters: totalVoters,
              choices
            }
          });
          return;
        }

        // Topic 3: Moderator / Streamer Pinned Messages (pinned-chat-updates-v1.<twitchId>)
        if (topic.startsWith('pinned-chat-updates-v1.')) {
          const d = inner?.data;
          if (!d) return;
          const rawAction = inner.type === 'unpin-message'
            ? 'unpin-message'
            : inner.type === 'update-message'
            ? 'update-message'
            : 'pin-message';
          const category = rawAction === 'unpin-message'
            ? 'unpin_message'
            : rawAction === 'update-message'
            ? 'update_pinned_message'
            : 'pin_message';

          const incomingPinId = d.id || d.pin_id || null;
          const pinId = String(incomingPinId || latestActivePinId || `pin-${nowMs}`);
          const prevPinState = activePinnedChatTracker.get(pinId) || (latestActivePinId ? activePinnedChatTracker.get(latestActivePinId) : undefined);

          const msgObj = d.message || {};
          if (category === 'pin_message') {
            addLog(`[PubSub] Message pinned on @${channelLogin} by ${d.pinned_by?.display_name || 'Moderator'}: "${msgObj.content?.text || ''}"`);
          }

          const hasSenderBadges = Array.isArray(msgObj.sender?.badges);
          const senderBadges = hasSenderBadges ? msgObj.sender.badges.map((b: any) => ({
            _id: b.id || b._id || b.setID || "",
            version: String(b.version || "1")
          })) : undefined;

          if (senderBadges && senderBadges.length > 0) {
            if (!curSession.usedTwitchBadges) {
              curSession.usedTwitchBadges = new Map<string, Set<string>>();
            }
            for (const b of senderBadges) {
              if (b._id && b.version) {
                if (!curSession.usedTwitchBadges.has(b._id)) {
                  curSession.usedTwitchBadges.set(b._id, new Set<string>());
                }
                curSession.usedTwitchBadges.get(b._id)!.add(b.version);
              }
            }
          }

          // Build delta fields only for properties actually present on this PubSub packet
          const deltaData: Record<string, any> = {
            action: rawAction,
            pin_id: pinId
          };

          const rawPinType = d.type || msgObj.type;
          if (rawPinType) {
            deltaData.type = rawPinType;
            deltaData.pin_type = rawPinType;
          } else if (!prevPinState && category === 'pin_message') {
            deltaData.type = 'MOD_PIN';
            deltaData.pin_type = 'MOD_PIN';
          }

          if (msgObj.id !== undefined) deltaData.message_id = msgObj.id;
          if (msgObj.content?.text !== undefined) deltaData.message_text = msgObj.content.text;
          if (msgObj.sender?.id !== undefined) deltaData.sender_id = msgObj.sender.id;
          if (msgObj.sender?.display_name !== undefined) deltaData.sender_display_name = msgObj.sender.display_name;
          if (msgObj.sender !== undefined) {
            deltaData.sender_color = msgObj.sender.chat_color || null;
          }
          if (senderBadges !== undefined) deltaData.sender_badges = senderBadges;
          if (d.pinned_by?.id !== undefined) deltaData.pinned_by_id = d.pinned_by.id;
          if (d.pinned_by?.display_name !== undefined) deltaData.pinned_by_display_name = d.pinned_by.display_name;
          if (msgObj.starts_at !== undefined || d.starts_at !== undefined) {
            deltaData.starts_at = msgObj.starts_at ?? d.starts_at;
          } else if (!prevPinState && category === 'pin_message') {
            deltaData.starts_at = Math.floor(nowMs / 1000);
          }
          if (msgObj.ends_at !== undefined || d.ends_at !== undefined) {
            deltaData.ends_at = msgObj.ends_at ?? d.ends_at;
          }
          if (msgObj.updated_at !== undefined || d.updated_at !== undefined) {
            deltaData.updated_at = msgObj.updated_at ?? d.updated_at;
          } else {
            deltaData.updated_at = Math.floor(nowMs / 1000);
          }
          if (d.pinned_by) {
            deltaData.pinned_by = {
              id: d.pinned_by.id,
              display_name: d.pinned_by.display_name
            };
          }
          if (d.unpinned_by) {
            deltaData.unpinned_by = {
              id: d.unpinned_by.id,
              display_name: d.unpinned_by.display_name
            };
          }

          const mergedData: Record<string, any> = prevPinState
            ? { ...prevPinState, ...deltaData }
            : deltaData;

          // Keep nested message object synchronized with merged fields if message details exist
          if (mergedData.message_id || msgObj.id || prevPinState?.message) {
            const prevMsg = prevPinState?.message || {};
            const prevSender = prevMsg.sender || {};
            mergedData.message = {
              ...prevMsg,
              id: mergedData.message_id || prevMsg.id,
              ...(mergedData.message_text !== undefined ? { text: mergedData.message_text } : {}),
              ...(mergedData.sender_id || mergedData.sender_display_name || prevMsg.sender ? {
                sender: {
                  ...prevSender,
                  ...(mergedData.sender_id !== undefined ? { id: mergedData.sender_id } : {}),
                  ...(mergedData.sender_display_name !== undefined ? { display_name: mergedData.sender_display_name } : {}),
                  chat_color: mergedData.sender_color !== undefined ? mergedData.sender_color : (prevSender.chat_color ?? null),
                  ...(mergedData.sender_badges !== undefined ? { badges: mergedData.sender_badges } : {})
                }
              } : {}),
              ...(mergedData.starts_at !== undefined ? { starts_at: mergedData.starts_at } : {}),
              ...(mergedData.ends_at !== undefined ? { ends_at: mergedData.ends_at } : {}),
              updated_at: mergedData.updated_at
            };
          }

          if (category === 'unpin_message') {
            activePinnedChatTracker.delete(pinId);
            if (latestActivePinId === pinId) {
              latestActivePinId = null;
            }
          } else {
            activePinnedChatTracker.set(pinId, mergedData);
            latestActivePinId = pinId;
          }

          appendBroadcastEvent(channelLogin, {
            _id: `pin-${pinId}-${category}-${nowMs}`,
            created_at: new Date(nowMs).toISOString(),
            content_offset_seconds: offsetSec,
            source: 'pubsub',
            type: 'pinned_chat',
            event_type: 'pinned_chat',
            category,
            action: rawAction,
            data: mergedData
          });
          return;
        }

        // Topic 4: Channel Points Redemptions (community-points-channel-v1.<twitchId>)
        if (topic.startsWith('community-points-channel-v1.')) {
          const redemption = inner?.data?.redemption;
          if (!redemption || !redemption.id) return;

          const rewardId = redemption.reward?.id || "";
          const rewardTitle = redemption.reward?.title || "";
          const rewardCost = redemption.reward?.cost || 0;
          const rewardPrompt = redemption.reward?.prompt || "";
          const rewardBgColor = redemption.reward?.background_color || "#9146FF";

          if (rewardId) {
            rewardMetadataCache.set(rewardId, {
              title: rewardTitle,
              cost: rewardCost,
              prompt: rewardPrompt,
              background_color: rewardBgColor
            });
          }

          appendBroadcastEvent(channelLogin, {
            _id: `cp-${redemption.id}`,
            created_at: redemption.redeemed_at || new Date(nowMs).toISOString(),
            content_offset_seconds: offsetSec,
            source: 'pubsub',
            type: 'channel_points',
            event_type: 'channel_points',
            category: 'channel_points_custom_reward_redemption',
            data: {
              redemption_id: redemption.id,
              user_id: redemption.user?.id || "",
              user_login: redemption.user?.login || "",
              user_display_name: redemption.user?.display_name || "",
              reward_id: rewardId,
              reward_title: rewardTitle,
              reward_cost: rewardCost,
              reward_prompt: rewardPrompt,
              reward_background_color: rewardBgColor,
              user_input: redemption.user_input || null,
              status: redemption.status || "FULFILLED",
              user: {
                id: redemption.user?.id || "",
                login: redemption.user?.login || "",
                display_name: redemption.user?.display_name || ""
              },
              reward: {
                id: rewardId,
                title: rewardTitle,
                prompt: rewardPrompt,
                cost: rewardCost,
                background_color: rewardBgColor
              }
            }
          });
          return;
        }

        // Topic 5: Hype Trains (hype-train-events-v1.<twitchId>)
        if (topic.startsWith('hype-train-events-v1.')) {
          const d = inner?.data || {};
          const rawType = String(inner?.type || 'hype-train-progression');
          const category = rawType.replace(/-/g, '_');

          const deltaTrain: Record<string, any> = {
            pubsub_type: rawType
          };

          const rawTrainId = d.id || d.progression?.id || d.train_id;
          if (rawTrainId) {
            deltaTrain.train_id = String(rawTrainId);
          }

          const rawLevel = d.progress?.level?.value ?? d.level;
          if (rawLevel !== undefined && rawLevel !== null) {
            deltaTrain.level = rawLevel;
          }

          const rawGoal = d.progress?.level?.goal ?? d.goal;
          if (rawGoal !== undefined && rawGoal !== null) {
            deltaTrain.goal = rawGoal;
          }

          const rawProgress = d.progress?.value ?? (typeof d.progress === 'number' ? d.progress : undefined) ?? d.value;
          if (rawProgress !== undefined && rawProgress !== null) {
            deltaTrain.progress = rawProgress;
          }

          const rawTotal = d.progress?.total ?? d.total;
          if (rawTotal !== undefined && rawTotal !== null) {
            deltaTrain.total = rawTotal;
          }

          if (d.started_at !== undefined) deltaTrain.started_at = d.started_at;
          if (d.expires_at !== undefined) {
            deltaTrain.expires_at = d.expires_at;
            deltaTrain.ends_at = d.expires_at;
          }
          if (d.ended_at !== undefined) {
            deltaTrain.ended_at = d.ended_at;
            deltaTrain.ends_at = d.ended_at;
          }
          if (d.is_golden_kappa_train !== undefined) {
            deltaTrain.is_golden_kappa = Boolean(d.is_golden_kappa_train);
          }
          if (d.source !== undefined && (d.user_id || d.user_login || d.user_display_name)) {
            deltaTrain.conductor = {
              source: d.source,
              user_id: d.user_id || null,
              user_login: d.user_login || null,
              user_display_name: d.user_display_name || null,
              participations: d.participations || null
            };
          }

          const mergedTrainData: Record<string, any> = activeHypeTrainState
            ? { ...activeHypeTrainState, ...deltaTrain }
            : deltaTrain;

          if (rawType === 'hype-train-end' || d.ended_at) {
            activeHypeTrainState = null;
          } else {
            activeHypeTrainState = mergedTrainData;
          }

          appendBroadcastEvent(channelLogin, {
            _id: `hypetrain-${mergedTrainData.train_id || d.channel_id || twitchId}-${category}-${nowMs}`,
            created_at: new Date(nowMs).toISOString(),
            content_offset_seconds: offsetSec,
            source: 'pubsub',
            type: 'hype_train',
            event_type: 'hype_train',
            category,
            data: mergedTrainData
          });
          return;
        }

        // Topic 6: Outgoing / Incoming Raid Updates (raid.<twitchId>)
        if (topic.startsWith('raid.')) {
          const r = inner?.raid;
          if (!r) return;
          const rawType = String(inner.type || 'raid_update_v2');

          appendBroadcastEvent(channelLogin, {
            _id: `raid-${r.id || nowMs}-${rawType}`,
            created_at: new Date(nowMs).toISOString(),
            content_offset_seconds: offsetSec,
            source: 'pubsub',
            type: 'raid',
            event_type: 'raid',
            category: rawType,
            data: {
              pubsub_type: rawType,
              raid_id: r.id || "",
              source_id: r.source_id || twitchId,
              target_id: r.target_id || "",
              target_login: r.target_login || "",
              target_display_name: r.target_display_name || "",
              viewer_count: r.viewer_count || 0
            }
          });
          return;
        }
      };

      const cleanupPubListeners = () => {
        clearPubsubHeartbeat();
        pubWs.removeListener('open', handlePubOpen);
        pubWs.removeListener('message', handlePubMessage);
        pubWs.removeListener('close', handlePubClose);
        pubWs.removeListener('error', handlePubError);
      };

      const handlePubClose = () => {
        cleanupPubListeners();
        const curSession = state.activeDownloadSessions[channelLogin];
        if (curSession && !curSession.isStopped) {
          if (curSession.pubsubReconnectTimer) {
            clearTimeout(curSession.pubsubReconnectTimer);
          }
          curSession.pubsubReconnectTimer = setTimeout(() => {
            if (state.activeDownloadSessions[channelLogin] && !state.activeDownloadSessions[channelLogin].isStopped) {
              connectPubSubWebSocket();
            }
          }, 5000);
        }
      };

      const handlePubError = (err: any) => {
        addLog(`[PubSub] WebSocket notice for @${channelLogin}: ${err.message}`);
      };

      pubWs.on('open', handlePubOpen);
      pubWs.on('message', handlePubMessage);
      pubWs.on('close', handlePubClose);
      pubWs.on('error', handlePubError);
    }

    connectWebSocket();
    connectPubSubWebSocket();
  }

  /**
   * Resolves a pending backfill choice for live chat (Full VOD, Current Game Only, or No Backfill).
   * Ensures seamless ordering and zero duplicate messages.
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

    if (mode === 'none') {
      session.isAwaitingBackfillChoice = false;
      let liveCount = 0;
      let liveBatchStr = "";
      for (const comment of liveBuffer) {
        if (!existingIds.has(comment._id)) {
          if (session.commentsWritten > 0 || liveCount > 0) {
            liveBatchStr += ',\n    ';
          } else {
            liveBatchStr += '    ';
          }
          liveBatchStr += JSON.stringify(comment);
          session.commentsWritten++;
          existingIds.add(comment._id);
          liveCount++;
        }
      }
      if (liveBatchStr) {
        chatStream.write(liveBatchStr);
      }
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

        let gapCount = 0;
        for (const comment of result.backfillComments) {
          if (!existingIds.has(comment._id)) {
            if (session.commentsWritten > 0) {
              chatStream.write(',\n');
            }
            chatStream.write(JSON.stringify(comment));
            session.commentsWritten++;
            existingIds.add(comment._id);
            gapCount++;
          }
        }
        addLog(`[Chat] Backfill appended ${gapCount} messages from VOD.`);

        // Immediately generate paired standalone VOD backfill chat JSON directly from backfill comments
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

          let streamerId = 0;
          if (session.twitchId) {
            streamerId = parseInt(String(session.twitchId), 10) || 0;
          }
          if (!streamerId && session.chatFilePath && fs.existsSync(session.chatFilePath)) {
            try {
              const head = fs.readFileSync(session.chatFilePath, 'utf8').slice(0, 4096);
              const m = head.match(/"streamer"\s*:\s*\{[^}]*"id"\s*:\s*"?(\d+)"?/);
              if (m && m[1]) {
                streamerId = parseInt(m[1], 10) || 0;
              }
            } catch (_) {}
          }

          const standalonePayload: any = {
            FileInfo: {
              Version: { Major: 1, Minor: 5, Patch: 3 },
              CreatedAt: new Date().toISOString(),
              UpdatedAt: new Date().toISOString()
            },
            streamer: {
              name: channelLogin,
              id: streamerId
            },
            comments: standaloneComments,
            video: {
              title: session.currentTitle || "",
              description: "",
              id: session.streamId || "",
              created_at: session.startTime || new Date(broadcastStartMs).toISOString(),
              start: 0,
              end: standaloneDuration,
              length: standaloneDuration,
              viewCount: 0,
              game: vodGameName || ""
            },
            embeddedData: {
              thirdParty: session.thirdPartyEmotes || [],
              firstParty: [],
              twitchBadges: []
            }
          };

          if (session.thirdPartyEmotes) {
            standalonePayload.emotes = session.thirdPartyEmotes;
          }

          await populateEmbeddedDataForChat(standalonePayload, channelLogin, streamerId);

          await fs.promises.writeFile(vodOutChatPath, JSON.stringify(standalonePayload, null, 2), 'utf8');
          addLog(`[VOD Chat] Successfully generated standalone paired chat: ${vodJsonOutputName} (${standaloneComments.length} messages, duration: ${standaloneDuration}s, streamer.id: ${streamerId}).`);

          // In Chat-Only mode, backfillVod is not invoked, so surface completion task & auto-render directly here
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
      let liveCount = 0;
      let liveBatchStr = "";
      for (const comment of liveBuffer) {
        if (!existingIds.has(comment._id)) {
          if (comment.created_at && broadcastStartMs) {
            const t = new Date(comment.created_at).getTime();
            comment.content_offset_seconds = Math.max(0, (t - broadcastStartMs) / 1000.0);
          }
          if (session.commentsWritten > 0 || liveCount > 0) {
            liveBatchStr += ',\n    ';
          } else {
            liveBatchStr += '    ';
          }
          liveBatchStr += JSON.stringify(comment);
          session.commentsWritten++;
          existingIds.add(comment._id);
          liveCount++;
        }
      }
      if (liveBatchStr) {
        chatStream.write(liveBatchStr);
      }
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
