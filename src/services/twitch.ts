import axios, { AxiosInstance } from "axios";
import { Parser } from "m3u8-parser";
import { state, addLog, DEFAULT_TWITCH_BROWSER_CLIENT_ID } from "./state";

let lastOAuth401WarningMs = 0;

export function getTwitchHeaders(includeAuth = true) {
  const headers: any = {
    "Client-ID": state.config.browserClientId || DEFAULT_TWITCH_BROWSER_CLIENT_ID,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Device-Id": "twitch-web-wall-mason"
  };
  if (includeAuth && state.config.browserOAuthToken) {
    const cleanToken = state.config.browserOAuthToken.replace("oauth:", "").trim();
    if (cleanToken) {
      headers["Authorization"] = `OAuth ${cleanToken}`;
    }
  }
  return headers;
}

/**
 * Inspects an ISO-BMFF / CMAF initialization segment (init.mp4) buffer
 * to extract the video track codec FourCC (e.g. hev1, hvc1, avc1, av01) and pixel dimensions.
 */
export function inspectMp4InitBuffer(buf: Buffer): { codec?: string; width?: number; height?: number } {
  try {
    const videoCodecs = new Set(["hev1", "hvc1", "avc1", "avc3", "av01", "vp09"]);
    let searchOffset = 0;
    while (searchOffset < buf.length - 48) {
      const stsdIdx = buf.indexOf("stsd", searchOffset);
      if (stsdIdx === -1 || stsdIdx + 48 > buf.length) break;
      const codec = buf.toString("ascii", stsdIdx + 16, stsdIdx + 20);
      if (videoCodecs.has(codec)) {
        const width = buf.readUInt16BE(stsdIdx + 44);
        const height = buf.readUInt16BE(stsdIdx + 46);
        return { codec, width, height };
      }
      searchOffset = stsdIdx + 4;
    }
  } catch (_) {}
  return {};
}

/**
 * Twitch API Axios client configured with standard 10s request timeout
 */
export const twitchAxios: AxiosInstance = axios.create({
  timeout: 10000,
});

/**
 * Execute an HTTP request with exponential backoff retry on HTTP 429 (rate-limit)
 * and transient 5xx server errors (500, 502, 503, 504), up to maxRetries.
 */
