export type CaptureMode = 'both' | 'video_only' | 'chat_only';

export interface GameResolutionProfile {
  gameName: string;
  width: number;
  height: number;
}

export interface ChatRenderConfig {
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
  chatRender?: ChatRenderConfig;
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

export interface GapAdjustment {
  atChunk: number;
  missingDurationSec: number;
}

/**
 * Discriminated-union worker job specifications for the Deterministic Compilation Pipeline.
 * Separates execution payloads from read-only UI `ActiveTask` (`TaskView`) cards.
 */
export interface VodBackfillStitchJob {
  kind: 'vod_backfill';
  taskId: string;
  preserveTaskOnSuccess?: boolean;
  folderPath: string;
  channelLogin: string;
  vodId?: string;
  vodMode?: 'full' | 'current_game';
  vodStartOffsetSec?: number;
  vodAvgSegmentDuration?: number;
  gameName?: string;
  outputSuffix?: string;
  chatFilePath?: string;
  captureMode: CaptureMode;
}

export interface LiveSegmentStitchJob {
  kind: 'live_segment';
  taskId: string;
  preserveTaskOnSuccess?: boolean;
  folderPath: string;
  channelLogin: string;
  streamId?: string;
  captureMode: CaptureMode;
  isMidStreamExport?: boolean;
  games: SessionGame[];
  targetGameIndex?: number;
  gameName?: string;
  chatFilePath?: string;
  videoDurationSeconds?: number;
  initialJoinOffsetSec?: number;
  firstSeqNum?: number;
  streamCreatedAtMs?: number;
  gapAdjustments?: GapAdjustment[];
  customExportMode?: 'append_previous' | 'extract_clip' | 'split_new_part';
  customChunkRange?: { startIdx: number; endIdx: number };
  customOutputName?: string;
  customChatOutputName?: string;
  skipChunkCleanup?: boolean;
}

export interface FolderRecoveryStitchJob {
  kind: 'folder_recovery';
  taskId: string;
  preserveTaskOnSuccess?: boolean;
  folderPath: string;
  channelLogin?: string;
  captureMode?: CaptureMode;
  games?: SessionGame[];
  chatFilePath?: string;
  videoDurationSeconds?: number;
}

export type CompilationJobSpec =
  | VodBackfillStitchJob
  | LiveSegmentStitchJob
  | FolderRecoveryStitchJob;

export interface PromptActionContext {
  vodId?: string;
  chapters?: any[];
  currentGameStartOffset?: number;
  chapterRawStartOffset?: number;
  currentGameName?: string;
  preGapHighestSeq?: number;
  resumptionSeq?: number;
  missingChunkCount?: number;
}

export type TaskStatus = 'running' | 'success' | 'warning' | 'error' | 'cancelled';

export interface ActiveTask {
  id: string;
  name: string;
  progressText: string;
  status: TaskStatus;
  actionRequired?: boolean;
  actions?: { label: string; value: string }[];
  createdAt?: number;
  completedAt?: number;
  streamId?: string;
  channelLogin?: string;
  folderPath?: string;
  cancelled?: boolean;
  gameName?: string;
  currentGameName?: string;
  captureMode?: CaptureMode;
  expiresAt?: number;
  defaultAction?: string;
  autoCountdownSeconds?: number;
  // Typed compilation & prompt metadata (replaces overloaded loose IPC properties)
  retrySpec?: CompilationJobSpec;
  promptContext?: PromptActionContext;
  // Backward-compatible optional fields for persisted v5.x state.json tasks
  games?: SessionGame[];
  targetGameIndex?: number;
  chatFilePath?: string;
  videoDurationSeconds?: number;
  vodId?: string;
  chapters?: any[];
  currentGameStartOffset?: number;
  chapterRawStartOffset?: number;
  vodMode?: 'full' | 'current_game' | 'none';
  vodStartOffsetSec?: number;
  initialJoinOffsetSec?: number;
  firstSeqNum?: number;
  streamCreatedAtMs?: number;
  gapAdjustments?: GapAdjustment[];
  customExportMode?: 'append_previous' | 'extract_clip' | 'split_new_part';
  customChunkRange?: { startIdx: number; endIdx: number };
  customOutputName?: string;
  customChatOutputName?: string;
  skipChunkCleanup?: boolean;
  preGapHighestSeq?: number;
  resumptionSeq?: number;
  missingChunkCount?: number;
  outputSuffix?: string;
  vodAvgSegmentDuration?: number;
  isFmp4?: boolean;
}

export type TaskView = ActiveTask;

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
  chatStream?: any; // fs.WriteStream (.comments.jsonl append-only journal)
  chatFilePath?: string;
  commentsJournalPath?: string;
  eventsFilePath?: string;
  chatWs?: any; // WebSocket (wss://irc-ws.chat.twitch.tv:443)
  chatReconnectTimer?: NodeJS.Timeout | null;
  chatHeartbeatInterval?: NodeJS.Timeout | null;
  ircConnected?: boolean;
  pubsubWs?: any; // Legacy alias kept for cleanup safety
  pubsubReconnectTimer?: NodeJS.Timeout | null;
  pubsubHeartbeatInterval?: NodeJS.Timeout | null;
  hermesWs?: any; // WebSocket (wss://hermes.twitch.tv/v1)
  hermesReconnectTimer?: NodeJS.Timeout | null;
  hermesKeepaliveInterval?: NodeJS.Timeout | null;
  hermesConnected?: boolean;
  refreshHermesSocket?: () => void;
  isStopped?: boolean;
  commentsWritten: number;
  eventsWritten?: number;
  thirdPartyEmotes?: any[];
  usedFirstPartyEmotes?: Map<string, string>;
  usedTwitchBadges?: Map<string, Set<string>>;
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
  liveManifestRecorded?: boolean;
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
  gapAdjustments?: GapAdjustment[];
  isResumingFromRestart?: boolean;
  lastRecoveryMessage?: string;
  firstChunkDurations?: number[];
  firstSeqNum?: number;
  isAwaitingBackfillChoice?: boolean;
  liveChatBuffer?: any[];
  chatExistingIds?: Set<string>;
  eventExistingIds?: Set<string>;
  activeChatBackfillPromise?: Promise<void> | null;
  inFlightSegmentDownloads?: Map<number, Promise<void>>;
  latestSegmentUrls?: Map<number, string>;
  initialTimelineAnchored?: boolean;
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

export interface SystemHealth {
  diskFree: number;
  diskTotal: number;
  memoryUsed: number;
  uptime: number;
}

export interface ActiveSessionView {
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
  ircConnected?: boolean;
  hermesConnected?: boolean;
  games?: SessionGame[];
  pendingGameSwitch?: {
    gameIndex: number;
    previousGame: string;
    currentGame: string;
    secondsRemaining: number;
    totalBufferSeconds: number;
  };
}

export interface Status {
  isMonitoring: boolean;
  isLive: boolean;
  monitoredChannels?: string[];
  logs: string[];
  activeTasks: ActiveTask[];
  lastCheckTime: number | null;
  systemHealth?: SystemHealth;
  activeSessions: ActiveSessionView[];
}

export interface RecentFolderItem {
  name: string;
  folderPath: string;
  updatedAt: number;
  chatFiles: string[];
  liveChunkCount: number;
  vodChunkCount: number;
  mp4Files: string[];
}

export interface ChatFileProfileInfo {
  filename: string;
  width: number;
  height: number;
  gameName?: string;
  matchedProfile?: string;
  isCustomProfile?: boolean;
}

export interface SessionsDeltaPayload {
  isMonitoring: boolean;
  monitoredChannels: string[];
  isLive: boolean;
  lastCheckTime: number | null;
  systemHealth?: SystemHealth;
  activeSessions: ActiveSessionView[];
}

export type TelemetrySseEvent =
  | { type: 'snapshot'; status: Status; config: Config }
  | { type: 'log'; line: string }
  | { type: 'logs_cleared' }
  | { type: 'tasks'; activeTasks: ActiveTask[] }
  | { type: 'sessions'; payload: SessionsDeltaPayload }
  | { type: 'config'; config: Config };
