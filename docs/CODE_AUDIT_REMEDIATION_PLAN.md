# VOD Automator: Unified Technical & UX Audit Remediation Plan

**Created:** 2026-10-16 (Reconciled & Merged with UX Systems Audit: 2026-10-18)  
**Baseline Version:** `v4.8.4` (Target: `v4.8.5` / `v4.9.0`)  
**Guiding Principle:** Prioritized strictly by operational severity (**P0 Critical Data Integrity → P1 Timeline & Sync Invariants → P2 External API & Persistence Resilience → P3 Core Workflow & UX Blockers → P4 Frontend Polish, Ergonomics & Hygiene**) and secondarily grouped by architectural domain. All changes strictly enforce the reconciled invariants defined in `AGENTS.md`.

---

## Architectural Alignment & `AGENTS.md` Compliance Matrix

Every remediation item in this unified plan has been verified against `AGENTS.md`:
- **Rule 1 (VOD vs. Live Chunk Separation):** `vod_init.mp4` vs. `init.mp4` CMAF initialization separation was completed in `v4.8.4`. Phase 2 eliminates remaining `vod_seq_*.ts` contamination in `startDownloadSession` (`chunksDownloaded`) and `stopActiveDownload` duration fallback regexes.
- **Rule 2 (Versioning & UI Sync Rules):** Phase 4 increments the version number in lockstep across `package.json` and `src/App.tsx`.
- **Rule 3 (Approval Rule):** This document serves as the read-only master blueprint; each phase awaits explicit user approval before code execution.
- **Rule 5 (Live Stream Recovery & Disk Invariants):** Opaque CDN segment URL recovery guards were completed in `v4.8.4`. Phase 1 and Phase 3 harden stalled-session recovery (`isStalled`) and ensure folder existence before segment/chat writes.
- **Rule 6 & Rule 9 (Broadcast Start Anchor, Non-Fixed Chunk Length & Probed Duration Invariants):** Dynamic `10.0s` CMAF VOD chunk duration calculation (`avgVodSegDur`) was completed in `v4.8.4`. Phase 1 adds a 60s AFK timeout to `prompt_backfill_${streamId}` so `liveChatBuffer` never stalls in RAM indefinitely when joining mid-stream. Phase 2 removes all remaining `chunkIndex * 2` and raw `firstChunkInVideo * avgChunkDur` assumptions across `download.ts` and `video.ts` (including initial game slicing, custom exports `append_previous`/`extract_clip`, gap adjustments, and 9-hour time-based autosplices), anchoring every calculation to `streamCreatedAtMs`, `firstSeqNum`, accumulated HLS segment durations (`session.videoDurationSeconds`), and `ffprobe` container durations.
- **Rule 7 (TwitchDownloader CLI Header & Schema Parity):** Phase 1 ensures `stopActiveDownload` finishes sealing and running `repairChatJsonFile` on `chat_[date].json` *before* `triggerFinalizeFlow` slices or renders chat. Additionally, `--giphy` support (`u/pgeneva/giphy_emotes_v1`) was integrated in `v4.8.2`.
- **Rule 8 (Game Slicing Buffer Preservation Invariants):** Preserved intact across all game slicing and manual splice flows.
- **Rule 10 (Enhanced Broadcasting & Usher Source Playlist Selection Invariants):** Completed in `v4.8.3`–`v4.8.4` (deterministic resolution/bitrate playlist sorting, `supported_codecs=av1,h265,h264&platform=web`, CloudFront `/chunked/` 1440p60 VOD upgrade, `postTwitchGql` HTTP 401 OAuth fallback, `init.mp4` vs. `vod_init.mp4` isolation with `stsd` header inspection, and opaque segment URL recovery guard).

---

