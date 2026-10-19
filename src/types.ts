export interface Config {
  browserClientId: string;
  browserOAuthToken: string;
  channels: string[];
  savePath: string;
  notifyOnStart: boolean;
  notifyOnEnd: boolean;
  isMonitoring: boolean;
  autoStartMonitoring: boolean;
  autoRenderChat?: boolean;
  channelAutoRender?: Record<string, boolean>;
  gameSwitchBufferMins?: number;
  offlineGracePeriodMins?: number;
  longGameAutospliceEnabled?: boolean;
  longGameAutospliceTriggerHours?: number;
  longGameAutospliceCutHours?: number;
  tdPath?: string;
  chatRender?: {
    syncOffset?: number;
    syncOffsetHevc?: number;
    width: number;
    height: number;
    backgroundColor: string;
    altBackgroundColor: string;
    alternateBackgrounds: boolean;
    messageColor: string;
    font: string;
    fontSize: number;
    messageFontStyle: string;
    usernameFontStyle: string;
    outline: boolean;
    outlineSize: number;
    framerate: number;
    updateRate: number;
    generateMask: boolean;
    bttv: boolean;
    ffz: boolean;
    stv: boolean;
    giphy?: boolean;
    allowUnlistedEmotes: boolean;
    badges: boolean;
    subMessages: boolean;
    dispersion: boolean;
    offline: boolean;
    avatars: boolean;
    readableColors: boolean;
    sharpening: boolean;
    emojiVendor: string;
    scaleEmote: number;
    scaleBadge: number;
    scaleEmoji: number;
    scaleAvatar: number;
    scaleVertical: number;
    scaleSidePadding: number;
    scaleSectionHeight: number;
    scaleWordSpace: number;
    scaleEmoteSpace: number;
    scaleHighlightStroke: number;
    scaleHighlightIndent: number;
    ignoreUsers: string;
    bannedWords: string;
    format: string;
    codec: string;
    badgeFilter: number;
    autoCompensateClockDrift?: boolean;
  };
}

export interface SessionGame {
  gameName: string;
  startChunk: number;
  startTimeOffset: number;
  startTimeMs: number;
  isExported?: boolean;
  isTimeSplice?: boolean;
  isManualSplice?: boolean;
  overrideBuffer?: boolean;
  endChunk?: number;
}

export interface ActiveTask {
  id: string;
  name: string;
  progressText: string;
  status: 'running' | 'success' | 'error' | 'cancelled';
  actionRequired?: boolean;
  actions?: { label: string; value: string }[];
  createdAt?: number;
  completedAt?: number;
  streamId?: string;
  channelLogin?: string;
  folderPath?: string;
  cancelled?: boolean;
  games?: SessionGame[];
  targetGameIndex?: number;
  chatFilePath?: string;
  videoDurationSeconds?: number;
  vodId?: string;
  chapters?: any[];
  currentGameStartOffset?: number;
  chapterRawStartOffset?: number;
  currentGameName?: string;
  gameName?: string;
  vodMode?: 'full' | 'current_game' | 'none';
  vodStartOffsetSec?: number;
  customExportMode?: 'append_previous' | 'extract_clip' | 'split_new_part';
  customChunkRange?: { startIdx: number; endIdx: number };
  customOutputName?: string;
  customChatOutputName?: string;
  skipChunkCleanup?: boolean;
  expiresAt?: number;
  defaultAction?: string;
  autoCountdownSeconds?: number;
  preGapHighestSeq?: number;
  resumptionSeq?: number;
  missingChunkCount?: number;
}

export interface ActiveDownloadSession {
  channel: string;
  streamId: string;
  twitchId?: string;
  startTime: string;
  streamCreatedAtMs?: number;
  chunksDownloaded: number;
  folderPath: string;
  segmentsFile: string;
  currentTitle: string;
  currentGame: string;
  viewersCount: number;
  previewImageUrl: string;
  games?: SessionGame[];
  chatStream?: any; // fs.WriteStream
  chatFilePath?: string;
  chatWs?: any; // WebSocket
  chatReconnectTimer?: NodeJS.Timeout | null;
  chatHeartbeatInterval?: NodeJS.Timeout | null;
  isStopped?: boolean;
  commentsWritten: number;
  thirdPartyEmotes?: any[];
  mediaPlaylistUrl: string;
  playlistPollInterval: NodeJS.Timeout | null;
  isPollingActive?: boolean;
  lastPollTimestampMs?: number;
  isRefreshingPlaylist: boolean;
  highestSeq: number;
  videoDurationSeconds?: number;
  videoStartTimeMs?: number;
  missingCount?: number;
  offlineDetectedAtMs?: number;
  playlistConsecutiveErrors?: number;
  downloadedSegments: Set<string | number>;
  autoRenderChat?: boolean;
  isFmp4?: boolean;
  initSegmentDownloaded?: boolean;
  folderVerified?: boolean;
  pendingChatWrites?: any[];
  chatFlushTimer?: NodeJS.Timeout | null;
  lastStateSaveMs?: number;
  lastDiskCheckMs?: number;
  lastDiskWarningMs?: number;
  resumptionGap?: {
    detectedAt: number;
    preGapHighestSeq: number;
    resumptionSeq: number;
    missingChunkCount: number;
    estimatedMissingSec: number;
    currentGameIndex: number;
  };
  totalGapDurationSec?: number;
  gapAdjustments?: { atChunk: number; missingDurationSec: number }[];
  isResumingFromRestart?: boolean;
  lastRecoveryMessage?: string;
  firstChunkDurations?: number[];
  firstSeqNum?: number;
  isAwaitingBackfillChoice?: boolean;
  liveChatBuffer?: any[];
  chatExistingIds?: Set<string>;
  activeChatBackfillPromise?: Promise<void> | null;
}

export interface Status {
  isMonitoring: boolean;
  isLive: boolean;
  monitoredChannels?: string[];
  logs: string[];
  activeTasks: ActiveTask[];
  lastCheckTime: number | null;
  systemHealth?: {
    diskFree: number;
    diskTotal: number;
    memoryUsed: number;
    uptime: number;
  };
  activeSessions: {
    channel: string;
    streamId: string;
    startTime: string;
    chunksDownloaded: number;
    videoDurationSeconds: number;
    missingCount?: number;
    currentTitle?: string;
    currentGame?: string;
    viewersCount?: number;
    previewImageUrl?: string;
    autoRenderChat?: boolean;
    highestSeq?: number;
    commentsWritten?: number;
    games?: SessionGame[];
    pendingGameSwitch?: {
      gameIndex: number;
      previousGame: string;
      currentGame: string;
      secondsRemaining: number;
      totalBufferSeconds: number;
    };
  }[];
}
