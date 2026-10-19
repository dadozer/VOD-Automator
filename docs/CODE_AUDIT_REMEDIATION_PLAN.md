# VOD Automator: Unified Technical & UX Audit Remediation Plan

**Created:** 2026-10-16 (Reconciled & Merged with UX Systems Audit: 2026-10-18)  
**Current Version:** `v4.9.0` (All Phases 1–5 Completed & Verified)  
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
│ PHASE 1: Critical Data Integrity & Async Finalization Lifecycle [✅ DONE v4.8.5]  │
│  ├─ Domain 1A: VOD Backfill, Resumption Range & Unattended Prompt Integrity       │
│  │   ├─ 1.1 [DONE v4.8.5] Fix premature currentGame.startTimeOffset mutation      │
│  │   ├─ 1.2 [DONE v4.8.4] Fix NaN timestamp & 10s CMAF chunk math in backfillVod  │
│  │   └─ 1.3 [DONE v4.8.5] Add 60s AFK auto-selection timer to initial VOD Backfill│
│  │          prompt so liveChatBuffer never freezes in RAM indefinitely            │
│  └─ Domain 1B: Async Session Teardown & Chat Stream Sealing (api.ts, chat.ts)     │
│      ├─ 1.4 [DONE v4.8.5] Await stopActiveDownload() before triggerFinalizeFlow() │
│      └─ 1.5 [DONE v4.8.5] Coordinate auto-backfill (activeChatBackfillPromise)    │
└─────────────────────────────────────────┬─────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: Timeline Sync, Chunk Separation & Duration Invariants [✅ DONE v4.8.6]   │
│  ├─ Domain 2A: VOD/Live Chunk Separation & Accumulated Duration (download.ts)     │
│  │   ├─ 2.1 [DONE v4.8.6] Count only live seq_*.ts in chunksDownloaded & highestSeq│
│  │   ├─ 2.2 [DONE v4.8.6] Preserve true videoDurationSeconds in stopActiveDownload│
│  │   └─ 2.3 [DONE v4.8.6] Fix 9-hour time-based autosplice to use real duration   │
│  └─ Domain 2B: Presentation Timeline Anchoring in Video & Chat Slicing            │
│      ├─ 2.4 [DONE v4.8.6] Anchor initial live duration to broadcast join offset   │
│      └─ 2.5 [DONE v4.8.6] Replace raw firstChunkInVideo * avgChunkDur in Game 1,  │
│             Custom Clips, Extensions, and Gap Adjustments with broadcast timeline │
│             anchors (video.ts)                                                    │
└─────────────────────────────────────────┬─────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: External API Resilience, Query Hardening & State Safety [✅ DONE v4.8.6] │
│  ├─ Domain 3A: Twitch GQL, CDN & Emote Network Hardening (twitch/emotes/chat.ts)  │
│  │   ├─ 3.1 [DONE v4.8.6] Strict channel handle sanitization & GQL variables      │
│  │   ├─ 3.2 [DONE v4.8.6] Add 5s request timeouts to all 6 3rd-party emote calls  │
│  │   ├─ 3.3 [DONE v4.8.6] Cap consecutive network retries in downloadVodChat loop │
│  │   └─ 3.4 [DONE v4.8.6] Add transient retry for .ts segments & await stalled    │
│  │          playlist refresh                                                      │
│  └─ Domain 3B: State Persistence Concurrency (state.ts)                           │
│      └─ 3.5 [DONE v4.8.6] Queue follow-up save when executeStateSave is active    │
└─────────────────────────────────────────┬─────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 4: Core Workflow Unblocking & State Ergonomics [✅ DONE v4.8.7]             │
│  ├─ Domain 4A: Post-Recording Actions & Dead-End Elimination (App.tsx, download)  │
│  │   ├─ 4.1 [DONE v4.8.7] Restore "Open Folder" action on tasks, stream cards & UI│
│  │   ├─ 4.2 [DONE v4.8.7] Add "Render Chat" action to completed VOD Backfill cards│
│  │   └─ 4.3 [DONE v4.8.7] Guard Render Chat modal (0-file disable, error feedback)│
│  │          & clarify "Re-fetch VOD Chat" button on completed broadcasts          │
│  └─ Domain 4B: Onboarding, Settings Dirty-State & Recovery Surfacing (App.tsx)    │
│      ├─ 4.4 [DONE v4.8.7] Isolate Settings draft state & warn on unsaved switches │
│      ├─ 4.5 [DONE v4.8.7] Replace phantom @channel1/@channel2 with Empty Slot UI  │
│      └─ 4.6 [DONE v4.8.7] Expose Folder Video Recovery & Folder/File Picker in UI │
└─────────────────────────────────────────┬─────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 5: Frontend UX Polish, Code Hygiene & Version Sync [✅ DONE v4.9.0]         │
│  ├─ Domain 5A: Non-Blocking Feedback, Modals & Log Ergonomics (App.tsx, api.ts)   │
│  │   ├─ 5.1 [DONE v4.8.7] Fix global toast icon/title & replace 6 alert() calls   │
│  │   ├─ 5.2 [DONE v4.8.7] Reset Manual Splice modal state on open                 │
│  │   ├─ 5.3 [DONE v4.8.7] Add System Log filter/search, OAuth token show/hide     │
│  │   │      toggle, and move "Reboot Program" to separated Danger Zone            │
│  │   └─ 5.4 [DONE v4.8.7] Standardize gameSwitchBufferMins fallback (5m)          │
│  └─ Domain 5B: Dead Code Cleanup & Version Synchronization (server/api/package)   │
│      ├─ 5.5 [DONE v4.9.0] Remove unused imports and dead variables across project │
│      └─ 5.6 [DONE v4.9.0] Synchronize version bump (v4.9.0) in package & App.tsx  │
└───────────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Critical Data Integrity & Async Finalization Lifecycle *(Priority: P0 — Critical)* — ✅ COMPLETED (`v4.8.5`)