## Unified Multiphase Execution Roadmap

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: Critical Data Integrity & Async Finalization Lifecycle (P0 - CRITICAL)   │
│  ├─ Domain 1A: VOD Backfill, Resumption Range & Unattended Prompt Integrity       │
│  │   ├─ 1.1 Fix premature currentGame.startTimeOffset mutation in recovery        │
│  │   ├─ 1.2 [DONE v4.8.4] Fix NaN timestamp & 10s CMAF chunk math in backfillVod  │
│  │   └─ 1.3 [UX-B1] Add 60s AFK auto-selection timer to initial VOD Backfill      │
│  │          prompt so liveChatBuffer never freezes in RAM indefinitely            │
│  └─ Domain 1B: Async Session Teardown & Chat Stream Sealing (api.ts, chat.ts)     │
│      ├─ 1.4 Await stopActiveDownload() before triggerFinalizeFlow() in routes     │
│      └─ 1.5 Coordinate auto-backfill promise (activeChatBackfillPromise)          │
└─────────────────────────────────────────┬─────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: Timeline Sync, Chunk Separation & Duration Invariants (P1 - HIGH)        │
│  ├─ Domain 2A: VOD/Live Chunk Separation & Accumulated Duration (download.ts)     │
│  │   ├─ 2.1 Count only live seq_*.ts in chunksDownloaded & restore highestSeq     │
│  │   ├─ 2.2 Preserve true videoDurationSeconds in stopActiveDownload              │
│  │   └─ 2.3 Fix 9-hour time-based autosplice to use real accumulated duration     │
│  └─ Domain 2B: Presentation Timeline Anchoring in Video & Chat Slicing            │
│      ├─ 2.4 Anchor initial live duration to broadcast join offset (download.ts)   │
│      └─ 2.5 Replace raw firstChunkInVideo * avgChunkDur in Game 1, Custom Clips,  │
│             Extensions, and Gap Adjustments with broadcast timeline anchors       │
│             (video.ts)                                                            │
└─────────────────────────────────────────┬─────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: External API Resilience, Query Hardening & State Safety (P2 - MAJOR)     │
│  ├─ Domain 3A: Twitch GQL, CDN & Emote Network Hardening (twitch/emotes/chat.ts)  │
│  │   ├─ 3.1 Strict channel handle sanitization & GraphQL variables parameterization│
│  │   ├─ 3.2 Add 5s request timeouts to all 6 third-party emote API calls          │
│  │   ├─ 3.3 Cap consecutive network retries in downloadVodChat pagination loop    │
│  │   └─ 3.4 Add transient retry for .ts segments & await stalled playlist refresh │
│  └─ Domain 3B: State Persistence Concurrency (state.ts)                           │
│      └─ 3.5 Queue follow-up save when scheduleStateSave fires during active write │
└─────────────────────────────────────────┬─────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 4: Core Workflow Unblocking & State Ergonomics (P2.5 - HIGH FRICTION UX)    │
│  ├─ Domain 4A: Post-Recording Actions & Dead-End Elimination (App.tsx, download)  │
│  │   ├─ 4.1 [UX-B3] Restore "Open Folder" action on tasks, stream cards & settings│
│  │   ├─ 4.2 [UX-B4] Add "Render Chat" action to completed VOD Backfill task cards │
│  │   └─ 4.3 [UX-H3/H4] Guard Render Chat modal (0-file disable, error feedback) & │
│  │          clarify "Download VOD Chat" button on completed broadcasts            │
│  └─ Domain 4B: Onboarding, Settings Dirty-State & Recovery Surfacing (App.tsx)    │
│      ├─ 4.4 [UX-B2] Isolate Settings draft state & warn on unsaved tab switches   │
│      ├─ 4.5 [UX-H1] Replace phantom @channel1/@channel2 with Empty Slot UI        │
│      └─ 4.6 [UX-H2] Expose Folder Video Recovery & Folder/File Picker in UI       │
└─────────────────────────────────────────┬─────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 5: Frontend UX Polish, Code Hygiene & Version Sync (P3 - MINOR / POLISH)    │
│  ├─ Domain 5A: Non-Blocking Feedback, Modals & Log Ergonomics (App.tsx, api.ts)   │
│  │   ├─ 5.1 [UX-P1] Fix global toast icon/title & replace 6 window.alert() calls  │
│  │   ├─ 5.2 [UX-P2] Reset Manual Splice modal state on open (prevent Game 1 bug)  │
│  │   ├─ 5.3 [UX-P3/P4/P5] Add System Log filter/search, OAuth token show/hide     │
│  │   │      toggle, and move "Reboot Program" to separated Danger Zone            │
│  │   └─ 5.4 Standardize gameSwitchBufferMins fallback (5m) in /api/status         │
│  └─ Domain 5B: Dead Code Cleanup & Version Synchronization (server/api/package)   │
│      ├─ 5.5 Remove unused imports and dead state variables                        │
│      └─ 5.6 Synchronize version bump (v4.8.5 / v4.9.0) in package.json & App.tsx  │
└───────────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Critical Data Integrity & Async Finalization Lifecycle *(Priority: P0 — Critical)*

**Objective:** Eliminate immediate data-loss bugs where recovery backfills truncate to 6 seconds, where unattended mid-stream starts hold live chat in RAM indefinitely without writing to disk, or where stopping a stream triggers video/chat slicing before the master chat JSON file has finished closing and repairing on disk.

### Domain 1A: VOD Backfill, Resumption Range & Unattended Prompt Integrity (`src/services/download.ts`, `src/services/chat.ts`)

#### 1.1 Fix Premature `currentGame.startTimeOffset` Mutation in `executeResumeVodBackfill`
- **Location:** `src/services/download.ts` (lines 888–902)
- **Failure Mode:** `currentGame.startTimeOffset = resumptionOffsetSec` is overwritten before reading `currentGame.startTimeOffset` to compute `gameStartOffsetSec`. For any game segment after the first (`currentGameIndex > 0`), `gameStartOffsetSec` becomes equal to `resumptionOffsetSec`, causing Option 2 ("VOD Backfill Current Game") to delete all recorded live chunks for the current game and only backfill the 6-second overlap window.
- **Compliance:** Upholds `AGENTS.md` Rule 1 & Rule 6.
- **Implementation:**
  1. Compute `const gameStartOffsetSec = Math.max(0, Math.floor(currentGameIndex === 0 ? 0 : (currentGame.startTimeOffset || 0)));` **before** mutating `currentGame.startChunk`, `currentGame.startTimeMs`, and `currentGame.startTimeOffset`.
  2. Then advance `currentGame` boundaries to the resumption edge for Part 2.