export async function requestWithBackoff<T = any>(
  requestFn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelayMs?: number;
    description?: string;
  } = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  let delay = options.initialDelayMs ?? 1000;
  const description = options.description || "Twitch request";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (err: any) {
      const status = err.response?.status;
      const isRetryable = status === 429 || (status >= 500 && status < 600) || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';

      if (attempt < maxRetries && isRetryable) {
        addLog(`[Network] ${description} received ${status || err.code}. Retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 16000); // Exponential backoff capped at 16s
      } else {
        throw err;
      }
    }
  }

  throw new Error(`${description} failed after ${maxRetries} retries.`);
}

/**
 * Posts a GraphQL query to Twitch GQL. If a configured Browser OAuth Token is expired
 * or rejected with HTTP 401/403, automatically logs a warning and retries unauthenticated
 * so stream monitoring and recording never stall.
 */
export async function postTwitchGql(payload: any, timeoutMs = 10000) {
  const hasOAuth = Boolean(state.config.browserOAuthToken && state.config.browserOAuthToken.replace("oauth:", "").trim());
  try {
    return await twitchAxios.post("https://gql.twitch.tv/gql", payload, {
      headers: getTwitchHeaders(true),
      timeout: timeoutMs,
    });
  } catch (err: any) {
    const status = err.response?.status;
    if (hasOAuth && (status === 401 || status === 403)) {
      const now = Date.now();
      if (now - lastOAuth401WarningMs > 60000) {
        lastOAuth401WarningMs = now;
        addLog(
          `[Auth Warning] Browser OAuth Token was rejected by Twitch GQL (HTTP ${status}). Retrying unauthenticated — please update your Browser OAuth Token in Settings to restore 1440p QUAD_HD live stream access.`
        );
      }
      return await twitchAxios.post("https://gql.twitch.tv/gql", payload, {
        headers: getTwitchHeaders(false),
        timeout: timeoutMs,
      });
    }
    throw err;
  }
}

export const PLAYBACK_ACCESS_TOKEN_QUERY = `query PlaybackAccessToken($isLive: Boolean!, $login: String!, $isVod: Boolean!, $vodID: ID!, $playerType: String!) {
  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {
    value
    signature
  }
  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {
    value
    signature
  }
}`;

/**
 * Fallback stream status verification result.
 */
export interface FallbackLiveStreamResult {
  isLive: boolean | null; // true: live, false: confirmed offline, null: unconfirmed (network/server error)
  streamId?: string;
  channelId?: string;
  masterManifest?: string;
  error?: string;
}

/**
 * Fallback live stream check via PlaybackAccessToken and Usher HLS master manifest.
 * Used when Twitch's primary GraphQL user subgraph is failing, returning 503, or timing out.
 */
export async function checkLiveStreamFallback(channelLogin: string): Promise<FallbackLiveStreamResult> {
  try {
    const clientId = state.config.browserClientId || DEFAULT_TWITCH_BROWSER_CLIENT_ID;

    // 1. Fetch playback access token for live stream using direct query string (immune to hash cache invalidations)
    const tokenRes = await postTwitchGql(
      {
        operationName: "PlaybackAccessToken",
        query: PLAYBACK_ACCESS_TOKEN_QUERY,
        variables: {
          isLive: true,
          login: channelLogin,
          isVod: false,
          vodID: "",
          playerType: "site"
        }
      },
      6000
    );

    const tokenData = tokenRes.data?.data?.streamPlaybackAccessToken;
    if (!tokenData) {
      return { isLive: null, error: "Missing streamPlaybackAccessToken in response" };
    }

    let channelId = "";
    try {
      const parsed = JSON.parse(tokenData.value);
      if (parsed.channel_id) channelId = String(parsed.channel_id);
    } catch (e) {}

    // 2. Query Usher for live master playlist
    const usherUrl = `https://usher.ttvnw.net/api/channel/hls/${channelLogin}.m3u8?client_id=${clientId}&token=${encodeURIComponent(tokenData.value)}&sig=${tokenData.signature}&allow_source=true&allow_audio_only=true&fast_bread=true&supported_codecs=av1,h265,h264&platform=web`;

    try {
      const usherRes = await twitchAxios.get(usherUrl, { timeout: 6000 });
      if (usherRes.status === 200 && typeof usherRes.data === "string" && usherRes.data.includes("#EXTM3U")) {
        const broadcastIdMatch = usherRes.data.match(/BROADCAST-ID="([^"]+)"/);
        const streamId = broadcastIdMatch ? broadcastIdMatch[1] : undefined;
        return { isLive: true, streamId, channelId, masterManifest: usherRes.data };
      }
    } catch (usherErr: any) {
      if (usherErr.response?.status === 404) {
        // Usher 404 confirms the channel is truly offline
        return { isLive: false, channelId };
      }
      return { isLive: null, channelId, error: usherErr.message };
    }

    return { isLive: false, channelId };
  } catch (err: any) {
    return { isLive: null, error: err.message };
  }
}

/**
 * Check stream status and user ID for a Twitch channel login.
 */
export async function fetchChannelStreamStatus(channelLogin: string) {
  return requestWithBackoff(
    () =>
      postTwitchGql(
        {
          query: `query($login: String!) { user(login: $login) { id stream { id type title createdAt viewersCount game { name } previewImageURL(width: 320, height: 180) } } }`,
          variables: { login: channelLogin }
        },
        6000
      ),
    { maxRetries: 1, initialDelayMs: 1000, description: `Stream status check for ${channelLogin}` }
  );
}

/**
 * Check live stream ID for orphaned session detection.
 */
export async function checkChannelStreamId(channelLogin: string) {
  return requestWithBackoff(
    () =>
      postTwitchGql(
        {
          query: `query($login: String!) { user(login: $login) { stream { id } } }`,
          variables: { login: channelLogin }
        },
        6000
      ),
    { maxRetries: 1, initialDelayMs: 1000, description: `Check orphaned session for ${channelLogin}` }
  );
}

/**
 * Fetch playback access token and signature for either a live channel or an archived VOD.
 */
export async function getPlaybackAccessToken(params: {
  channelLogin?: string;
  vodId?: string;
  isLive: boolean;
}): Promise<{ value: string; signature: string }> {
  const { channelLogin = "", vodId = "", isLive } = params;

  // Attempt with 'site', then fallback to 'embed' if site returns no data
  const playerTypes = ["site", "embed"];
  let lastError: Error | null = null;

  for (const playerType of playerTypes) {
    try {
      const response = await requestWithBackoff(
        () =>
          postTwitchGql({
            operationName: "PlaybackAccessToken",
            query: PLAYBACK_ACCESS_TOKEN_QUERY,
            variables: {
              isLive,
              login: channelLogin,
              isVod: !isLive,
              vodID: vodId,
              playerType,
            }
          }),
        { description: `PlaybackAccessToken (${playerType}) for ${isLive ? channelLogin : `VOD ${vodId}`}` }
      );

      const tokenData = isLive
        ? response.data?.data?.streamPlaybackAccessToken
        : response.data?.data?.videoPlaybackAccessToken;

      if (tokenData && tokenData.value && tokenData.signature) {
        return tokenData;
      }
    } catch (err: any) {
      lastError = err;
    }
  }

  throw lastError || new Error(`Failed to obtain playback token for ${isLive ? channelLogin : `VOD ${vodId}`}`);
}