**Objective:** Eliminate immediate data-loss bugs where recovery backfills truncate to 6 seconds, where unattended mid-stream starts hold live chat in RAM indefinitely without writing to disk, or where stopping a stream triggers video/chat slicing before the master chat JSON file has finished closing and repairing on disk.

### Domain 1A: VOD Backfill, Resumption Range & Unattended Prompt Integrity (`src/services/download.ts`, `src/services/chat.ts`)

#### 1.1 [COMPLETED in `v4.8.5`] Fix Premature `currentGame.startTimeOffset` Mutation in `executeResumeVodBackfill`
- **Status:** ✅ Completed in `v4.8.5`.
- **Location:** `src/services/download.ts` (lines 883–899)
- **Failure Mode:** `currentGame.startTimeOffset = resumptionOffsetSec` was overwritten before reading `currentGame.startTimeOffset` to compute `gameStartOffsetSec`. For any game segment after the first (`currentGameIndex > 0`), `gameStartOffsetSec` became equal to `resumptionOffsetSec`, causing Option 2 ("VOD Backfill Current Game") to delete all recorded live chunks for the current game and only backfill the 6-second overlap window.
- **Compliance:** Upholds `AGENTS.md` Rule 1 & Rule 6.
- **Resolution Applied:** Computed `gameStartOffsetSec` before advancing `currentGame.startChunk`, `currentGame.startTimeMs`, and `currentGame.startTimeOffset` to the resumption edge for Part 2.

#### 1.2 [COMPLETED in `v4.8.4`] Fix `NaN` Timestamp Math & 10s CMAF Segment Duration in `backfillVod`
- **Status:** ✅ Completed in `v4.8.4` during the Enhanced Broadcasting proactive audit.
- **Location:** `src/services/download.ts` & `src/services/video.ts`
- **Resolution Applied:** Replaced `const startSeq = targetSegments[0] || seqNum` with numeric `startIdx` and computed actual average VOD segment duration (`avgVodSegDur`, supporting both `2.0s` normal VOD chunks and `10.0s` Enhanced Broadcasting CMAF chunks) for failure logging, FFmpeg progress estimation, and fallback VOD chat slicing. Also isolated VOD CMAF initialization segments to `vod_init.mp4` so they never collide with live `init.mp4`.