#### 1.2 [COMPLETED in `v4.8.4`] Fix `NaN` Timestamp Math & 10s CMAF Segment Duration in `backfillVod`
- **Status:** ✅ Completed in `v4.8.4` during the Enhanced Broadcasting proactive audit.
- **Location:** `src/services/download.ts` & `src/services/video.ts`
- **Resolution Applied:** Replaced `const startSeq = targetSegments[0] || seqNum` with numeric `startIdx` and computed actual average VOD segment duration (`avgVodSegDur`, supporting both `2.0s` normal VOD chunks and `10.0s` Enhanced Broadcasting CMAF chunks) for failure logging, FFmpeg progress estimation, and fallback VOD chat slicing. Also isolated VOD CMAF initialization segments to `vod_init.mp4` so they never collide with live `init.mp4`.

#### 1.3 [UX-B1] Add 60-Second AFK Auto-Selection Timer to Initial VOD Backfill Prompt (`startDownloadSession`)
- **Location:** `src/services/download.ts` (`startDownloadSession`, lines 591–688) & `src/services/chat.ts` (`startLiveChatDownload`, lines 1691–1703)
- **Failure Mode:** When a user starts monitoring a stream that has already been live for >2 minutes, `startLiveChatDownload` sets `awaitsUserChoice = true` and buffers all incoming live IRC chat messages in `liveBuffer` in RAM while waiting for the user to click an option on `prompt_backfill_${streamId}`. Because `prompt_backfill_${streamId}` has no timeout, if the user is AFK or unattended (`autoStartMonitoring`), `commentsWritten` remains frozen at `0` on the dashboard and hours of live chat remain unpersisted in RAM (and are lost if the app restarts or crashes before a button is clicked).
- **Compliance:** Upholds `AGENTS.md` Rule 6 (Broadcast Start Anchor & Chat Timeline Synchronization).
- **Implementation:**
  1. When `prompt_backfill_${streamId}` is updated with its action buttons in `startDownloadSession`, attach `const countdownSec = 60; currentTask.expiresAt = Date.now() + (countdownSec * 1000); currentTask.autoCountdownSeconds = countdownSec;` (the UI at `src/App.tsx:188` already renders `task.expiresAt` countdown badges automatically).
  2. Schedule a 60-second `setTimeout` that checks `if (state.activeTasks[taskId] && state.activeTasks[taskId].actionRequired)`. If still unanswered, log `[Backfill] AFK timeout (60s) elapsed for @${channelLogin}. Auto-selecting No Backfill to flush buffered live chat to disk.`, invoke `resolveLiveChatBackfill(channelLogin, 'none', 0)`, and call `removeTask(taskId)`.

### Domain 1B: Async Session Teardown & Chat Stream Sealing (`src/routes/api.ts`, `src/services/download.ts`, `src/services/chat.ts`)

#### 1.4 Await `stopActiveDownload` Before `triggerFinalizeFlow` Across All API Routes
- **Location:** `src/routes/api.ts` (`/api/config` line 146, `/api/force-stitch` line 357, `/api/stop` lines 750 & 769)
- **Failure Mode:** `stopActiveDownload` is an `async` function that flushes batched chat writes, writes the closing `embeddedData` footer, awaits `chatStream.end()`, patches `video.end`/`video.length` via `fs.openSync`, and runs `repairChatJsonFile`. Calling `stopActiveDownload` without `await` immediately starts `triggerFinalizeFlow` -> `stitchVideoChunks`, reading and slicing `chat_[date].json` while it is still unsealed or mid-write.
- **Compliance:** Upholds `AGENTS.md` Rule 6 & Rule 7.
- **Implementation:**
  1. In `POST /api/config`: `await stopActiveDownload(matchingKey);` before `triggerFinalizeFlow(sessionData, removed);`.
  2. Convert `POST /api/force-stitch` to `async (req, res)` and `await stopActiveDownload(channel);` before `triggerFinalizeFlow(sessionData, channel);`.
  3. Convert `POST /api/stop` to `async (req, res)` and `await stopActiveDownload(...)` before `triggerFinalizeFlow(...)` for both single-channel and all-channel stops.

#### 1.5 Coordinate Auto-Backfill Chat Promises During Recovery & Shutdown
- **Location:** `src/services/chat.ts` (`startLiveChatDownload`, lines 1703–1789) & `src/services/download.ts` (`stopActiveDownload`, lines 1564–1691)
- **Failure Mode:** When `shouldAutoBackfill` triggers on chat recovery, `downloadVodChat(...)` runs asynchronously without storing its promise on `session.activeChatBackfillPromise`. If the stream ends or is stopped before recovery backfill finishes, `stopActiveDownload` closes `session.chatStream`, causing the finishing backfill to write to a closed stream and lose buffered messages.
- **Compliance:** Upholds `AGENTS.md` Rule 6 (Backfill Chat Slicing Coordination).
- **Implementation:**
  1. Assign the `shouldAutoBackfill` promise to `session.activeChatBackfillPromise` and clear it in `.finally()`.
  2. In `stopActiveDownload`, if `session.activeChatBackfillPromise` is present, `await session.activeChatBackfillPromise.catch(() => {})` before calling `flushPendingChatWrites(session)` and closing `session.chatStream`.

---

## Phase 2: Timeline Synchronization, Chunk Separation & Duration Invariants *(Priority: P1 — High)*

