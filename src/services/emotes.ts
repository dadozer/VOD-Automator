import axios from "axios";
import { postTwitchGql } from "./twitch";

export interface ThirdPartyEmote {
  api: number;
  id: string;
  name: string;
  imageScale: number;
  width: number;
  height: number;
  isZeroWidth: boolean;
}

export interface FirstPartyEmoteEmbed {
  id: string;
  imageScale: number;
  data: string;
  name: string;
  url: string;
  width: number;
  height: number;
  isZeroWidth: boolean;
}

export interface TwitchBadgeVersionData {
  title: string;
  description: string;
  bytes: string;
  url: string;
}

export interface TwitchBadgeEmbed {
  name: string;
  versions: Record<string, TwitchBadgeVersionData>;
}

const firstPartyEmoteCache = new Map<string, FirstPartyEmoteEmbed>();
const badgeImageBase64Cache = new Map<string, string>();
const channelBadgeCatalogCache = new Map<string, {
  fetchedAt: number;
  badges: Map<string, Map<string, { title: string; description: string; url: string }>>;
}>();

function parseImageDimensions(buf: Buffer, defaultDim: number): { width: number; height: number } {
  try {
    // PNG: 8-byte signature followed by IHDR chunk (width at offset 16, height at offset 20)
    if (
      buf.length >= 24 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    ) {
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      if (width > 0 && height > 0 && width <= 4096 && height <= 4096) {
        return { width, height };
      }
    }
    // GIF: 'GIF87a' or 'GIF89a' (width at offset 6, height at offset 8, little-endian)
    if (
      buf.length >= 10 &&
      buf[0] === 0x47 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46
    ) {
      const width = buf.readUInt16LE(6);
      const height = buf.readUInt16LE(8);
      if (width > 0 && height > 0 && width <= 4096 && height <= 4096) {
        return { width, height };
      }
    }
    // WebP: 'RIFF' ... 'WEBP'
    if (
      buf.length >= 30 &&
      buf.toString("ascii", 0, 4) === "RIFF" &&
      buf.toString("ascii", 8, 12) === "WEBP"
    ) {
      const chunkHeader = buf.toString("ascii", 12, 16);
      if (chunkHeader === "VP8X" && buf.length >= 30) {
        const width = 1 + buf.readUIntLE(24, 3);
        const height = 1 + buf.readUIntLE(27, 3);
        if (width > 0 && height > 0) return { width, height };
      } else if (chunkHeader === "VP8L" && buf.length >= 25) {
        const b0 = buf[21];
        const b1 = buf[22];
        const b2 = buf[23];
        const b3 = buf[24];
        const width = 1 + (((b1 & 0x3f) << 8) | b0);
        const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        if (width > 0 && height > 0) return { width, height };
      }
    }
  } catch (_) {}
  return { width: defaultDim, height: defaultDim };
}

async function fetchSingleFirstPartyEmote(id: string, name: string): Promise<FirstPartyEmoteEmbed | null> {
  const cached = firstPartyEmoteCache.get(id);
  if (cached) {
    return { ...cached, name: name || cached.name };
  }

  for (const scale of [2, 1]) {
    const url = `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/${scale}.0`;
    try {
      const res = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 6000
      });
      const buf = Buffer.from(res.data);
      if (buf.length > 0) {
        const defaultPx = 28 * scale;
        const { width: pxW, height: pxH } = parseImageDimensions(buf, defaultPx);
        const embed: FirstPartyEmoteEmbed = {
          id,
          imageScale: scale,
          data: buf.toString("base64"),
          name: name || id,
          url,
          width: Math.max(1, Math.round(pxW / scale)),
          height: Math.max(1, Math.round(pxH / scale)),
          isZeroWidth: false
        };
        firstPartyEmoteCache.set(id, embed);
        return embed;
      }
    } catch (_) {
      // Try next scale if 2.0 fails
    }
  }
  return null;
}