#### 1.3 [COMPLETED in `v4.8.5`] [UX-B1] Add 60-Second AFK Auto-Selection Timer to Initial VOD Backfill Prompt (`startDownloadSession`)
- **Status:** ✅ Completed in `v4.8.5`.
- **Location:** `src/services/download.ts` (`startDownloadSession`, lines 635–710) & `src/services/chat.ts` (`startLiveChatDownload`, lines 1691–1703)
- **Failure Mode:** When a user started monitoring a stream that had already been live for >2 minutes, `startLiveChatDownload` set `awaitsUserChoice = true` and buffered all incoming live IRC chat messages in `liveBuffer` in RAM while waiting for the user to click an option on `prompt_backfill_${streamId}`. Because `prompt_backfill_${streamId}` had no timeout, if the user was AFK or unattended (`autoStartMonitoring`), `commentsWritten` remained frozen at `0` on the dashboard and hours of live chat remained unpersisted in RAM.
- **Compliance:** Upholds `AGENTS.md` Rule 6 (Broadcast Start Anchor & Chat Timeline Synchronization).
- **Resolution Applied:** Attached a 60-second `expiresAt` countdown (`defaultAction: "backfill_none"`) and `setTimeout` handler to `prompt_backfill_${streamId}` that automatically invokes `resolveLiveChatBackfill(channelLogin, 'none', 0)` and removes the prompt task if unanswered after 60 seconds.

### Domain 1B: Async Session Teardown & Chat Stream Sealing (`src/routes/api.ts`, `src/services/download.ts`, `src/services/chat.ts`)

#### 1.4 [COMPLETED in `v4.8.5`] Await `stopActiveDownload` Before `triggerFinalizeFlow` Across All API Routes
- **Status:** ✅ Completed in `v4.8.5`.
- **Location:** `src/routes/api.ts` (`/api/config` line 146, `/api/force-stitch` line 355, `/api/stop` lines 746 & 764)
- **Failure Mode:** `stopActiveDownload` is an `async` function that flushes batched chat writes, writes the closing `embeddedData` footer, awaits `chatStream.end()`, patches `video.end`/`video.length` via `fs.openSync`, and runs `repairChatJsonFile`. Calling `stopActiveDownload` without `await` immediately started `triggerFinalizeFlow` -> `stitchVideoChunks`, reading and slicing `chat_[date].json` while it was still unsealed or mid-write.
- **Compliance:** Upholds `AGENTS.md` Rule 6 & Rule 7.
- **Resolution Applied:** Converted `/api/force-stitch` and `/api/stop` to `async` route handlers and awaited `stopActiveDownload(...)` before `triggerFinalizeFlow(...)` across `/api/config`, `/api/force-stitch`, and `/api/stop` (both single-channel and all-channel stops).

#### 1.5 [COMPLETED in `v4.8.5`] Coordinate Auto-Backfill Chat Promises During Recovery & Shutdown
- **Status:** ✅ Completed in `v4.8.5`.
- **Location:** `src/services/chat.ts` (`startLiveChatDownload`, lines 1705–1796) & `src/services/download.ts` (`stopActiveDownload`, lines 1583–1586)
- **Failure Mode:** When `shouldAutoBackfill` triggered on chat recovery, `downloadVodChat(...)` ran asynchronously without storing its promise on `session.activeChatBackfillPromise`. If the stream ended or was stopped before recovery backfill finished, `stopActiveDownload` closed `session.chatStream`, causing the finishing backfill to write to a closed stream and lose buffered messages.
- **Compliance:** Upholds `AGENTS.md` Rule 6 (Backfill Chat Slicing Coordination).
- **Resolution Applied:** Assigned `autoBackfillPromise` to `session.activeChatBackfillPromise` (clearing it in `.finally()`) and awaited `session.activeChatBackfillPromise` inside `stopActiveDownload` before calling `flushPendingChatWrites(session)` and closing `session.chatStream`.

---

## Phase 2: Timeline Synchronization, Chunk Separation & Duration Invariants *(Priority: P1 — High)* — ✅ COMPLETED (`v4.8.6`)

**Objective:** Strictly enforce `AGENTS.md` Rules 1, 6, and 9 across `download.ts` and `video.ts`, eliminating every remaining place where `chunkIndex * 2`, `chunkCount * 2`, or unanchored `firstChunkInVideo * avgChunkDur` is used.

### Domain 2A: VOD vs. Live Chunk Separation & Accumulated Duration (`src/services/download.ts`)

#### 2.1 [COMPLETED in `v4.8.6`] Strict VOD/Live Separation on Session Folder Resume (`startDownloadSession`)
- **Status:** ✅ Completed in `v4.8.6`.
- **Location:** `src/services/download.ts` (lines 488–561)
- **Failure Mode:** When resuming an existing folder, `downloadedSegments` adds both numeric `seq_*.ts` IDs and `vod_${seq}` strings. `chunksDownloaded: downloadedSegments.size` counts VOD chunks as live chunks, and `highestSeq: -1` is initialized instead of `currentChunkIndex`.
- **Compliance:** Upholds `AGENTS.md` Rule 1 (Never mix VOD and Live chunks).
- **Resolution Applied:** Set `chunksDownloaded: liveChunksCount` (counting exclusively `seq_*.ts` files) and initialized `highestSeq: currentChunkIndex > 0 ? currentChunkIndex : -1`.