**Objective:** Strictly enforce `AGENTS.md` Rules 1, 6, and 9 across `download.ts` and `video.ts`, eliminating every remaining place where `chunkIndex * 2`, `chunkCount * 2`, or unanchored `firstChunkInVideo * avgChunkDur` is used.

### Domain 2A: VOD vs. Live Chunk Separation & Accumulated Duration (`src/services/download.ts`)

#### 2.1 Strict VOD/Live Separation on Session Folder Resume (`startDownloadSession`)
- **Location:** `src/services/download.ts` (lines 488–561)
- **Failure Mode:** When resuming an existing folder, `downloadedSegments` adds both numeric `seq_*.ts` IDs and `vod_${seq}` strings. `chunksDownloaded: downloadedSegments.size` counts VOD chunks as live chunks, and `highestSeq: -1` is initialized instead of `currentChunkIndex`.
- **Compliance:** Upholds `AGENTS.md` Rule 1 (Never mix VOD and Live chunks).
- **Implementation:**
  1. Set `chunksDownloaded: chunkFilesList.length` (counting exclusively `seq_*.ts` files).
  2. Initialize `highestSeq: currentChunkIndex > 0 ? currentChunkIndex : -1`.

#### 2.2 Preserve True Accumulated `videoDurationSeconds` in `stopActiveDownload`
- **Location:** `src/services/download.ts` (lines 1589–1606)
- **Failure Mode:** `stopActiveDownload` reads `session.videoDurationSeconds`, which accumulates real `seg.duration` values from the HLS playlist, but immediately overwrites it with `(session.highestSeq + 1) * 2`, and the disk fallback regex `/(?:seq|vod)_(\d+)\.ts/` mixes VOD and live chunks.
- **Compliance:** Upholds `AGENTS.md` Rule 1 & Rule 9 (Never assume fixed 2.000s chunk length).
- **Implementation:**
  1. If `session.videoDurationSeconds && session.videoDurationSeconds > 0`, use `Math.round(session.videoDurationSeconds)` directly as the authoritative live broadcast duration.
  2. Only fall back to scanning disk if `videoDurationSeconds` is `0`/undefined, and match strictly `^seq_(\d+)\.ts$` (never `vod_seq_*.ts`).

#### 2.3 Fix Long-Broadcast Time Autosplice to Use Real Accumulated Duration (`pollPlaylist`)
- **Location:** `src/services/download.ts` (lines 1203–1235)
- **Failure Mode:** The 9-hour extended stream autosplice computes `recordedGameChunks * 2`, `chunksElapsed = Math.round(cutSec / 2)`, and `spliceTimeOffset = spliceStartChunk * 2`. Over 9 hours of `1.995s` chunks, multiplying by `2` drifts by ~40–50 seconds and corrupts `continuationGame.startTimeOffset`.
- **Compliance:** Upholds `AGENTS.md` Rule 9.
- **Implementation:**
  1. Compute `currentGameDuration` from real elapsed broadcast duration (`(session.videoDurationSeconds || 0) - (lastGame.startTimeOffset || 0)`).
  2. Compute the actual average chunk duration for the session (`avgDur = session.chunksDownloaded > 0 && session.videoDurationSeconds ? (session.videoDurationSeconds - (session.initialJoinOffsetSec || 0)) / session.chunksDownloaded : 2.0`) to determine `chunksElapsed = Math.round(cutSec / avgDur)`, and set `spliceTimeOffset = (lastGame.startTimeOffset || 0) + cutSec` and `startTimeMs = lastGame.startTimeMs + (cutSec * 1000)`.

### Domain 2B: Presentation Timeline Anchoring in Video & Chat Slicing (`src/services/download.ts`, `src/services/video.ts`)

#### 2.4 Anchor Initial Live Duration to Broadcast Join Offset (`pollPlaylist`)
- **Location:** `src/services/download.ts` (`pollPlaylist`, lines 1166–1179) & `src/types.ts` (`ActiveDownloadSession`)
- **Failure Mode:** When `session.chunksDownloaded === 0`, line 1168 sets `session.videoDurationSeconds = seqNum * 2` and `firstGame.startTimeOffset = seqNum * 2`. If Twitch's `EXT-X-MEDIA-SEQUENCE` starts at a non-zero number on a newly started stream or resets after an ingest blip, `seqNum * 2` corrupts the session's duration and timeline offset.
- **Compliance:** Upholds `AGENTS.md` Rule 6 & Rule 9.
- **Implementation:**
  1. Add `initialJoinOffsetSec?: number` to `ActiveDownloadSession` (and persist it in `state.ts` `getSerializableSessions()`).
  2. When the first live chunk is downloaded (`session.chunksDownloaded === 0`):
     - Compute `elapsedSinceBroadcastStartSec = Math.max(0, (Date.now() - (session.streamCreatedAtMs || Date.now())) / 1000)`.
     - If joining at stream launch (`elapsedSinceBroadcastStartSec < 60`), set `session.initialJoinOffsetSec = 0`. Otherwise (joining mid-stream), set `session.initialJoinOffsetSec = Math.max(0, elapsedSinceBroadcastStartSec - (segments.length * (seg.duration || 2)))`.
     - Initialize `session.firstSeqNum = seqNum`, `session.videoDurationSeconds = session.initialJoinOffsetSec`, and `firstGame.startTimeOffset = session.initialJoinOffsetSec`.

