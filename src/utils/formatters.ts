import type { Config, GameResolutionProfile } from "../types";

export function formatBytes(bytes: number, decimals = 2): string {
  if (!bytes || bytes <= 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);

  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(seconds % 60)}s`;
}

export function formatDuration(seconds: number): string {
  const safe = Math.max(0, seconds || 0);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  return `${h > 0 ? `${h}:` : ""}${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function formatGraceCountdown(sec?: number): string {
  if (sec === undefined || sec <= 0) return "0m 00s";
  const mins = Math.floor(sec / 60);
  const remainingSec = Math.floor(sec % 60);
  return `${mins}m ${String(remainingSec).padStart(2, "0")}s`;
}

export function cleanChannel(channel: string): string {
  if (!channel) return "";
  let cleaned = channel.toLowerCase().trim().replace(/^@/, "");
  try {
    const urlString = cleaned.startsWith("http") ? cleaned : `https://${cleaned}`;
    const url = new URL(urlString);
    if (url.hostname.includes("twitch.tv")) {
      cleaned = url.pathname.split("/").filter(Boolean)[0] || cleaned;
    }
  } catch {
    // Ignore invalid URL parse; regex cleanup handles plain handles
  }
  cleaned = cleaned
    .replace(/^(https?:\/\/)?(www\.)?twitch\.tv\//, "")
    .split("?")[0]
    .replace(/\/$/, "")
    .replace(/[^a-z0-9_]/g, "");
  return cleaned.trim();
}

export function normalizeClientGameSlug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "");
}

export function resolveClientGameProfile(
  config: Config | null,
  gameName?: string | null
): {
  width: number;
  height: number;
  matchedProfile?: string;
  isCustomProfile: boolean;
} {
  const defaultW = config?.chatRender?.width || 350;
  const defaultH = config?.chatRender?.height || 800;
  const profiles: GameResolutionProfile[] = Array.isArray(config?.chatRender?.gameProfiles)
    ? config.chatRender.gameProfiles
    : [];
  if (!gameName || profiles.length === 0) {
    return { width: defaultW, height: defaultH, matchedProfile: undefined, isCustomProfile: false };
  }
  const cleanTarget = gameName.trim().toLowerCase();
  const baseTarget = cleanTarget.replace(/\s+part\s+\d+$/i, "").trim();
  const targetSlug = normalizeClientGameSlug(baseTarget);
  const match = profiles.find((p) => {
    const pName = (p.gameName || "").trim().toLowerCase();
    return (
      pName === cleanTarget ||
      pName === baseTarget ||
      (targetSlug.length > 0 && normalizeClientGameSlug(pName) === targetSlug)
    );
  });
  if (match) {
    return {
      width: match.width,
      height: match.height,
      matchedProfile: match.gameName,
      isCustomProfile: true,
    };
  }
  return { width: defaultW, height: defaultH, matchedProfile: undefined, isCustomProfile: false };
}