#### 2.2 [COMPLETED in `v4.8.6`] Preserve True Accumulated `videoDurationSeconds` in `stopActiveDownload`
- **Status:** ✅ Completed in `v4.8.6`.
- **Location:** `src/services/download.ts` (lines 1600–1620)
- **Failure Mode:** `stopActiveDownload` read `session.videoDurationSeconds` (which accumulates real `seg.duration` values from the HLS playlist), but immediately overwrote it with `(session.highestSeq + 1) * 2`, and the disk fallback regex `/(?:seq|vod)_(\d+)\.ts/` mixed VOD and live chunks.
- **Compliance:** Upholds `AGENTS.md` Rule 1 & Rule 9 (Never assume fixed 2.000s chunk length).
- **Resolution Applied:** Retained `Math.round(session.videoDurationSeconds || 0)` as the primary duration when `> 0`, anchored `highestSeq` fallback to `firstSeqNum` and `initialJoinOffsetSec`, and restricted disk fallback to `/^seq_(\d+)\.ts$/`.

#### 2.3 [COMPLETED in `v4.8.6`] Fix Long-Broadcast Time Autosplice to Use Real Accumulated Duration (`pollPlaylist`)
- **Status:** ✅ Completed in `v4.8.6`.
- **Location:** `src/services/download.ts` (lines 1220–1255)
- **Failure Mode:** The 9-hour extended stream autosplice computed `recordedGameChunks * 2`, `chunksElapsed = Math.round(cutSec / 2)`, and `spliceTimeOffset = spliceStartChunk * 2`. Over 9 hours of `1.995s` chunks, multiplying by `2` drifted by ~40–50 seconds and corrupted `continuationGame.startTimeOffset`.
- **Compliance:** Upholds `AGENTS.md` Rule 9.
- **Resolution Applied:** Computed `currentGameDuration` from `(session.videoDurationSeconds || 0) - (lastGame.startTimeOffset || 0)`, derived `avgDur` from real accumulated session duration, and set `spliceTimeOffset = (lastGame.startTimeOffset || 0) + cutSec` and `startTimeMs = (lastGame.startTimeMs || Date.now()) + (cutSec * 1000)`.

### Domain 2B: Presentation Timeline Anchoring in Video & Chat Slicing (`src/services/download.ts`, `src/services/video.ts`)

#### 2.4 [COMPLETED in `v4.8.6`] Anchor Initial Live Duration to Broadcast Join Offset (`pollPlaylist`)
- **Status:** ✅ Completed in `v4.8.6`.
- **Location:** `src/services/download.ts` (`pollPlaylist`), `src/types.ts` (`ActiveDownloadSession`, `ActiveTask`), `src/services/state.ts` (`getSerializableSessions`)
- **Failure Mode:** When `session.chunksDownloaded === 0`, `pollPlaylist` set `session.videoDurationSeconds = seqNum * 2` and `firstGame.startTimeOffset = seqNum * 2`. If Twitch's `EXT-X-MEDIA-SEQUENCE` started at a non-zero number on a newly started stream or reset after an ingest blip, `seqNum * 2` corrupted the session's duration and timeline offset.
- **Compliance:** Upholds `AGENTS.md` Rule 6 & Rule 9.
- **Resolution Applied:** Computed `initialJoinOffsetSec` from `(Date.now() - streamCreatedAtMs) / 1000` minus the active playlist window (`0s` when joining within 60s of broadcast start), persisted `initialJoinOffsetSec` and `firstSeqNum` in `state.ts`, and propagated timeline anchors (`initialJoinOffsetSec`, `firstSeqNum`, `streamCreatedAtMs`, `gapAdjustments`) onto mid-stream, custom, and finalization export tasks.