#### 2.5 Replace Faulty `firstChunkInVideo * avgChunkDur` in Game 1, Custom Clips, Extensions, and Gap Adjustments (`src/services/video.ts`)
- **Location:** `src/services/video.ts` (lines 920–944 for Custom Exports; lines 1121–1166 for Game Slicing)
- **Failure Mode:**
  1. **Game 1 (`i === 0`, line 1131 & 1140):** Uses `videoStartOffset = Math.max(0, firstChunkInVideo * avgChunkDur)`, which assumes `seq_00000000.ts` is `0.0s` of the broadcast and multiplies raw HLS sequence numbers.
  2. **Custom Exports (`append_previous` / `extract_clip`, line 924):** Also uses `videoStartOffset = Math.max(0, firstChunkInVideo * avgChunkDur)`, ignoring `firstSeqNum`, `initialJoinOffsetSec`, and real `game.startTimeMs` anchors!
  3. **Gap Adjustments (lines 933 & 1155):** Uses `gapOffsetSec = gap.atChunk * avgChunkDur` instead of anchoring relative to `firstSeqNum` and `initialJoinOffsetSec`.
- **Compliance:** Directly enforces reconciled `AGENTS.md` Rule 6 & Rule 9.
- **Implementation:**
  1. Define a unified helper in `src/services/video.ts` to compute the true broadcast presentation offset for any chunk index `chunkIdx`:
     - Base anchor: `const baseOffsetSec = session?.initialJoinOffsetSec ?? 0;` and `const baseSeq = session?.firstSeqNum ?? getChunkIndex(activeChunkList[0]) ?? 0;`.
     - For **Game 1 (`i === 0`)**: `videoStartOffset = Math.max(0, baseOffsetSec + Math.max(0, firstChunkInVideo - baseSeq) * avgChunkDur)`. (When recording from stream start and `firstChunkInVideo === baseSeq`, `videoStartOffset` is `0s`; when joining mid-stream, it equals `initialJoinOffsetSec`).
     - For **Subsequent Games (`i > 0`)**: Keep the `broadcastStartMs` presentation time anchor `gameSwitchOffsetSec = (game.startTimeMs - broadcastStartMs) / 1000` adjusted by `(firstChunkInVideo - game.startChunk) * avgChunkDur`.
     - For **Custom Exports (`append_previous` / `extract_clip`)**: Anchor to the active/target game's real presentation timestamp (`(targetGame.startTimeMs - broadcastStartMs) / 1000 + (firstChunkInVideo - targetGame.startChunk) * avgChunkDur`) when available, falling back to `baseOffsetSec + Math.max(0, firstChunkInVideo - baseSeq) * avgChunkDur`.
     - For **Gap Adjustments**: Compute `gapOffsetSec = baseOffsetSec + Math.max(0, gap.atChunk - baseSeq) * avgChunkDur`.

---

## Phase 3: External API Resilience, Query Hardening & Persistence Safety *(Priority: P2 — Major)*

**Objective:** Harden all external network boundaries (Twitch GraphQL, Twitch CDN, BTTV/FFZ/7TV APIs) against hangs, injection, and transient blips, and eliminate dropped state writes during concurrent `state.json` saves.

### Domain 3A: Twitch GQL, CDN & Emote Network Hardening (`src/services/state.ts`, `src/services/twitch.ts`, `src/services/emotes.ts`, `src/services/chat.ts`, `src/services/download.ts`)

#### 3.1 Strict Channel Handle Sanitization & Parameterized GraphQL Queries
- **Location:** `src/services/state.ts` (`cleanChannelName`), `src/services/twitch.ts` (`fetchChannelStreamStatus`, `checkChannelStreamId`, `fetchRecentVods`), `src/services/chat.ts` (`downloadVodChat`)
- **Note on `v4.8.4` Reconciliation:** `src/services/twitch.ts` routes all GraphQL calls through `postTwitchGql(payload, timeoutMs)` (which automatically handles HTTP 401/403 expired OAuth fallback to unauthenticated headers). Keep `postTwitchGql` as the transport wrapper and pass `variables` inside `payload`.
- **Failure Mode:** `cleanChannelName` strips URL prefixes but allows quotes or special characters that are interpolated directly into GraphQL query strings (`query { user(login: "${channelLogin}") ... }`).
- **Implementation:**
  1. Harden `cleanChannelName` in `src/services/state.ts` (and `cleanChannel` in `src/App.tsx`) with `.replace(/[^a-z0-9_]/g, '')` so only valid Twitch login handles can ever enter application state.
  2. Refactor `fetchChannelStreamStatus`, `checkChannelStreamId`, `fetchRecentVods` (via `postTwitchGql`), and `downloadVodChat` to pass `login`, `vodId`, `count`, `cursor`, and `offset` via GraphQL `variables` objects rather than string interpolation.

#### 3.2 Enforce 5-Second Request Timeouts on 3rd-Party Emote Providers
- **Location:** `src/services/emotes.ts` (`fetchThirdPartyEmotes`, lines 21–28)
- **Failure Mode:** Six `axios.get` calls to BetterTTV, FrankerFaceZ, and 7TV have no timeout configured. Because `startLiveChatDownload` awaits `fetchThirdPartyEmotes` before writing the chat header or opening the IRC WebSocket, an unresponsive emote server stalls chat recording indefinitely.
- **Implementation:**
  1. Pass `{ timeout: 5000 }` to all six `axios.get` calls in `src/services/emotes.ts`.

