export type CaptureMode = 'both' | 'video_only' | 'chat_only';

export interface GameResolutionProfile {
  gameName: string;
  width: number;
  height: number;
}

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
  channelCaptureModes?: Record<string, CaptureMode>;
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
    gameProfiles?: GameResolutionProfile[];
    backgroundColor: string;
    altBackgroundColor: string;
    alternateBackgrounds: boolean;
    messageColor: string;
    highlightUsers?: string;
    highlightUserColor?: string;
    font: string;
    fontSize: number;
    messageFontStyle: string;
    usernameFontStyle: string;
    scaleUsername?: number;
    outline: boolean;
    outlineSize: number;
    framerate: number;
    updateRate: number;
    jobs?: number;
    imageCacheMb?: number;
    generateMask: boolean;
    bttv: boolean;
    ffz: boolean;
    stv: boolean;
    giphy?: boolean;
    gifMaxHeightPercent?: number;
    allowUnlistedEmotes: boolean;
    badges: boolean;
    subMessages: boolean;
    dispersion: 'off' | 'on' | 'smart' | boolean;
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
    // v2.0-extended Overlay Widgets & Events (ChatRenderCLI)
    predictionMode?: 'StickyTop' | 'ChatScroll' | 'Off';
    pollMode?: 'StickyTop' | 'ChatScroll' | 'Off';
    pinnedChatMode?: 'StickyTop' | 'ChatScroll' | 'Off';
    hypeTrainMode?: 'StickyTop' | 'ChatScroll' | 'Off';
    // v2.0-extended Moderation & Roomstate
    moderationMode?: 'Strikethrough' | 'ReplaceDeleted' | 'Hide' | 'Off';
    moderationNotices?: boolean;
    clearAll?: boolean;
    roomstateNotices?: boolean;
    // v2.0-extended Enriched Chat Message Toggles
    replies?: boolean;
    firstChatter?: boolean;
    announcements?: boolean;
    raids?: boolean;
    channelPoints?: boolean;
    hypeChat?: boolean;
    powerUps?: boolean;
    sharedChatBadge?: boolean;
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
  isAwaitingNextGame?: boolean;
  customLeadingBufferMins?: number;
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
  initialJoinOffsetSec?: number;
  firstSeqNum?: number;
  streamCreatedAtMs?: number;
  gapAdjustments?: { atChunk: number; missingDurationSec: number }[];
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
  captureMode?: CaptureMode;
}

export interface ActiveDownloadSession {
  channel: string;
  streamId: string;
  twitchId?: string;
  startTime: string;
  streamCreatedAtMs?: number;
  initialJoinOffsetSec?: number;
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
  eventsFilePath?: string;
  chatWs?: any; // WebSocket
  chatReconnectTimer?: NodeJS.Timeout | null;
  chatHeartbeatInterval?: NodeJS.Timeout | null;
  pubsubWs?: any; // WebSocket (wss://pubsub-edge.twitch.tv/v1)
  pubsubReconnectTimer?: NodeJS.Timeout | null;
  pubsubHeartbeatInterval?: NodeJS.Timeout | null;
  isStopped?: boolean;
  commentsWritten: number;
  eventsWritten?: number;
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
  captureMode?: CaptureMode;
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
  eventExistingIds?: Set<string>;
  activeChatBackfillPromise?: Promise<void> | null;
}

export interface ChatBroadcastEvent {
  _id: string;
  created_at: string;
  content_offset_seconds: number;
  source?: 'irc' | 'pubsub';
  type?: string;
  event_type:
    | 'clearchat'
    | 'clearmsg'
    | 'roomstate'
    | 'prediction'
    | 'poll'
    | 'pinned_chat'
    | 'channel_points'
    | 'hype_train'
    | 'raid'
    | 'notice';
  category: string;
  action?: string;
  carried_over?: boolean;
  data: Record<string, any>;
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
    offlineGraceRemainingSeconds?: number;
    offlineGraceTotalSeconds?: number;
    folderPath?: string;
    currentTitle?: string;
    currentGame?: string;
    viewersCount?: number;
    previewImageUrl?: string;
    autoRenderChat?: boolean;
    captureMode?: CaptureMode;
    highestSeq?: number;
    commentsWritten?: number;
    eventsWritten?: number;
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