export function extractUsedEmotesAndBadgesFromComments(
  comments: any[],
  events?: any[],
  existingEmoteMap?: Map<string, string>,
  existingBadgeMap?: Map<string, Set<string>>
): {
  emoteMap: Map<string, string>;
  badgeMap: Map<string, Set<string>>;
} {
  const emoteMap = existingEmoteMap || new Map<string, string>();
  const badgeMap = existingBadgeMap || new Map<string, Set<string>>();

  if (Array.isArray(comments)) {
    for (const c of comments) {
      if (!c || c._id === "dummy-end-message") continue;
      const frags = c.message?.fragments;
      if (Array.isArray(frags)) {
        for (const f of frags) {
          const emoteId = f?.emoticon?.emoticon_id;
          if (emoteId && typeof emoteId === "string") {
            const emoteName = (typeof f.text === "string" && f.text.trim()) ? f.text.trim() : emoteId;
            if (!emoteMap.has(emoteId)) {
              emoteMap.set(emoteId, emoteName);
            }
          }
        }
      }
      const powerUpEmoteId = c.event_data?.power_up?.emote_id || c.user_notice_params?.["msg-param-emote-id"];
      if (powerUpEmoteId && typeof powerUpEmoteId === "string" && !emoteMap.has(powerUpEmoteId)) {
        emoteMap.set(powerUpEmoteId, powerUpEmoteId);
      }

      const badges = c.message?.user_badges;
      if (Array.isArray(badges)) {
        for (const b of badges) {
          const setId = b?._id;
          const version = b?.version !== undefined && b?.version !== null ? String(b.version) : "";
          if (setId && version) {
            if (!badgeMap.has(setId)) {
              badgeMap.set(setId, new Set<string>());
            }
            badgeMap.get(setId)!.add(version);
          }
        }
      }
    }
  }

  if (Array.isArray(events)) {
    for (const ev of events) {
      const senderBadges = ev?.data?.sender_badges || ev?.data?.message?.sender?.badges;
      if (Array.isArray(senderBadges)) {
        for (const b of senderBadges) {
          const setId = b?._id || b?.id || b?.setID;
          const version = b?.version !== undefined && b?.version !== null ? String(b.version) : "";
          if (setId && version) {
            if (!badgeMap.has(setId)) {
              badgeMap.set(setId, new Set<string>());
            }
            badgeMap.get(setId)!.add(version);
          }
        }
      }
    }
  }

  return { emoteMap, badgeMap };
}

export async function fetchFirstPartyEmotesFromMap(emoteMap: Map<string, string>): Promise<FirstPartyEmoteEmbed[]> {
  if (!emoteMap || emoteMap.size === 0) return [];
  const entries = Array.from(emoteMap.entries());
  const results: FirstPartyEmoteEmbed[] = [];
  const concurrency = 10;

  for (let i = 0; i < entries.length; i += concurrency) {
    const chunk = entries.slice(i, i + concurrency);
    const settled = await Promise.all(
      chunk.map(([id, name]) => fetchSingleFirstPartyEmote(id, name))
    );
    for (const item of settled) {
      if (item) results.push(item);
    }
  }
  return results;
}