#### 3.3 Cap Consecutive Network Retries in `downloadVodChat`
- **Location:** `src/services/chat.ts` (`downloadVodChat`, lines 225–240)
- **Failure Mode:** On persistent network errors or deleted VODs, the `catch` block increments `contentOffset` by 1–10s and loops indefinitely (3,600+ retries for a 10h VOD).
- **Implementation:**
  1. Track `consecutiveNetworkErrors` (resetting to `0` on any successful GQL response).
  2. If `consecutiveNetworkErrors >= 10` or `(videoLength > 0 && contentOffset >= videoLength)`, log a clear warning and break out of the pagination loop cleanly.

#### 3.4 Transient Retry Helper for `.ts` Segment Downloads & Stalled Session Recovery
- **Location:** `src/services/download.ts` (`checkStreamStatus` lines 291–303, `pollPlaylist` lines 1081 & 1151, `backfillVod` line 1863)
- **Failure Mode:**
  1. Single-shot `axios.get` calls for `.ts` segments drop 2s video chunks permanently on any momentary CDN edge timeout or HTTP 503.
  2. In `checkStreamStatus`, `if (isStalled)` calls `refreshMediaPlaylist(channelLogin).then(...)` without `await` or `.catch()`, risking duplicate timers or unhandled rejections.
- **Implementation:**
  1. Introduce `downloadSegmentWithRetry(url, timeoutMs, retries = 2)` in `src/services/download.ts` with a 500ms backoff on timeout/5xx errors.
  2. In `checkStreamStatus` (`if (isStalled)`), `await refreshMediaPlaylist(channelLogin)` and verify `!activeSession.playlistPollInterval && !activeSession.isStopped` before scheduling `pollPlaylist`.

### Domain 3B: State Persistence Concurrency (`src/services/state.ts`)

#### 3.5 Queue Follow-Up Save When `executeStateSave` Is Already Active
- **Location:** `src/services/state.ts` (`executeStateSave` & `scheduleStateSave`, lines 375–410)
- **Failure Mode:** If `executeStateSave()` is called while an async write to `state.json.tmp` is in flight (`isSavingState === true`), it returns immediately and drops the newer state mutation.
- **Implementation:**
  1. Add `let pendingStateSave = false;`.
  2. If `isSavingState` is true when `executeStateSave()` is invoked, set `pendingStateSave = true; return;`.
  3. In `.finally()`, set `isSavingState = false;` and if `pendingStateSave` is true, reset `pendingStateSave = false;` and invoke `executeStateSave()`.

---

## Phase 4: Core Workflow Unblocking & State Ergonomics *(Priority: P2.5 — High Friction UX)*

**Objective:** Eliminate broken user journeys, dead-end completion cards, silent form resets, phantom `@channel1`/`@channel2` onboarding traps, and unexposed backend recovery routes identified in the UX Systems Audit.

### Domain 4A: Post-Recording Actions & Dead-End Elimination (`src/App.tsx`, `src/services/download.ts`)

#### 4.1 [UX-B3] Restore `"Open Folder"` Action on Completed Tasks, Stream Cards & Settings
- **Location:** `src/App.tsx` (`handleOpenFolder` line 246, `handleTaskAction` line 420, Task Queue Action Filter line 1212) & `src/services/download.ts` (`triggerMidStreamGameExport` line 1297, `manualSpliceGame` lines 1406 & 1473, `backfillVod` line 1911, `handleStitchComplete` line 1941)
- **Failure Mode:** `handleOpenFolder` is implemented in `src/App.tsx` (calling `POST /api/open-folder` and copying the path to clipboard) but is dead code: `handleTaskAction` returns early on `'open_folder'`, and line 1212 filters `'open_folder'` out of task buttons. Users have no one-click way to access their exported `.mp4` and `.json` files.
- **Implementation:**
  1. In `handleTaskAction` (`src/App.tsx:420`), invoke `const task = status?.activeTasks.find(t => t.id === taskId); handleOpenFolder(task?.folderPath); return;`.
  2. Remove `.filter(a => a.value !== 'open_folder')` from `src/App.tsx:1212`.
  3. Include `{ label: "Open Folder", value: "open_folder" }` on completed task cards in `download.ts` (`handleStitchComplete`, `backfillVod`, `triggerMidStreamGameExport`, `manualSpliceGame`) and `chat.ts` (`startChatRenderMultiple`, `downloadVodChat`).
  4. Add an `"Open Folder"` icon button on active/offline Stream Cards (`handleOpenFolder(activeSession?.folderPath)`) and beside the `Save Path` input in `Settings -> General`.