#### 2.5 [COMPLETED in `v4.8.6`] Replace Faulty `firstChunkInVideo * avgChunkDur` in Game 1, Custom Clips, Extensions, and Gap Adjustments (`src/services/video.ts`)
- **Status:** ✅ Completed in `v4.8.6`.
- **Location:** `src/services/video.ts` (Custom Exports & Game Slicing)
- **Failure Mode:** Game 1 (`i === 0`), Custom Exports (`append_previous` / `extract_clip`), and Gap Adjustments multiplied raw HLS sequence numbers (`firstChunkInVideo * avgChunkDur` and `gap.atChunk * avgChunkDur`) instead of anchoring to `initialJoinOffsetSec`, `firstSeqNum`, and `game.startTimeMs`.
- **Compliance:** Directly enforces reconciled `AGENTS.md` Rule 6 & Rule 9.
- **Resolution Applied:** Anchored Game 1 and fallback offsets to `baseOffsetSec + Math.max(0, firstChunkInVideo - baseSeq) * avgChunkDur`, anchored custom exports to `targetGame.startTimeMs` / `targetGame.startTimeOffset` + `(firstChunkInVideo - targetGame.startChunk) * avgChunkDur`, and anchored gap adjustments to `baseOffsetSec + Math.max(0, gap.atChunk - baseSeq) * avgChunkDur`.

---

## Phase 3: External API Resilience, Query Hardening & Persistence Safety *(Priority: P2 — Major)* — ✅ COMPLETED (`v4.8.6`)

**Objective:** Harden all external network boundaries (Twitch GraphQL, Twitch CDN, BTTV/FFZ/7TV APIs) against hangs, injection, and transient blips, and eliminate dropped state writes during concurrent `state.json` saves.

### Domain 3A: Twitch GQL, CDN & Emote Network Hardening (`src/services/state.ts`, `src/services/twitch.ts`, `src/services/emotes.ts`, `src/services/chat.ts`, `src/services/download.ts`)

#### 3.1 [COMPLETED in `v4.8.6`] Strict Channel Handle Sanitization & Parameterized GraphQL Queries
- **Status:** ✅ Completed in `v4.8.6`.
- **Location:** `src/services/state.ts` (`cleanChannelName`), `src/App.tsx` (`cleanChannel`), `src/services/twitch.ts` (`fetchChannelStreamStatus`, `checkChannelStreamId`, `fetchRecentVods`), `src/services/chat.ts` (`downloadVodChat`)
- **Resolution Applied:** Added `.replace(/[^a-z0-9_]/g, '')` to `cleanChannelName` (`state.ts`) and `cleanChannel` (`App.tsx`), and converted `fetchChannelStreamStatus`, `checkChannelStreamId`, `fetchRecentVods`, and `downloadVodChat` (now routed through `postTwitchGql` for automatic HTTP 401/403 OAuth fallback) to pass GraphQL `variables` instead of string interpolation.

#### 3.2 [COMPLETED in `v4.8.6`] Enforce 5-Second Request Timeouts on 3rd-Party Emote Providers
- **Status:** ✅ Completed in `v4.8.6`.
- **Location:** `src/services/emotes.ts` (`fetchThirdPartyEmotes`)
- **Resolution Applied:** Added `{ timeout: 5000 }` to all six `axios.get` calls for BetterTTV, FrankerFaceZ, and 7TV.

#### 3.3 [COMPLETED in `v4.8.6`] Cap Consecutive Network Retries in `downloadVodChat`
- **Status:** ✅ Completed in `v4.8.6`.
- **Location:** `src/services/chat.ts` (`downloadVodChat`)
- **Resolution Applied:** Added `consecutiveNetworkErrors` counter (reset to `0` on success) that cleanly exits the pagination loop if `consecutiveNetworkErrors >= 10` or `contentOffset >= videoLength`.

#### 3.4 [COMPLETED in `v4.8.6`] Transient Retry Helper for `.ts` Segment Downloads & Stalled Session Recovery
- **Status:** ✅ Completed in `v4.8.6`.
- **Location:** `src/services/download.ts` (`downloadSegmentWithRetry`, `checkStreamStatus`, `pollPlaylist`, `backfillVod`)
- **Resolution Applied:** Implemented `downloadSegmentWithRetry(url, timeoutMs, retries = 2)` with linear backoff on transient/5xx/timeout errors across live polling, missing-segment recovery, and VOD backfill, and awaited `refreshMediaPlaylist` with `.catch()` and `!activeSession.playlistPollInterval && !activeSession.isStopped` guards on stalled-session recovery.

### Domain 3B: State Persistence Concurrency (`src/services/state.ts`)

#### 3.5 [COMPLETED in `v4.8.6`] Queue Follow-Up Save When `executeStateSave` Is Already Active
- **Status:** ✅ Completed in `v4.8.6`.
- **Location:** `src/services/state.ts` (`executeStateSave`)
- **Resolution Applied:** Added `pendingStateSave` flag so state mutations occurring while an async `state.json.tmp` write is in flight automatically trigger a follow-up `executeStateSave()` upon completion.