/**
 * Resolve master and highest-quality source media playlist URL for live stream or VOD.
 */
export async function getSourceMediaPlaylistUrl(params: {
  channelLogin?: string;
  vodId?: string;
  isLive: boolean;
}): Promise<string> {
  const { channelLogin = "", vodId = "", isLive } = params;
  const tokenData = await getPlaybackAccessToken(params);
  const clientId = state.config.browserClientId || DEFAULT_TWITCH_BROWSER_CLIENT_ID;

  const usherParams = `client_id=${clientId}&token=${encodeURIComponent(tokenData.value)}&sig=${tokenData.signature}&allow_source=true&allow_audio_only=true&fast_bread=true&supported_codecs=av1,h265,h264&platform=web`;
  const masterUrl = isLive
    ? `https://usher.ttvnw.net/api/channel/hls/${channelLogin}.m3u8?${usherParams}`
    : `https://usher.ttvnw.net/vod/${vodId}.m3u8?${usherParams}`;

  const masterResponse = await requestWithBackoff(
    () => twitchAxios.get(masterUrl),
    { description: `Usher master playlist for ${isLive ? channelLogin : `VOD ${vodId}`}` }
  );

  const parser = new Parser();
  parser.push(masterResponse.data);
  parser.end();

  const rawPlaylists: any[] = parser.manifest.playlists || [];
  const videoPlaylists = rawPlaylists.filter(
    (p: any) => p.attributes?.VIDEO !== "audio_only"
  );
  const candidates = videoPlaylists.length > 0 ? videoPlaylists : rawPlaylists;

  const isSourceTag = (pl: any): boolean =>
    pl.attributes?.VIDEO === "chunked" || Boolean(pl.uri?.includes("source"));

  const getPixelArea = (pl: any): number => {
    const w = pl.attributes?.RESOLUTION?.width || 0;
    const h = pl.attributes?.RESOLUTION?.height || 0;
    if (w > 0 && h > 0) return w * h;
    const videoAttr = String(pl.attributes?.VIDEO || "");
    const m = videoAttr.match(/(\d{3,4})p/);
    if (m) {
      const height = parseInt(m[1], 10);
      return Math.round((height * 16) / 9) * height;
    }
    if (isSourceTag(pl)) {
      return 1920 * 1080;
    }
    return 0;
  };

  candidates.sort((a: any, b: any) => {
    const areaDiff = getPixelArea(b) - getPixelArea(a);
    if (areaDiff !== 0) return areaDiff;
    const sourceDiff = (isSourceTag(b) ? 1 : 0) - (isSourceTag(a) ? 1 : 0);
    if (sourceDiff !== 0) return sourceDiff;
    const fpsDiff = (b.attributes?.["FRAME-RATE"] || 0) - (a.attributes?.["FRAME-RATE"] || 0);
    if (fpsDiff !== 0) return fpsDiff;
    return (b.attributes?.BANDWIDTH || 0) - (a.attributes?.BANDWIDTH || 0);
  });

  const selectedPlaylist = candidates[0];
  let resolvedUrl = selectedPlaylist?.uri;
  if (!resolvedUrl) {
    throw new Error(`No media playlists found in master manifest for ${isLive ? channelLogin : `VOD ${vodId}`}`);
  }

  const attr = selectedPlaylist.attributes || {};
  let videoLabel = attr.VIDEO || "source";
  let resLabel = attr.RESOLUTION ? `${attr.RESOLUTION.width}x${attr.RESOLUTION.height}` : "unknown-res";
  const fpsLabel = attr["FRAME-RATE"] ? `${Math.round(attr["FRAME-RATE"])}fps` : "";
  const mbpsLabel = attr.BANDWIDTH ? `${(attr.BANDWIDTH / 1000000).toFixed(2)} Mbps` : "";
  let codecsLabel = attr.CODECS ? `, codecs: ${attr.CODECS}` : "";
  const targetLabel = isLive ? `@${channelLogin}` : `VOD ${vodId}`;

  // Enhanced Broadcasting CloudFront VOD Upgrade:
  // When PlaybackAccessToken is unauthenticated, Usher strips 'chunked' (1440p60 HEVC) from the VOD master manifest
  // and caps the list at '1080p60'. However, CloudFront still hosts '/chunked/index-dvr.m3u8' publicly.
  if (
    !isLive &&
    videoLabel !== "chunked" &&
    resolvedUrl.includes("/1080p60/")
  ) {
    const chunkedCandidateUrl = resolvedUrl.replace("/1080p60/", "/chunked/");
    try {
      const probeRes = await twitchAxios.get(chunkedCandidateUrl, { timeout: 5000 });
      if (probeRes.status === 200 && typeof probeRes.data === "string" && probeRes.data.includes("#EXTM3U")) {
        resolvedUrl = chunkedCandidateUrl;
        videoLabel = "chunked (CloudFront 1440p60 upgrade)";
        resLabel = "2560x1440";
        codecsLabel = ", codecs: hev1/h265";
      }
    } catch (_) {
      // '/chunked/' tier does not exist or is not accessible; keep 1080p60
    }
  }

  addLog(
    `[Stream] Selected ${isLive ? "live" : "VOD"} media playlist for ${targetLabel}: ${videoLabel} (${[resLabel, fpsLabel, mbpsLabel].filter(Boolean).join(", ")}${codecsLabel})`
  );

  try {
    const parsedToken = JSON.parse(tokenData.value);
    const quadHdReasons: string[] = parsedToken?.maximum_resolution_reasons?.QUAD_HD || [];
    if (
      isLive &&
      attr.RESOLUTION &&
      attr.RESOLUTION.height < 1440 &&
      quadHdReasons.includes("AUTHZ_NOT_LOGGED_IN")
    ) {
      addLog(
        `[Stream Notice] Playback token maximum_resolution is ${parsedToken.maximum_resolution} (1440p QUAD_HD requires a valid logged-in Browser OAuth Token).`
      );
    }
  } catch (_) {}

  return resolvedUrl;
}