#### 4.2 [UX-B4] Add `"Render Chat"` Action to Completed Standalone VOD Backfill Task Cards
- **Location:** `src/services/download.ts` (`backfillVod`, lines 1910–1915)
- **Failure Mode:** When a standalone VOD backfill finishes (`stitch_vod_...`) and auto-render is disabled, the task card only offers `[{ label: "Close", value: "dismiss" }]`. Unlike live broadcasts, there is no `"Render Chat"` button on the card, forcing the user to manually copy-paste the file path into `Settings -> Chat Render -> Manual Render`.
- **Implementation:**
  1. In `backfillVod` (`src/services/download.ts:1911`), update the completion actions to include `{ label: "Render Chat", value: "render_chat" }` and `{ label: "Open Folder", value: "open_folder" }` alongside `{ label: "Close", value: "dismiss" }`.

#### 4.3 [UX-H3 & UX-H4] Guard `Render Chat Video` Modal & Clarify `"Download VOD Chat"` Action
- **Location:** `src/App.tsx` (`handleTaskAction` lines 424–454, `submitRenderChat` lines 557–579, `renderDialog` modal lines 1289–1388) & `src/services/download.ts` (`handleStitchComplete` line 1941)
- **Failure Mode:**
  1. Unchecking all files in `Render Chat Video` and clicking `"Start Render"` silently closes the modal without starting a render or showing a message (`src/App.tsx:561`), and API errors during submission are swallowed in `console.error`.
  2. `Broadcast Complete` cards display `"Download VOD Chat"` with equal prominence to `"Render Chat"`, misleading users into downloading redundant un-sliced `vod_chat.json` files on top of their already-sliced live game chats.
- **Implementation:**
  1. In `renderDialog` (`src/App.tsx`), disable the `"Start Render"` button when `renderDialog.files && renderDialog.files.filter(f => f.enabled !== false).length === 0`, and surface errors via `toastMessage`.
  2. In `handleStitchComplete` (`src/services/download.ts:1941`), place `{ label: "Render Chat", value: "render_chat" }` and `{ label: "Open Folder", value: "open_folder" }` first, and relabel `download_vod_chat` to `"Re-fetch VOD Chat"` (or only show it if `sessionData.commentsWritten === 0`).

### Domain 4B: Onboarding, Settings Dirty-State Protection & Recovery Surfacing (`src/App.tsx`, `src/routes/api.ts`)

#### 4.4 [UX-B2] Settings Dirty-State Protection & Sync Isolation
- **Location:** `src/App.tsx` (`Settings` tab, lines 41, 169–206, 526–555, 661–674)
- **Failure Mode:** Editing inputs in `Settings` mutates the top-level `config` state directly without saving to disk until `Save Configuration` is clicked. Switching tabs loses track of unsaved edits, and toggling `Auto-render chat` on the Dashboard overwrites `config` from the server response (`setConfig(res.data.config)`), wiping out unsaved Settings changes.
- **Implementation:**
  1. Track `isConfigDirty` in `src/App.tsx` whenever the user modifies any field in the Settings form (resetting `isConfigDirty = false` on `handleSaveConfig` or `fetchConfig`).
  2. Display a sticky or inline `"Unsaved changes"` indicator next to `Save Configuration` (with a `"Discard Changes"` button that calls `fetchConfig()`), and prompt for confirmation if the user attempts to switch `activeTab` while `isConfigDirty` is true.

#### 4.5 [UX-H1] Replace Phantom `@channel1` / `@channel2` Cards with True Empty Slot UI
- **Location:** `src/App.tsx` (`channelsToDisplay` memo, lines 620–636; Stream Card list, lines 753–915)
- **Failure Mode:** When `config.channels` has 0 or 1 channel, `channelsToDisplay` pads the array with literal `"channel1"` and `"channel2"`. Users can click `Start` on `@channel1`, causing the server to poll Twitch GQL for a literal user named `channel1`, and 1-channel users cannot clear Slot 2.
- **Implementation:**
  1. Change `channelsToDisplay` to represent two explicit slots (`[configured[0] || null, configured[1] || null]`, plus any orphaned active sessions).
  2. When a slot is `null` (unconfigured), render a dedicated **"Empty Stream Slot — Click to Add Channel"** card with an inline handle input and a disabled `Start` button until a valid Twitch username is saved.
  3. When a slot is configured and paused (`!isRunning`), provide a subtle `"Remove / Clear Slot"` (`X` or `Trash2`) button next to the inline edit pencil so a user monitoring 2 channels can easily drop back to 1.

#### 4.6 [UX-H2] Expose Folder Video Recovery (`/api/recover-folder-video`) & Folder/File Picker in UI
- **Location:** `src/routes/api.ts` (`/api/recover-folder-video`, line 364) & `src/App.tsx` (`Livestream Monitor` header & `Manual Render Modal`, line 2031)
- **Failure Mode:**
  1. `POST /api/recover-folder-video` is implemented on the backend to stitch uncompiled `.ts` chunks in any session folder, but has zero UI triggers in `src/App.tsx`.
  2. `Manual Chat Render` is buried at the bottom of `Settings -> Chat Render` and requires manually typing file paths.
- **Implementation:**
  1. Add `GET /api/recent-folders` in `src/routes/api.ts` that scans `getResolvedSavePath()` (1 level deep) and returns recent session folders along with their `.json` chat files and raw `.ts` chunk counts.
  2. Add quick-action buttons on the `Livestream Monitor` dashboard header for **"Manual Chat Render"** and **"Recover Folder Video"**, and populate both modals with a dropdown selector powered by `GET /api/recent-folders` (while retaining manual path input as an option).

