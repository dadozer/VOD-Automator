# Stability & Reliability Plan — Phase 4: Storage Safety & Multi-Instance Mutex

This plan implements the final remaining phase (**Phase 4**) of `docs/STABILITY_RELIABILITY_PLAN.md`, while preserving `docs/CODE_AUDIT_REMEDIATION_PLAN.md` on the shelf for later.

---

## Scope of Changes

### 4.1 Disk Capacity Pre-Flight & Safety Valve (`src/services/download.ts`)
- **Disk Space Helper (`checkDiskSpace`):**
  - Implement a cross-platform helper using Node's native `fs.promises.statfs` (evaluating `stat.bavail * stat.bsize`) on the target save directory (falling back to `PROJECT_ROOT` if the channel directory does not yet exist).
- **Pre-Flight Check Before Recording Starts:**
  - In `startRecordingSession` (and before starting VOD backfill downloads), check free disk space on `config.savePath`.
  - If free space is **< 2 GB**, log an error (`Disk space critically low (< 2 GB free). Aborting recording start for ${channel} to prevent disk exhaustion.`), skip session initialization, and return safely.
  - If free space is **< 5 GB**, log a high-priority warning (`Low disk space warning (< 5 GB free) while starting session for ${channel}.`).
- **Periodic 5-Minute Check During Active Polling:**
  - Track `lastDiskCheckMs` on each active `StreamSession` (or per-channel runtime tracker) inside `pollPlaylist`.
  - Every 5 minutes (`300,000 ms`), run `checkDiskSpace(session.folderPath)`:
    - **Threshold 1 (< 5 GB free):** Log a high-priority warning to the UI and `system.log` (`Low disk space warning: X.XX GB remaining on storage volume for ${channel}`).
    - **Threshold 2 (< 2 GB free):** Trigger the **Emergency Storage Safety Valve**:
      1. Log a critical error explaining that recording is being gracefully halted due to `< 2 GB` remaining disk space.
      2. Mark `session.isStopping = true` and clear `session.playlistPollInterval`.
      3. Stop live chat recording (`stopChatRecording(channel)`) and seal the chat JSON file cleanly (`await repairChatJsonFile(session.chatFilePath, ...)`).
      4. Finalize and stitch existing live chunks recorded so far (`await stitchVideoChunks(session, undefined, 'live')`) if enough chunks exist, ensuring recorded media is not orphaned or corrupted.

### 4.2 Single-Instance Atomic Lock File (`server.ts`)
- **PID Lock Acquisition (`PROJECT_ROOT/app.lock`):**
  - At the very start of `startServer()`—before `loadState()` or `startMonitoring()`—check for `path.join(PROJECT_ROOT, 'app.lock')`.
  - If `app.lock` exists, read the stored PID and test liveness via `process.kill(pid, 0)`:
    - If `process.kill(pid, 0)` succeeds or throws `EPERM` (process is alive), log a clear message (`Another instance of VOD Automator (PID ${pid}) is already running. Aborting startup to prevent split-brain recording.`) and exit immediately (`process.exit(1)`) without modifying `app.lock` or `state.json`.
    - If `process.kill(pid, 0)` throws `ESRCH` (or the lock file contains invalid data), treat the lock as stale from a prior hard crash and overwrite it with the current `process.pid`.
  - Also defer `loadState()` and `startMonitoring()` until the lock is acquired and HTTP port binding succeeds so two processes can never enter the monitoring loop simultaneously.
- **Lock Cleanup on Shutdown:**
  - Remove `app.lock` (only if its contents match `String(process.pid)`) inside `gracefulShutdown()` and a `process.on('exit')` handler.

### 4.3 Health Check Diagnostic Endpoint (`src/routes/api.ts` & `src/services/chat.ts`)
- **WebSocket Health Helper (`src/services/chat.ts`):**
  - Export `getActiveChatSocketsStatus()` returning whether all active chat sessions have an open WebSocket connection (`wsConnected: boolean`) along with per-channel connection state.
- **Diagnostic Route (`GET /api/health` in `src/routes/api.ts`):**
  - Return `200 OK` with JSON payload:
    - `status`: `'ok'`
    - `uptime`: `Math.floor(process.uptime())` (in seconds)
    - `isMonitoring`: `Boolean(state.isMonitoring)`
    - `lastCheckTime`: `state.lastCheckTime || null`
    - `activeSessions`: `Object.keys(state.activeDownloads).length`
    - `wsConnected`: boolean indicating whether active chat listeners are healthy (true when no chat sessions are active or all active chat sockets are in `OPEN` state, plus detailed socket count).

### 4.4 Documentation & Version Sync (`package.json`, `src/App.tsx`, `docs/STABILITY_RELIABILITY_PLAN.md`)
- Mark **Phase 4** as `[COMPLETED - v4.8.1]` in `docs/STABILITY_RELIABILITY_PLAN.md`.
- Increment version from `4.8.0` to `4.8.1` (or `4.9.0` if you prefer a minor bump for completing the 4-phase Stability & Reliability Plan) in `package.json` and the header badge in `src/App.tsx`.
