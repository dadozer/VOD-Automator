import type {
  CaptureMode,
  ChatFileProfileInfo,
  Config,
  GameResolutionProfile,
  RecentFolderItem,
  Status,
} from "../types";

export class ApiClientError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });

  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const data = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const errMsg =
      (data && (data.error || data.message)) ||
      `Request failed (${res.status} ${res.statusText})`;
    throw new ApiClientError(errMsg, res.status);
  }

  return data as T;
}

export interface SpliceGamePayload {
  channel: string;
  action: "append_previous" | "extract_clip" | "split_new_part" | "await_next_game";
  clipScope?: "whole_game" | "custom_duration";
  clipMinutes?: number;
  leadingBufferMinutes?: number;
}

export interface TaskChatFilesResponse {
  files: string[];
  fileDetails: ChatFileProfileInfo[];
}

export interface TaskActionPayload {
  action: string;
  width?: number;
  height?: number;
  segments?: {
    filename: string;
    width: number;
    height: number;
  }[];
}

export const vodApi = {
  getStatus(): Promise<Status> {
    return requestJson<Status>("/api/status");
  },

  getConfig(): Promise<Config> {
    return requestJson<Config>("/api/config");
  },

  saveConfig(config: Config): Promise<Config> {
    return requestJson<Config>("/api/config", {
      method: "POST",
      body: JSON.stringify(config),
    });
  },

  startMonitoring(payload: { channel?: string; channels?: string[] }): Promise<{
    status: string;
    monitoredChannels?: string[];
  }> {
    return requestJson("/api/start", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  stopMonitoring(payload: { channel?: string }): Promise<{
    status: string;
    monitoredChannels?: string[];
  }> {
    return requestJson("/api/stop", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  forceStitch(channel: string): Promise<{ success: boolean }> {
    return requestJson("/api/force-stitch", {
      method: "POST",
      body: JSON.stringify({ channel }),
    });
  },

  openFolder(folderPath?: string): Promise<{
    success: boolean;
    folderPath: string;
    error?: string;
  }> {
    return requestJson("/api/open-folder", {
      method: "POST",
      body: JSON.stringify({ folderPath }),
    });
  },

  toggleSessionAutoRender(
    channel: string,
    enabled: boolean
  ): Promise<{
    success: boolean;
    channel: string;
    enabled: boolean;
    config: Config;
  }> {
    return requestJson(`/api/sessions/${encodeURIComponent(channel)}/auto-render`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    });
  },

  setSessionCaptureMode(
    channel: string,
    captureMode: CaptureMode
  ): Promise<{
    success: boolean;
    channel: string;
    mode: CaptureMode;
    config: Config;
  }> {
    return requestJson(`/api/sessions/${encodeURIComponent(channel)}/capture-mode`, {
      method: "POST",
      body: JSON.stringify({ mode: captureMode, captureMode }),
    });
  },

  saveGameProfile(payload: {
    gameName: string;
    width: number;
    height: number;
    remove?: boolean;
  }): Promise<{
    success: boolean;
    gameProfiles: GameResolutionProfile[];
    config: Config;
  }> {
    return requestJson("/api/game-profiles", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  getRecentFolders(): Promise<{ baseSavePath: string; folders: RecentFolderItem[] }> {
    return requestJson("/api/recent-folders");
  },

  recoverFolderVideo(folderPath: string): Promise<{
    success: boolean;
    taskId: string;
    folderPath: string;
    error?: string;
  }> {
    return requestJson("/api/recover-folder-video", {
      method: "POST",
      body: JSON.stringify({ folderPath }),
    });
  },

  spliceGame(payload: SpliceGamePayload): Promise<{ success: boolean; message?: string }> {
    return requestJson("/api/channels/splice-game", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  overrideBuffer(
    channel: string,
    gameIndex?: number
  ): Promise<{ success: boolean; message?: string }> {
    return requestJson("/api/channels/override-buffer", {
      method: "POST",
      body: JSON.stringify({ channel, gameIndex }),
    });
  },

  getTaskChatFiles(taskId: string): Promise<TaskChatFilesResponse> {
    return requestJson(`/api/tasks/${encodeURIComponent(taskId)}/chat-files`);
  },

  getChatFileProfile(filePath: string): Promise<{
    width: number;
    height: number;
    gameName?: string;
    matchedProfile?: string;
    isCustomProfile?: boolean;
  }> {
    return requestJson("/api/chat-file-profile", {
      method: "POST",
      body: JSON.stringify({ filePath }),
    });
  },

  dismissCompletedTasks(): Promise<{ success: boolean; count: number }> {
    return requestJson("/api/tasks/dismiss-completed", {
      method: "POST",
    });
  },

  runTaskAction(taskId: string, payload: TaskActionPayload): Promise<{ success: boolean }> {
    return requestJson(`/api/tasks/${encodeURIComponent(taskId)}/action`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  startManualRender(payload: {
    filePath: string;
    width: number;
    height: number;
  }): Promise<{ success: boolean; message?: string; error?: string }> {
    return requestJson("/api/render/manual", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  emergencyReset(): Promise<{ status: string }> {
    return requestJson("/api/reset", {
      method: "POST",
    });
  },
};