---

## Phase 5: Frontend UX Polish, Code Hygiene & Version Sync *(Priority: P3 — Minor / Polish)*

**Objective:** Fix the hardcoded toast header, replace blocking `window.alert()` calls, reset modal state on open, add log filtering and OAuth visibility ergonomics, unify configuration fallbacks, clean up dead code, and synchronize the application version badge per `AGENTS.md` Rule 2.

### Domain 5A: Non-Blocking Feedback, Modals & Log Ergonomics (`src/App.tsx`, `src/routes/api.ts`)

#### 5.1 [UX-P1] Fix Global Toast Banner Icon/Title & Replace Blocking `window.alert()` Calls
- **Location:** `src/App.tsx` (lines 49, 216, 219, 288, 306, 381, 385, and Toast Banner lines 1815–1839)
- **Failure Mode:**
  1. Six error paths invoke `alert(...)`, which blocks the main browser thread and fails inside embedded/headless webviews.
  2. The `toastMessage` banner at `src/App.tsx:1825–1827` hardcodes `<Folder />` and `<p>File Manager</p>` even when displaying error or success messages.
- **Implementation:**
  1. Update the global `toastMessage` banner to dynamically render `AlertTriangle` / `"Error"` for `type === 'error'`, `CheckCircle2` / `"Success"` for `type === 'success'`, and `Folder` / `"Notice"` for `type === 'info'` (with optional `title` override).
  2. Introduce a `showToast(text, type, title?)` helper with a 4-second auto-dismiss timer and replace all 6 `alert(...)` calls in `src/App.tsx`.
  3. Remove unused `isTogglingMonitoring` state declaration (line 49).

#### 5.2 [UX-P2] Reset Manual Video Splice Modal State on Open
- **Location:** `src/App.tsx` (lines 228–230, 1017, 2213–2270)
- **Failure Mode:** `spliceAction` persists across modal opens. If a user selects `'append_previous'` on a multi-game stream and later opens the modal on a stream that is on Game 1 (`hasPrevious === false`), the radio button is disabled but `spliceAction` remains `'append_previous'`, causing `"Execute Splice"` to submit a forbidden action.
- **Implementation:**
  1. When opening the Manual Splice modal (`onClick` at line 1017), reset `setSpliceAction('split_new_part')` (or `'extract_clip'`) so a disabled radio option is never pre-selected.

#### 5.3 [UX-P3, UX-P4 & UX-P5] System Log Filter Bar, OAuth Show/Hide Toggle & Danger Zone Separation
- **Location:** `src/App.tsx` (`Settings -> General` lines 420–430, `Settings` footer lines 1928–1949, `System Log` tab lines 1973–2027)
- **Implementation:**
  1. **System Log Filtering (`UX-P3`):** Add a search input (`logSearchQuery`) and category filter pills (`All`, `Errors & Warnings`, `Video & Stitch`, `Chat & Render`) above the log viewer, plus semantic color highlighting for `[Error]`/`CRITICAL` (red) and `[Warning]` (amber) lines.
  2. **OAuth Token Ergonomics (`UX-P4`):** Add a Show/Hide password toggle button on the `Browser OAuth Token` input and update its placeholder to reflect the raw 30-character alphanumeric cookie value.
  3. **Danger Zone Separation (`UX-P5`):** Move the `Reboot Program` button out of the `Save Configuration` form footer into a clearly labeled `"Emergency Reset"` section so users never mistake it for a "Restart to apply settings" button.

#### 5.4 Unify `gameSwitchBufferMins` Fallback in `/api/status`
- **Location:** `src/routes/api.ts` (line 260)
- **Failure Mode:** `pendingGameSwitch` falls back to `6` minutes (`gameSwitchBufferMins ?? gameSegmentBufferMinutes ?? 6`), whereas `state.ts`, `download.ts`, `video.ts`, and `App.tsx` all default to `5` minutes.
- **Implementation:**
  1. Change the fallback on line 260 of `src/routes/api.ts` to `5` minutes (`state.config.gameSwitchBufferMins ?? 5`).

### Domain 5B: Dead Code Cleanup & Version Synchronization (`server.ts`, `src/routes/api.ts`, `package.json`, `src/App.tsx`)

#### 5.5 Remove Unused Imports and Dead Declarations
- **Location:** `server.ts` (lines 6, 11, 32–33), `src/routes/api.ts` (lines 6–7)
- **Implementation:**
  1. Remove unused `fileURLToPath`, `__filename`, `__dirname`, and `checkStreamStatus` from `server.ts` (retaining `fs`, which is used by the `app.lock` single-instance mutex).
  2. Remove unused `CONFIG_FILE`, `CONFIG_BAK_FILE`, `getMonitoringInterval`, `setMonitoringInterval`, and `finalizeLiveDownload` imports from `src/routes/api.ts`.

#### 5.6 Synchronized Version Increment (`AGENTS.md` Rule 2)
- **Location:** `package.json` (line 4) & `src/App.tsx` (line 656)
- **Compliance:** Upholds `AGENTS.md` Rule 2.
- **Implementation:**
  1. Increment version from `4.8.4` to `4.8.5` (or `4.9.0` for the unified technical + UX release) in both `package.json` and the top-left header badge in `src/App.tsx`.