---

## Phase 4: Core Workflow Unblocking & State Ergonomics *(Priority: P2.5 — High Friction UX)* — ✅ COMPLETED (`v4.8.7`)

**Objective:** Eliminate broken user journeys, dead-end completion cards, silent form resets, phantom `@channel1`/`@channel2` onboarding traps, and unexposed backend recovery routes identified in the UX Systems Audit.

### Domain 4A: Post-Recording Actions & Dead-End Elimination (`src/App.tsx`, `src/services/download.ts`, `src/services/chat.ts`)

#### 4.1 [COMPLETED in `v4.8.7` — UX-B3] Restore `"Open Folder"` Action on Completed Tasks, Stream Cards & Settings
- **Status:** ✅ Completed in `v4.8.7`.
- **Location:** `src/App.tsx`, `src/services/download.ts`, `src/services/chat.ts`, `src/routes/api.ts`
- **Resolution Applied:** Wired `'open_folder'` in `handleTaskAction` to `handleOpenFolder(task?.folderPath)`, removed the `.filter(a => a.value !== 'open_folder')` filter on task buttons, added `{ label: "Open Folder", value: "open_folder" }` to completed video/chat/recovery tasks, and added one-click `"Open Folder"` buttons on Stream Cards, the dashboard header, and beside `Save Path` in `Settings -> General`.

#### 4.2 [COMPLETED in `v4.8.7` — UX-B4] Add `"Render Chat"` Action to Completed Standalone VOD Backfill Task Cards
- **Status:** ✅ Completed in `v4.8.7`.
- **Location:** `src/services/download.ts` (`backfillVod`)
- **Resolution Applied:** Added `{ label: "Render Chat", value: "render_chat" }` and `{ label: "Open Folder", value: "open_folder" }` to completed standalone VOD backfill task cards (`stitch_vod_...`).

#### 4.3 [COMPLETED in `v4.8.7` — UX-H3 & UX-H4] Guard `Render Chat Video` Modal & Clarify `"Download VOD Chat"` Action
- **Status:** ✅ Completed in `v4.8.7`.
- **Location:** `src/App.tsx` (`submitRenderChat`, `renderDialog`) & `src/services/download.ts` (`handleStitchComplete`)
- **Resolution Applied:** Disabled `"Start Render"` when 0 files are checked, surfaced submission errors via non-blocking toast notifications, placed `"Render Chat"` and `"Open Folder"` first on `Broadcast Complete` task cards, and relabeled `download_vod_chat` to `"Re-fetch VOD Chat"`.

### Domain 4B: Onboarding, Settings Dirty-State Protection & Recovery Surfacing (`src/App.tsx`, `src/routes/api.ts`)

#### 4.4 [COMPLETED in `v4.8.7` — UX-B2] Settings Dirty-State Protection & Sync Isolation
- **Status:** ✅ Completed in `v4.8.7`.
- **Location:** `src/App.tsx`
- **Resolution Applied:** Added `isConfigDirty` tracking (`updateDraftConfig`), prevented `toggleAutoRender` from overwriting unsaved Settings edits, added an inline `"Unsaved changes"` badge with a `"Discard"` button in the Settings footer, and added a confirmation modal (`Stay Here` / `Discard & Leave` / `Save & Leave`) when navigating away from Settings with unsaved changes.

#### 4.5 [COMPLETED in `v4.8.7` — UX-H1] Replace Phantom `@channel1` / `@channel2` Cards with True Empty Slot UI
- **Status:** ✅ Completed in `v4.8.7`.
- **Location:** `src/App.tsx` (`channelsToDisplay`, `commitChannelName`, `clearChannelSlot`)
- **Resolution Applied:** Replaced literal `"channel1"`/`"channel2"` padding with explicit `[configured[0] || null, configured[1] || null]` slots, rendered a dedicated **"Unassigned Stream Slot"** card with inline handle assignment when a slot is empty, and added a `"Clear Slot"` (`Trash2`) button next to paused channel handles.

#### 4.6 [COMPLETED in `v4.8.7` — UX-H2] Expose Folder Video Recovery (`/api/recover-folder-video`) & Folder/File Picker in UI
- **Status:** ✅ Completed in `v4.8.7`.
- **Location:** `src/routes/api.ts` (`GET /api/recent-folders`) & `src/App.tsx` (`Recover Folder Video` & `Manual Chat Render` modals)
- **Resolution Applied:** Added `GET /api/recent-folders` scanning `getResolvedSavePath()` for recent session folders, `.json` chat files, and raw `.ts` chunk counts; added `"Recover Folder Video"` and `"Manual Chat Render"` quick-action buttons on the `Livestream Monitor` header; and populated both modals with recent session/file dropdowns.

