import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Config } from "../types";

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

export const DEFAULT_TWITCH_BROWSER_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
export const LEGACY_TWITCH_BROWSER_CLIENT_ID = "kimne78kx3ncx6brs4h587w9fpb";

export function cleanChannelName(channel: string): string {
  if (!channel) return "";
  let cleaned = channel.toLowerCase().trim().replace(/^@/, "");
  try {
    const urlString = cleaned.startsWith("http") ? cleaned : `https://${cleaned}`;
    const url = new URL(urlString);
    if (url.hostname.includes("twitch.tv")) {
      cleaned = url.pathname.split("/").filter(Boolean)[0] || cleaned;
    }
  } catch {}
  cleaned = cleaned
    .replace(/^(https?:\/\/)?(www\.)?twitch\.tv\//, "")
    .split("?")[0]
    .replace(/\/$/, "")
    .replace(/[^a-z0-9_]/g, "");
  return cleaned.trim();
}

export function normalizeConfigSavePath(inputPath: unknown): string {
  if (!inputPath || typeof inputPath !== "string") {
    return "downloads";
  }
  const p = inputPath.trim();
  if (!p || p === "." || p === "./" || p === ".\\") {
    return "downloads";
  }

  // Self-heal legacy hardcoded NewDownloader directory
  if (p.toLowerCase().includes("newdownloader")) {
    return "downloads";
  }

  // Disallow escaping upward with ..
  if (p.includes("..")) {
    return "downloads";
  }

  if (path.isAbsolute(p)) {
    const rel = path.relative(PROJECT_ROOT, p);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel || "downloads";
    }
    if (!fs.existsSync(p) && path.basename(p).toLowerCase() === "downloads") {
      return "downloads";
    }
    if (path.basename(p).toLowerCase() === "downloads") {
      return "downloads";
    }
  }

  return p.replace(/^[./\\]+/, "");
}

export function resolveSavePathFromRoot(configuredPath?: string): string {
  const norm = normalizeConfigSavePath(configuredPath);
  return path.resolve(PROJECT_ROOT, norm);
}

export function resolveTdExecutablePath(configuredTdPath?: string): string {
  const raw = configuredTdPath?.trim();
  if (raw) {
    const candidate = path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
    if (fs.existsSync(candidate)) return candidate;
    const dir = path.dirname(candidate);
    const altChatRender = path.join(dir, process.platform === "win32" ? "ChatRenderCLI.exe" : "ChatRenderCLI");
    if (fs.existsSync(altChatRender)) return altChatRender;
  }

  const isWin = process.platform === "win32";
  const binNames = isWin
    ? ["ChatRenderCLI.exe", "TwitchDownloaderCLI.exe"]
    : ["ChatRenderCLI", "TwitchDownloaderCLI"];
  const searchDirs = [
    path.join(PROJECT_ROOT, "TwitchDownloader"),
    path.join(PROJECT_ROOT, "ChatRenderCLI"),
    PROJECT_ROOT,
    path.join(PROJECT_ROOT, "bin"),
    "C:\\TwitchDownloader",
    "C:\\ChatRenderCLI",
  ];
  for (const dir of searchDirs) {
    for (const bin of binNames) {
      const cand = path.join(dir, bin);
      if (fs.existsSync(cand)) return cand;
    }
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
  channelCaptureModes: {},
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
    gameProfiles: [],
    backgroundColor: "#111111",
    altBackgroundColor: "#191919",
    alternateBackgrounds: false,
    messageColor: "#ffffff",
    highlightUsers: "",
    highlightUserColor: "#C8FF0059",
    font: "Inter",
    fontSize: 24,
    messageFontStyle: "normal",
    usernameFontStyle: "bold",
    scaleUsername: 1.0,
    outline: false,
    outlineSize: 4,
    framerate: 60,
    updateRate: 0,
    jobs: 0,
    imageCacheMb: 256,
    generateMask: false,
    bttv: true,
    ffz: true,
    stv: true,
    giphy: true,
    gifMaxHeightPercent: 33,
    allowUnlistedEmotes: true,
    badges: true,
    subMessages: true,
    dispersion: "smart",
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
    badgeFilter: 0,
    autoCompensateClockDrift: true,
    predictionMode: "StickyTop",
    pollMode: "StickyTop",
    pinnedChatMode: "StickyTop",
    hypeTrainMode: "ChatScroll",
    moderationMode: "Strikethrough",
    moderationNotices: true,
    clearAll: false,
    roomstateNotices: true,
    replies: true,
    firstChatter: true,
    announcements: true,
    raids: true,
    channelPoints: true,
    hypeChat: true,
    powerUps: true,
    sharedChatBadge: true,
  },
};

