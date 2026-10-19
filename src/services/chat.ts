import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import axios from "axios";
import { Parser } from "m3u8-parser";
import WebSocket from "ws";
import { state, addLog, updateTask, removeTask, resolveTdPath } from "./state";
import { getTwitchHeaders, twitchAxios, fetchRecentVods } from "./twitch";
import { fetchThirdPartyEmotes } from "./emotes";
import { ensureFfmpeg, getVideoDurationSeconds, checkVideoIsHevc } from "./ffmpeg";

export function parseIrcMessage(raw: string) {
  if (!raw.startsWith('@')) return null;
  
  const space1 = raw.indexOf(' ');
  const tagsPart = raw.substring(1, space1);
  const rest1 = raw.substring(space1 + 1);
  
  const space2 = rest1.indexOf(' ');
  const prefixPart = rest1.substring(1, space2);
  const rest2 = rest1.substring(space2 + 1);
  
  const space3 = rest2.indexOf(' ');
  const command = rest2.substring(0, space3);
  const rest3 = rest2.substring(space3 + 1);
  
  const space4 = rest3.indexOf(' :');
  let channel = "";
  let message = "";
  if (space4 !== -1) {
      channel = rest3.substring(0, space4);
      message = rest3.substring(space4 + 2);
  } else {
      channel = rest3;
  }
  
  const tags: Record<string, string> = {};
  tagsPart.split(';').forEach(t => {
    const [k, v] = t.split('=');
    tags[k] = v;
  });
  
  const username = prefixPart.split('!')[0];
  
  return { tags, username, command, channel, message };
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
      let cursor = "";
      let contentOffset = startOffset || 0.0;
      let pageCount = 0;
      let emptyOffsetJumps = 0;
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

        let args = `first: 100`;
        if (cursor && useCursor) {
          args += `, after: "${cursor}"`;
        } else {
          args += `, contentOffsetSeconds: ${Math.floor(contentOffset)}`;
        }

        let chatQuery: any;
        try {
          chatQuery = await twitchAxios.post("https://gql.twitch.tv/gql", {
            query: `query { video(id: "${vodId}") { comments(${args}) { edges { cursor node { id createdAt contentOffsetSeconds commenter { id login displayName } message { fragments { text emote { emoteID from } } userBadges { setID version } userColor } } } pageInfo { hasNextPage } } } }`
          }, { headers: getTwitchHeaders() });
        } catch (err: any) {
          addLog(`[Chat] Network error at offset ${contentOffset}: ${err.message}. Retrying...`);
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
              user_color: node.message.userColor || "#808080",
              user_notice_params: {}
            }
          };
          
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
        updateTask(taskId, "Downloading VOD Chat", `Downloaded ${commentsWritten} total messages. Finalizing JSON...`);
      }
      addLog(`[Chat] Finished downloading ${commentsWritten} messages.`);

      if (isBackfill) {
        return { backfillComments, commentsWritten, processedIds, videoLength };
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

      // 4. Construct Final JSON
      chatStream?.write('],"embeddedData":' + JSON.stringify({
        thirdParty: thirdPartyEmotes,
        firstParty: [],
        twitchBadges: []
      }) + '}');
      
      chatStream?.end();
      addLog(`[Chat] Successfully saved vod_chat.json to ${folderPath} (${commentsWritten} messages)`);
      updateTask(taskId, `VOD Chat Downloaded (${channelLogin})`, `Saved to ${folderPath}`, "success", false, [
        { label: "Render Chat", value: "render_chat" },
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
              if (commentObj && commentObj._id && commentObj._id !== "dummy-end-message" && !seenIds.has(commentObj._id)) {
                seenIds.add(commentObj._id);
                comments.push(commentObj);
              }
            } catch (_) {
              // Skip malformed comment
            }
          }
        }
      } else if (ch === ']' && braceDepth === 0) {
        break;
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
      streamer,
      video,
      comments,
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
  export function safeParseChatData(content: string): any {
    if (!content || !content.trim()) return null;

    // 1. Direct parse attempt
    try {
      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.comments)) {
        return parsed;
      }
    } catch (_) {}

    // 2. Clean truncation at last complete comment
    const lastEnd = findLastCompleteCommentEnd(content);
    if (lastEnd !== -1) {
      const sealed = content.substring(0, lastEnd) + '\n  ],\n  "embeddedData": null\n}';
      try {
        const parsed = JSON.parse(sealed);
        if (parsed && Array.isArray(parsed.comments)) {
          return parsed;
        }
      } catch (_) {}
    }

    // 3. Fallback extraction of individual comments
    return extractChatCommentsFallback(content);
  }

  /**
   * Validate and repair corrupted or concatenated chat JSON files.
   * Reconstructs a valid schema for TwitchDownloaderCLI and chat rendering.
   */
  export async function repairChatJsonFile(filePath: string): Promise<boolean> {
    if (!fs.existsSync(filePath)) return false;
    try {
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

      const cleanChatObj = safeParseChatData(raw);
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
      let data = safeParseChatData(raw);
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
         chatFile = files.find(f => f.endsWith('.json') && (f.startsWith('chat_') || f.startsWith('vod_chat'))) || "";
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

      if (syncOffset !== 0) {
        try {
          const chatDataRaw = await fs.promises.readFile(inputPath, 'utf8');
          let chatData: any = null;
          try {
            chatData = JSON.parse(chatDataRaw);
          } catch (jsonErr) {
            // If there was trailing content or malformed JSON, try repair first
            await repairChatJsonFile(inputPath);
            const repairedRaw = await fs.promises.readFile(inputPath, 'utf8');
            chatData = JSON.parse(repairedRaw);
          }

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
          const chatObj = safeParseChatData(rawChat);
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

      // Pre-flight check & sanitize the JSON file that TwitchDownloaderCLI will actually read
      await sanitizeChatJsonForRendering(renderInputPath);

      const segWidth = Math.max(100, Math.min(7680, parseInt(String(segment.width), 10) || 350));
      const segHeight = Math.max(100, Math.min(7680, parseInt(String(segment.height), 10) || 800));

      const messageColor = cr.messageColor || "#ffffff";
      const args = [
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
        args.push("-e", `${probedVideoDuration.toFixed(2)}s`);
        addLog(`[Render] Bound chat render ending to probed container duration: ${probedVideoDuration.toFixed(2)}s.`);
      }

      if (cr.updateRate) args.push("--update-rate", cr.updateRate.toString());
      if (cr.alternateBackgrounds) {
        args.push("--alternate-backgrounds");
        if (cr.altBackgroundColor) { args.push("--alt-background-color", cr.altBackgroundColor); }
      }
      if (cr.messageFontStyle && cr.messageFontStyle !== "normal") args.push("--message-fontstyle", cr.messageFontStyle);
      if (cr.usernameFontStyle && cr.usernameFontStyle !== "bold") args.push("--username-fontstyle", cr.usernameFontStyle);
      if (cr.outline) {
        args.push("--outline", "--outline-size", (cr.outlineSize || 4).toString());
      }
      if (cr.generateMask) args.push("--generate-mask");
      if (cr.bttv === false) args.push("--bttv=false");
      if (cr.ffz === false) args.push("--ffz=false");
      if (cr.stv === false) args.push("--stv=false");
      args.push(cr.giphy === false ? "--giphy=false" : "--giphy=true");
      if (cr.allowUnlistedEmotes === false) args.push("--allow-unlisted-emotes=false");
      if (cr.badges === false) args.push("--badges=false");
      if (cr.subMessages === false) args.push("--sub-messages=false");
      if (cr.dispersion) args.push("--dispersion");
      if (cr.offline) args.push("--offline");
      if (cr.avatars) args.push("--avatars");
      if (cr.readableColors === false) args.push("--readable-colors=false");
      if (cr.sharpening) args.push("--sharpening");
      if (cr.emojiVendor && cr.emojiVendor !== "notocolor") args.push("--emoji-vendor", cr.emojiVendor);
      
      if (cr.scaleEmote !== undefined && cr.scaleEmote !== 1.0) args.push("--scale-emote", cr.scaleEmote.toString());
      if (cr.scaleBadge !== undefined && cr.scaleBadge !== 1.0) args.push("--scale-badge", cr.scaleBadge.toString());
      if (cr.scaleEmoji !== undefined && cr.scaleEmoji !== 1.0) args.push("--scale-emoji", cr.scaleEmoji.toString());
      if (cr.scaleAvatar !== undefined && cr.scaleAvatar !== 1.0) args.push("--scale-avatar", cr.scaleAvatar.toString());
      if (cr.scaleVertical !== undefined) args.push("--scale-vertical", cr.scaleVertical.toString());
      else args.push("--scale-vertical", "0.5");
      if (cr.scaleSidePadding !== undefined && cr.scaleSidePadding !== 1.0) args.push("--scale-side-padding", cr.scaleSidePadding.toString());
      if (cr.scaleSectionHeight !== undefined && cr.scaleSectionHeight !== 1.0) args.push("--scale-section-height", cr.scaleSectionHeight.toString());
      if (cr.scaleWordSpace !== undefined && cr.scaleWordSpace !== 1.0) args.push("--scale-word-space", cr.scaleWordSpace.toString());
      if (cr.scaleEmoteSpace !== undefined && cr.scaleEmoteSpace !== 1.0) args.push("--scale-emote-space", cr.scaleEmoteSpace.toString());
      if (cr.scaleHighlightStroke !== undefined && cr.scaleHighlightStroke !== 1.0) args.push("--scale-highlight-stroke", cr.scaleHighlightStroke.toString());
      if (cr.scaleHighlightIndent !== undefined && cr.scaleHighlightIndent !== 1.0) args.push("--scale-highlight-indent", cr.scaleHighlightIndent.toString());

      if (cr.ignoreUsers) args.push("--ignore-users", cr.ignoreUsers);
      if (cr.bannedWords) args.push("--ban-words", cr.bannedWords);
      if (cr.badgeFilter !== undefined && cr.badgeFilter !== 0) args.push("--badge-filter", cr.badgeFilter.toString());

      if (cr.codec) {
        let outputArgs = "";
        switch (cr.codec) {
          case "hevc": outputArgs = `-c:v libx265 -preset:v veryfast -crf 18 -pix_fmt yuv420p "{save_path}"`; break;
          case "vp8": outputArgs = `-c:v libvpx -pix_fmt yuva420p -auto-alt-ref 0 -crf 18 -b:v 0 -deadline realtime -quality realtime -cpu-used 4 -threads 0 "{save_path}"`; break;
          case "vp9": outputArgs = `-c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -crf 24 -b:v 0 -deadline realtime -quality realtime -cpu-used 4 -row-mt 1 -threads 0 "{save_path}"`; break;
          case "prores": outputArgs = `-c:v prores_ks -profile:v 4 -qscale:v 20 -pix_fmt yuva444p10le -threads 0 -slices 8 "{save_path}"`; break;
          default: outputArgs = `-c:v libx264 -preset:v veryfast -crf 18 -pix_fmt yuv420p "{save_path}"`; break;
        }
        args.push(`--output-args=${outputArgs}`);
      }

      args.push("--skip-drive-waiting");

      const tdPath = resolveTdPath(state.config.tdPath);
      const tdDir = path.dirname(tdPath);
      
      const actualFfmpegPath = await ensureFfmpeg(tdPath, (msg) => {
        updateTask(taskId, `Rendering Chat (${chatFile})`, msg, "running", false, [{ label: "Cancel", value: "cancel_render" }]);
      });
      
      args.push("--ffmpeg-path", actualFfmpegPath);
      
      let success = false;
      let renderAttempt = 1;

      while (renderAttempt <= 3 && !success && !isTaskCancelled()) {
        let currentArgs = [...args];
        addLog(`[Render] Starting TwitchDownloaderCLI for ${chatFile} (Attempt ${renderAttempt}/3)...`);
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
                // Ensure complete error and debug output is preserved without truncation
                addLog(`[Render Complete Output]\n${completeOutput}`);
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

    const cr = (state.config.chatRender || {}) as any;
    const width = customWidth || cr.width || 350;
    const height = customHeight || cr.height || 800;

    addLog(`[Manual Render] Initiating manual render for ${filePath} (${width}x${height})...`);
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
            const openCommentsEnd = commentsStartMatch.index + commentsStartMatch[0].length;
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
      } catch (e: any) {
        addLog(`[Chat Recovery Error] Failed to parse existing chat file: ${e.message}`);
      }
    }

    let chatStream = fs.createWriteStream(chatFilePath, { flags: isRecovery ? 'a' : 'w' });
    
    if (state.activeDownloadSessions[channelLogin]) {
      state.activeDownloadSessions[channelLogin].chatStream = chatStream;
      state.activeDownloadSessions[channelLogin].chatFilePath = chatFilePath;
      state.activeDownloadSessions[channelLogin].commentsWritten = isRecovery ? recoveredCommentsWritten : 0;
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
        addLog(`[Chat] Connected to live chat for ${channelLogin}`);

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

          if (msg.includes(' PRIVMSG ')) {
            const parsed = parseIrcMessage(msg);
            if (!parsed) continue;

            const chatSentTs = parseInt(parsed.tags['tmi-sent-ts'] || Date.now().toString());
            const session = state.activeDownloadSessions[channelLogin];
            const startMs = (session && session.videoStartTimeMs) ? session.videoStartTimeMs : startTimestamp;
            let contentOffsetSeconds = (chatSentTs - startMs) / 1000.0;
            // Never have negative timestamps for chat unless it was sent before video start (which is possible if chat connects first)
            // But twitch ignores negative timestamps.
            if (contentOffsetSeconds < 0) contentOffsetSeconds = 0;

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
                     return `${Math.max(0, parseInt(start) - 8)}-${Math.max(0, parseInt(end) - 8)}`;
                   }).join(',');
                   shiftedEmotes.push(`${id}:${shiftedPositions}`);
                 }
                 emotesTag = shiftedEmotes.join('/');
              }
            }

            const tdComment = {
              _id: parsed.tags.id || `msg-${Date.now()}-${Math.random()}`,
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
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                logo: ""
              },
              source: "chat",
              state: "published",
              message: {
                body: msgBody,
                fragments: buildFragments(msgBody, emotesTag),
                is_action: isAction,
                user_badges: parseBadges(parsed.tags.badges || ""),
                user_color: parsed.tags.color || "#FFFFFF",
                user_notice_params: {}
              }
            };

            if (isBackfilling || state.activeDownloadSessions[channelLogin]?.isAwaitingBackfillChoice) {
              liveBuffer.push(tdComment);
            } else if (state.activeDownloadSessions[channelLogin]) {
              const currentSession = state.activeDownloadSessions[channelLogin];
              if (existingIds.has(tdComment._id)) {
                continue;
              }
              existingIds.add(tdComment._id);

              if (!currentSession.pendingChatWrites) {
                currentSession.pendingChatWrites = [];
              }
              currentSession.pendingChatWrites.push(tdComment);

              if (currentSession.pendingChatWrites.length >= 25) {
                flushPendingChatWrites(currentSession);
              } else if (!currentSession.chatFlushTimer) {
                currentSession.chatFlushTimer = setTimeout(() => {
                  currentSession.chatFlushTimer = null;
                  flushPendingChatWrites(currentSession);
                }, 1500);
              }
            }
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

    connectWebSocket();
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

          await fs.promises.writeFile(vodOutChatPath, JSON.stringify(standalonePayload, null, 2), 'utf8');
          addLog(`[VOD Chat] Successfully generated standalone paired chat: ${vodJsonOutputName} (${standaloneComments.length} messages, duration: ${standaloneDuration}s, streamer.id: ${streamerId}).`);
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