---

## Phase 5: Frontend UX Polish, Code Hygiene & Version Sync *(Priority: P3 — Minor / Polish)* — ✅ COMPLETED (`v4.8.7`)

**Objective:** Fix the hardcoded toast header, replace blocking `window.alert()` calls, reset modal state on open, add log filtering and OAuth visibility ergonomics, unify configuration fallbacks, clean up dead code, and synchronize the application version badge per `AGENTS.md` Rule 2.

### Domain 5A: Non-Blocking Feedback, Modals & Log Ergonomics (`src/App.tsx`, `src/routes/api.ts`)

#### 5.1 [COMPLETED in `v4.8.7` — UX-P1] Fix Global Toast Banner Icon/Title & Replace Blocking `window.alert()` Calls
- **Status:** ✅ Completed in `v4.8.7`.
- **Location:** `src/App.tsx`
- **Resolution Applied:** Added `showToast(text, type, title)` with a managed ref timer, replaced all 6 `alert(...)` calls with non-blocking toast notifications, updated the toast banner to render context-specific icons (`AlertTriangle`, `CheckCircle2`, `Folder`) and titles, and removed unused `isTogglingMonitoring` state.

#### 5.2 [COMPLETED in `v4.8.7` — UX-P2] Reset Manual Video Splice Modal State on Open
- **Status:** ✅ Completed in `v4.8.7`.
- **Location:** `src/App.tsx`
- **Resolution Applied:** Reset `setSpliceAction('split_new_part')` whenever opening the Manual Splice modal so a disabled radio option (`append_previous` on Game 1) is never pre-selected.

#### 5.3 [COMPLETED in `v4.8.7` — UX-P3, UX-P4 & UX-P5] System Log Filter Bar, OAuth Show/Hide Toggle & Danger Zone Separation
- **Status:** ✅ Completed in `v4.8.7`.
- **Location:** `src/App.tsx`
- **Resolution Applied:** Added keyword search and category filter pills (`All Events`, `Errors & Warnings`, `Video & Stitch`, `Chat & Render`) with semantic red/amber highlighting in `System Log`; added an `Eye`/`EyeOff` show/hide toggle and accurate 30-char `auth-token` placeholder on `Browser OAuth Token`; and moved `"Reboot Program"` into a separated `"Emergency Reset"` danger zone card.

#### 5.4 [COMPLETED in `v4.8.7`] Unify `gameSwitchBufferMins` Fallback in `/api/status`
- **Status:** ✅ Completed in `v4.8.7`.
- **Location:** `src/routes/api.ts` (line 260)
- **Resolution Applied:** Standardized the `pendingGameSwitch` buffer fallback to `5` minutes across all backend and frontend modules.

### Domain 5B: Dead Code Cleanup & Version Synchronization (`server.ts`, `src/routes/api.ts`, `src/services/*.ts`, `package.json`, `src/App.tsx`)

#### 5.5 [COMPLETED in `v4.8.7` / `v4.9.0`] Remove Unused Imports and Dead Declarations
- **Status:** ✅ Completed in `v4.9.0`.
- **Location:** `server.ts`, `src/routes/api.ts`, `src/services/twitch.ts`, `src/services/chat.ts`, `src/services/download.ts`, `src/services/video.ts`
- **Resolution Applied:** Removed unused `fileURLToPath`, `__filename`, `__dirname`, and `checkStreamStatus` from `server.ts`; removed unused `CONFIG_FILE`, `CONFIG_BAK_FILE`, `getMonitoringInterval`, `setMonitoringInterval`, and `finalizeLiveDownload` imports from `src/routes/api.ts`; removed unused `AxiosRequestConfig` from `src/services/twitch.ts`; removed unused `axios`, `Parser`, `getTwitchHeaders`, and `twitchAxios` from `src/services/chat.ts`; removed unused `getTwitchHeaders`, `downloadVodChat`, and shadowed `streamAgeMs`/`wasAlreadyLive` declarations from `src/services/download.ts`; and removed unused local variables (`runSucceeded`, `customStitchError`, `remainingVod`) from `src/services/video.ts`.