export function normalizeGameSlug(name: string): string {
  return (name || "")
    .trim()
    .replace(/\s+Part\s+\d+$/i, "")
    .replace(/\s*\(Part\s+\d+[^)]*\)$/i, "")
    .replace(/[^a-z0-9]/gi, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

export function resolveChatRenderDimensionsForGame(
  config: Config,
  gameName?: string | null,
  filename?: string | null
): { width: number; height: number; matchedProfile?: string; isCustomProfile: boolean } {
  const defaultW = config.chatRender?.width || 350;
  const defaultH = config.chatRender?.height || 800;
  const profiles = Array.isArray(config.chatRender?.gameProfiles)
    ? config.chatRender!.gameProfiles!
    : [];

  if (profiles.length === 0) {
    return { width: defaultW, height: defaultH, isCustomProfile: false };
  }

  const rawGame = (gameName || "").trim();
  const strippedGame = rawGame
    .replace(/\s+Part\s+\d+$/i, "")
    .replace(/\s*\(Part\s+\d+[^)]*\)$/i, "")
    .trim();

  if (rawGame) {
    const exactMatch = profiles.find(
      (p) => p.gameName && p.gameName.trim().toLowerCase() === rawGame.toLowerCase()
    );
    if (exactMatch && exactMatch.width >= 100 && exactMatch.height >= 100) {
      return {
        width: exactMatch.width,
        height: exactMatch.height,
        matchedProfile: exactMatch.gameName.trim(),
        isCustomProfile: true,
      };
    }

    if (strippedGame && strippedGame.toLowerCase() !== rawGame.toLowerCase()) {
      const strippedMatch = profiles.find(
        (p) => p.gameName && p.gameName.trim().toLowerCase() === strippedGame.toLowerCase()
      );
      if (strippedMatch && strippedMatch.width >= 100 && strippedMatch.height >= 100) {
        return {
          width: strippedMatch.width,
          height: strippedMatch.height,
          matchedProfile: strippedMatch.gameName.trim(),
          isCustomProfile: true,
        };
      }
    }

    const targetSlug = normalizeGameSlug(rawGame);
    if (targetSlug) {
      const slugMatch = profiles.find(
        (p) => p.gameName && normalizeGameSlug(p.gameName) === targetSlug
      );
      if (slugMatch && slugMatch.width >= 100 && slugMatch.height >= 100) {
        return {
          width: slugMatch.width,
          height: slugMatch.height,
          matchedProfile: slugMatch.gameName.trim(),
          isCustomProfile: true,
        };
      }
    }
  }

  if (filename) {
    const base = path.basename(filename).replace(/\.json$/i, "").toLowerCase();
    const candidateSlug = base
      .replace(/^\d+_/, "")
      .replace(/^clip_/, "")
      .replace(/_vod_backfill.*$/, "")
      .replace(/_extension_\d{4}-\d{2}-\d{2}.*$/, "")
      .replace(/_\d+(?:\.\d+)?m_\d{4}-\d{2}-\d{2}.*$/, "")
      .replace(/_\d{4}-\d{2}-\d{2}.*$/, "")
      .replace(/_part_\d+$/, "")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");

    if (candidateSlug) {
      const fileMatch = profiles.find(
        (p) => p.gameName && normalizeGameSlug(p.gameName) === candidateSlug
      );
      if (fileMatch && fileMatch.width >= 100 && fileMatch.height >= 100) {
        return {
          width: fileMatch.width,
          height: fileMatch.height,
          matchedProfile: fileMatch.gameName.trim(),
          isCustomProfile: true,
        };
      }
    }
  }

  return { width: defaultW, height: defaultH, isCustomProfile: false };
}