async function getChannelBadgeCatalog(channelLogin: string, twitchId?: string | number) {
  const key = (channelLogin || String(twitchId || "global")).toLowerCase().trim();
  const cached = channelBadgeCatalogCache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < 30 * 60 * 1000) {
    return cached.badges;
  }

  const badgeCatalog = new Map<string, Map<string, { title: string; description: string; url: string }>>();
  const putBadge = (b: any) => {
    const setId = b?.setID;
    const version = b?.version !== undefined && b?.version !== null ? String(b.version) : "";
    const url = b?.image2x || b?.image1x || "";
    if (!setId || !version || !url) return;
    if (!badgeCatalog.has(setId)) {
      badgeCatalog.set(setId, new Map());
    }
    badgeCatalog.get(setId)!.set(version, {
      title: b.title || setId,
      description: b.description || "",
      url
    });
  };

  try {
    const cleanLogin = (channelLogin || "").replace(/^@/, "").trim().toLowerCase();
    const numericId = twitchId ? String(twitchId).trim() : "";
    const query = cleanLogin
      ? `query($login: String!) {
          badges { setID version title description image1x: imageURL(size: NORMAL) image2x: imageURL(size: DOUBLE) }
          user(login: $login) {
            broadcastBadges { setID version title description image1x: imageURL(size: NORMAL) image2x: imageURL(size: DOUBLE) }
          }
        }`
      : numericId && numericId !== "0"
      ? `query($id: ID!) {
          badges { setID version title description image1x: imageURL(size: NORMAL) image2x: imageURL(size: DOUBLE) }
          user(id: $id) {
            broadcastBadges { setID version title description image1x: imageURL(size: NORMAL) image2x: imageURL(size: DOUBLE) }
          }
        }`
      : `query {
          badges { setID version title description image1x: imageURL(size: NORMAL) image2x: imageURL(size: DOUBLE) }
        }`;

    const variables = cleanLogin
      ? { login: cleanLogin }
      : numericId && numericId !== "0"
      ? { id: numericId }
      : {};

    const res = await postTwitchGql({ query, variables });
    const globalBadges = res.data?.data?.badges;
    const channelBadges = res.data?.data?.user?.broadcastBadges;

    if (Array.isArray(globalBadges)) {
      for (const b of globalBadges) putBadge(b);
    }
    // Channel-specific badges override global badges (e.g. custom subscriber / bits badges)
    if (Array.isArray(channelBadges)) {
      for (const b of channelBadges) putBadge(b);
    }

    if (badgeCatalog.size > 0) {
      channelBadgeCatalogCache.set(key, { fetchedAt: Date.now(), badges: badgeCatalog });
    }
  } catch (_) {}

  return badgeCatalog;
}

export async function fetchTwitchBadgesFromMap(
  channelLogin: string,
  twitchId: string | number | undefined,
  badgeMap: Map<string, Set<string>>
): Promise<TwitchBadgeEmbed[]> {
  if (!badgeMap || badgeMap.size === 0) return [];

  const catalog = await getChannelBadgeCatalog(channelLogin, twitchId);
  if (catalog.size === 0) return [];

  const tasks: {
    setId: string;
    version: string;
    title: string;
    description: string;
    url: string;
  }[] = [];

  for (const [setId, versions] of badgeMap.entries()) {
    const catVersions = catalog.get(setId);
    if (!catVersions) continue;
    for (const ver of versions) {
      const meta = catVersions.get(ver);
      if (meta && meta.url) {
        tasks.push({
          setId,
          version: ver,
          title: meta.title,
          description: meta.description,
          url: meta.url
        });
      }
    }
  }

  if (tasks.length === 0) return [];

  const grouped = new Map<string, Record<string, TwitchBadgeVersionData>>();
  const concurrency = 10;

  for (let i = 0; i < tasks.length; i += concurrency) {
    const chunk = tasks.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (item) => {
        let base64 = badgeImageBase64Cache.get(item.url);
        if (!base64) {
          try {
            const res = await axios.get(item.url, {
              responseType: "arraybuffer",
              timeout: 6000
            });
            const buf = Buffer.from(res.data);
            if (buf.length > 0) {
              base64 = buf.toString("base64");
              badgeImageBase64Cache.set(item.url, base64);
            }
          } catch (_) {}
        }
        if (base64) {
          if (!grouped.has(item.setId)) {
            grouped.set(item.setId, {});
          }
          grouped.get(item.setId)![item.version] = {
            title: item.title,
            description: item.description,
            bytes: base64,
            url: item.url
          };
        }
      })
    );
  }

  const result: TwitchBadgeEmbed[] = [];
  for (const [name, versions] of grouped.entries()) {
    if (Object.keys(versions).length > 0) {
      result.push({ name, versions });
    }
  }
  return result;
}