#### 5.6 [COMPLETED in `v4.9.0`] Synchronized Version Increment (`AGENTS.md` Rule 2)
- **Status:** ✅ Completed in `v4.9.0`.
- **Location:** `package.json`, `src/App.tsx`, `README.md`
- **Resolution Applied:** Incremented minor release version to `v4.9.0` across `package.json`, the sidebar header badge in `src/App.tsx`, and `README.md`.

---

## Repository & GitHub Readiness (`v4.8.5` — ✅ COMPLETED)

- [x] **Comprehensive `README.md`:** Documented features, architecture, prerequisites (`ffmpeg`, `TwitchDownloaderCLI`), Windows background service installation (`install.bat`/`uninstall.bat`), OAuth configuration, and output file schemas.
- [x] **Hardened `.gitignore` & Tracked State Cleanup:** Added `config.json` (protecting `browserOAuthToken`), `state.json`, `app.lock`, `system.log.*`, `daemon/`, `TwitchDownloader/`, and `bin/` to `.gitignore`; removed tracked `state.json` from git; created `config.example.json`.
- [x] **MIT License & CI Pipeline:** Added `LICENSE` and `.github/workflows/ci.yml` (`npm run lint` + `npm run build` on Node 20.x & 22.x).
- [x] **`package.json` Hygiene:** Added `description`, `license`, and `engines` metadata, and removed the unused `@google/genai` dependency.

---

## Verification & Acceptance Checklist

- [x] **Type-Checking & Build Verification (Phases 1–5):** `npm run lint` (`tsc --noEmit`) and `npm run build` pass with zero errors (`v4.9.0`).
- [x] **Phase 1 Acceptance (`v4.8.5`):**
  - [x] Mid-stream resumption ("VOD Backfill Current Game") preserves the original `currentGame.startTimeOffset` when computing backfill range (`1.1`).
  - [x] CMAF 10s VOD chunks and standard 2s VOD chunks both compute accurate durations and never log `NaN` (`1.2`).
  - [x] Initial mid-stream VOD Backfill prompt (`prompt_backfill_${streamId}`) auto-selects `"Skip Backfill (Record Live Only)"` after 60 seconds if unanswered so `liveChatBuffer` never freezes in RAM (`1.3`).
  - [x] Stopping a stream (`POST /api/stop`, `POST /api/force-stitch`, `POST /api/config`) awaits `stopActiveDownload` completion before `triggerFinalizeFlow` slices or renders chat (`1.4`).
  - [x] Recovery auto-backfill (`shouldAutoBackfill`) stores its promise on `session.activeChatBackfillPromise` and is awaited on shutdown (`1.5`).
- [x] **Phase 2 Acceptance (`v4.8.6`):**
  - [x] No remaining occurrences of `* 2` chunk duration assumptions or unanchored `firstChunkInVideo * avgChunkDur` in `src/services/download.ts` or `src/services/video.ts`.
  - [x] Custom splice actions (`append_previous`, `extract_clip`) and Game 1 slicing align chat offsets to real broadcast presentation time (`initialJoinOffsetSec` + relative chunk delta).
- [x] **Phase 3 Acceptance (`v4.8.6`):**
  - [x] All external HTTP calls (Twitch GQL, CDN segments, BTTV, FFZ, 7TV) enforce request timeouts and bounded retries.
  - [x] `scheduleStateSave` guarantees trailing state changes are persisted even if triggered while a previous disk write is in flight.
- [x] **Phase 4 Acceptance (`v4.8.7`):**
  - [x] Completed recording tasks, active stream cards, and Settings provide working `"Open Folder"` actions (`4.1`) and completed VOD Backfill tasks offer a direct `"Render Chat"` button (`4.2`).
  - [x] Settings modifications use an isolated draft state with an unsaved-changes guard on tab navigation (`4.4`), and empty channel slots render a dedicated `"Unassigned Stream Slot"` state (`4.5`).
  - [x] Folder Video Recovery (`POST /api/recover-folder-video`) and recent recording folder selection (`GET /api/recent-folders`) are accessible directly from the UI (`4.6`).
- [x] **Phase 5 Acceptance (`v4.9.0`):**
  - [x] Zero `window.alert()` calls remain in `src/App.tsx`, and the global toast banner displays context-appropriate icons and titles (`5.1`).
  - [x] Manual Splice modal resets `spliceAction` on open (`5.2`), System Log supports search/severity filtering (`5.3`), and `package.json` + `src/App.tsx` + `README.md` versions match `v4.9.0` (`5.6`).