export function resolveChatRenderDimensionsForChatFile(
  config: Config,
  chatFilePath: string,
  fallbackGameName?: string | null
): { width: number; height: number; gameName: string; matchedProfile?: string; isCustomProfile: boolean } {
  let detectedGame = (fallbackGameName || "").trim();
  const filename = path.basename(chatFilePath);

  const headerFallbackPath = chatFilePath
    ? path.join(path.dirname(chatFilePath), `session_chat_header_${filename}`)
    : "";
  const probeTarget =
    chatFilePath && fs.existsSync(chatFilePath)
      ? chatFilePath
      : headerFallbackPath && fs.existsSync(headerFallbackPath)
      ? headerFallbackPath
      : "";

  if (probeTarget) {
    try {
      const fd = fs.openSync(probeTarget, "r");
      try {
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
        const head = buf.toString("utf8", 0, bytesRead);
        const gameMatch = head.match(/"game"\s*:\s*"([^"]*)"/);
        if (gameMatch && gameMatch[1] && gameMatch[1].trim()) {
          detectedGame = gameMatch[1].trim();
        }
      } finally {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    } catch {}
  }

  const res = resolveChatRenderDimensionsForGame(config, detectedGame, filename);
  return {
    ...res,
    gameName: detectedGame || res.matchedProfile || "",
  };
}

export async function saveConfigToDiskAtomic(config: Config): Promise<Config> {
  const normalizedConfig: Config = {
    ...config,
    savePath: normalizeConfigSavePath(config.savePath),
  };
  const configStr = JSON.stringify(normalizedConfig, null, 2);
  const tempFile = `${CONFIG_FILE}.tmp`;
  try {
    await fs.promises.writeFile(tempFile, configStr, "utf-8");
    await fs.promises.rename(tempFile, CONFIG_FILE);
    await fs.promises.writeFile(CONFIG_BAK_FILE, configStr, "utf-8").catch(() => {});
    return normalizedConfig;
  } catch (err) {
    console.error("Failed to save config.json atomically", err);
    if (fs.existsSync(tempFile)) {
      await fs.promises.unlink(tempFile).catch(() => {});
    }
    throw err;
  }
}

export function loadConfigFromDisk(): Config {
  const configCandidatePaths = [
    CONFIG_FILE,
    CONFIG_BAK_FILE,
    path.join(process.cwd(), "config.json"),
    path.join(process.cwd(), "config.json.bak"),
  ];

  for (const candidate of configCandidatePaths) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, "utf-8").trim();
      if (!raw) continue;

      const configData = JSON.parse(raw);
      if (configData.browserClientId === LEGACY_TWITCH_BROWSER_CLIENT_ID) {
        configData.browserClientId = DEFAULT_TWITCH_BROWSER_CLIENT_ID;
      }
      const rawSavePath = configData.savePath;
      configData.savePath = normalizeConfigSavePath(configData.savePath);
      const merged: Config = {
        ...defaultConfig,
        ...configData,
        chatRender: {
          ...defaultConfig.chatRender!,
          ...(configData.chatRender || {}),
        },
      };

      if (merged.chatRender) {
        if (merged.chatRender.syncOffset === 0 || merged.chatRender.syncOffset === undefined) {
          merged.chatRender.syncOffset = -2.5;
        }
        if (merged.chatRender.syncOffsetHevc === undefined || merged.chatRender.syncOffsetHevc === 0) {
          merged.chatRender.syncOffsetHevc = -7.5;
        }
        if (merged.chatRender.giphy === undefined) {
          merged.chatRender.giphy = true;
        }
        if (merged.chatRender.dispersion === true) {
          merged.chatRender.dispersion = "on";
        } else if (merged.chatRender.dispersion === false) {
          merged.chatRender.dispersion = "off";
        } else if (
          merged.chatRender.dispersion !== "on" &&
          merged.chatRender.dispersion !== "off" &&
          merged.chatRender.dispersion !== "smart"
        ) {
          merged.chatRender.dispersion = "smart";
        }
        if (!Array.isArray(merged.chatRender.gameProfiles)) {
          merged.chatRender.gameProfiles = [];
        }
      }

      if (!merged.channelCaptureModes || typeof merged.channelCaptureModes !== "object") {
        merged.channelCaptureModes = {};
      }

      if (
        candidate !== CONFIG_FILE ||
        (typeof rawSavePath === "string" && rawSavePath.toLowerCase().includes("newdownloader")) ||
        rawSavePath !== configData.savePath
      ) {
        try {
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf-8");
          console.log(
            `[Config] Healed and synced configuration from ${candidate} to ${CONFIG_FILE} (savePath: "${merged.savePath}")`
          );
        } catch {}
      }

      return merged;
    } catch (err) {
      console.error(`Failed to parse config from ${candidate}`, err);
    }
  }

  return {
    ...defaultConfig,
    chatRender: { ...defaultConfig.chatRender! },
  };
}