export async function populateEmbeddedDataForChat(
  chatData: any,
  channelLogin?: string,
  twitchId?: string | number
): Promise<void> {
  if (!chatData) return;
  const login = channelLogin || chatData.streamer?.name || "";
  const id = twitchId || chatData.streamer?.id || 0;
  const comments = Array.isArray(chatData.comments) ? chatData.comments : [];
  const events = Array.isArray(chatData.events) ? chatData.events : [];

  const { emoteMap, badgeMap } = extractUsedEmotesAndBadgesFromComments(comments, events);
  const [firstParty, twitchBadges] = await Promise.all([
    fetchFirstPartyEmotesFromMap(emoteMap),
    fetchTwitchBadgesFromMap(login, id, badgeMap)
  ]);

  const existingThirdParty = chatData.embeddedData?.thirdParty || chatData.emotes || [];
  chatData.embeddedData = {
    thirdParty: existingThirdParty,
    firstParty,
    twitchBadges
  };
}

export async function fetchThirdPartyEmotes(twitchId: string): Promise<ThirdPartyEmote[]> {
  const thirdPartyEmotes: ThirdPartyEmote[] = [];
  
  const pushEmote = (api: number, id: string, name: string, isZeroWidth: boolean = false) => {
    thirdPartyEmotes.push({ api, id, name, imageScale: 1, width: 0, height: 0, isZeroWidth });
  };

  try {
    const [bttvGlobal, bttvChannel, ffzGlobal, ffzChannel, stvGlobal, stvChannel] = await Promise.allSettled([
      axios.get("https://api.betterttv.net/3/cached/emotes/global", { timeout: 5000 }),
      axios.get(`https://api.betterttv.net/3/cached/users/twitch/${twitchId}`, { timeout: 5000 }),
      axios.get("https://api.frankerfacez.com/v1/set/global", { timeout: 5000 }),
      axios.get(`https://api.frankerfacez.com/v1/room/id/${twitchId}`, { timeout: 5000 }),
      axios.get("https://7tv.io/v3/emote-sets/global", { timeout: 5000 }),
      axios.get(`https://7tv.io/v3/users/twitch/${twitchId}`, { timeout: 5000 })
    ]);

    if (bttvGlobal.status === "fulfilled") bttvGlobal.value.data.forEach((e: any) => pushEmote(1, e.id, e.code));
    if (bttvChannel.status === "fulfilled") {
      if (bttvChannel.value.data.channelEmotes) bttvChannel.value.data.channelEmotes.forEach((e: any) => pushEmote(1, e.id, e.code));
      if (bttvChannel.value.data.sharedEmotes) bttvChannel.value.data.sharedEmotes.forEach((e: any) => pushEmote(1, e.id, e.code));
    }

    if (ffzGlobal.status === "fulfilled") {
      const sets = ffzGlobal.value.data.sets;
      for (const set in sets) sets[set].emoticons.forEach((e: any) => pushEmote(2, e.id.toString(), e.name));
    }
    if (ffzChannel.status === "fulfilled") {
      const sets = ffzChannel.value.data.sets;
      for (const set in sets) sets[set].emoticons.forEach((e: any) => pushEmote(2, e.id.toString(), e.name));
    }

    if (stvGlobal.status === "fulfilled") stvGlobal.value.data.emotes.forEach((e: any) => pushEmote(3, e.id, e.name, !!e.flags));
    if (stvChannel.status === "fulfilled") {
      const stvSet = stvChannel.value.data.emote_set;
      if (stvSet && stvSet.emotes) stvSet.emotes.forEach((e: any) => pushEmote(3, e.id, e.name, !!e.flags));
    }
  } catch (e) {
    // Intentionally silent, error will bubble or be handled by consumer if needed.
    // Generally individual promise failure handles this.
  }

  return thirdPartyEmotes;
}