/**
 * Query recent archived videos for a Twitch channel.
 */
export async function fetchRecentVods(channelLogin: string, count = 5) {
  return requestWithBackoff(
    () =>
      postTwitchGql({
        query: `query($login: String!, $count: Int!) { user(login: $login) { id videos(first: $count, type: ARCHIVE) { edges { node { id title createdAt lengthSeconds broadcast { id } game { name } } } } } }`,
        variables: { login: channelLogin, count }
      }),
    { description: `Fetch recent VODs for ${channelLogin}` }
  );
}

/**
 * Fetch VOD game change moments / chapters using Twitch GQL.
 */
export async function fetchVodChapters(vodId: string): Promise<Array<{
  id: string;
  positionMilliseconds: number;
  durationMilliseconds: number;
  gameName: string;
}>> {
  try {
    const res = await requestWithBackoff(
      () =>
        postTwitchGql({
          operationName: "VideoPlayer_ChapterSelectButtonVideo",
          variables: {
            includePrivate: false,
            videoID: vodId
          },
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash: "71835d5ef425e154bf282453a926d99b328cdc5e32f36d3a209d0f4778b41203"
            }
          }
        }),
      { description: `Fetch VOD chapters for ${vodId}` }
    );

    const edges = res.data?.data?.video?.moments?.edges || [];
    return edges.map((edge: any) => {
      const node = edge.node;
      const gameName = node.details?.game?.displayName || node.description || "Unknown";
      return {
        id: node.id,
        positionMilliseconds: Number(node.positionMilliseconds || 0),
        durationMilliseconds: Number(node.durationMilliseconds || 0),
        gameName
      };
    });
  } catch (e: any) {
    addLog(`[Twitch GQL] Non-fatal error fetching VOD chapters for ${vodId}: ${e.message}`);
    return [];
  }
}

/**
 * Automatically fetch the CMAF fMP4 initialization segment (init.mp4)
 * from Twitch CDN for a given channel login and broadcast stream ID.
 */
export async function fetchInitSegmentFromTwitch(channelLogin: string, streamId: string): Promise<Buffer | null> {
  try {
    const vodRes = await fetchRecentVods(channelLogin, 10);
    const edges = vodRes.data?.data?.user?.videos?.edges || [];

    for (const edge of edges) {
      const vodId = edge.node.id;
      try {
        const playlistUrl = await getSourceMediaPlaylistUrl({ vodId, isLive: false });
        if (playlistUrl.includes(streamId)) {
          const res = await twitchAxios.get(playlistUrl, { timeout: 8000 });
          const mapMatch = res.data.match(/EXT-X-MAP:URI="([^"]+)"/);
          if (mapMatch) {
            const mapUri = mapMatch[1];
            const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
            const initUrl = mapUri.startsWith('http') ? mapUri : baseUrl + mapUri;
            const initRes = await twitchAxios.get(initUrl, { responseType: 'arraybuffer', timeout: 15000 });
            return Buffer.from(initRes.data);
          }
        }
      } catch (innerErr) {
        // Try next VOD
      }
    }
  } catch (err: any) {
    addLog(`[Twitch Warning] Failed to query init segment for @${channelLogin}: ${err.message}`);
  }
  return null;
}

