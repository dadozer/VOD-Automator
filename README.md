# VOD Automator

**VOD Automator** (`v5.2.5`) is a local, self-hosted Twitch livestream & chat recording appliance built with Node.js, TypeScript, and React. It monitors up to two Twitch channels simultaneously, captures source-quality video segments (including **1440p60 HEVC / Enhanced Broadcasting CMAF** and **1080p60 H.264 MPEG-TS**) alongside full-spectrum IRCv3 + PubSub broadcast events (with 1st-party Twitch emotes, Twitch badges, BTTV, FFZ, 7TV, and Giphy emotes embedded directly for offline/archival rendering), supports modular per-channel capture (`Video + Chat`, `Video Only`, or `Chat Only`), automatically slices broadcasts by game category, backfills missed VOD footage when joining mid-stream, and renders synchronized chat overlay videos via `ChatRenderCLI` (or legacy `TwitchDownloaderCLI`) with per-game resolution profiles.

---

## ✨ Key Features

- **Zero-Loss Live Video & Full-Spectrum Chat + Event Capture**
  - Polls Twitch Usher & GraphQL with automatic outage fallback and live-edge lock-on.
  - **Modular Per-Channel Capture (`Video + Chat` | `Video Only` | `Chat Only`):** Configure each monitored channel card prior to going live (or while monitoring is paused) to record both video and chat, video only, or chat only—while preserving automated game switch buffers, 8-hour marathon autosplicing, and 4-mode manual splicing in all modes.
  - **Dual-WebSocket Event Engine (`v2.0-extended` Schema, 100% Backwards-Compatible):**
    - **WebSocket 1 (`wss://irc-ws.chat.twitch.tv:443`):** Captures enriched `PRIVMSG` (First-Time Chatter, Returning Chatter, Highlighted Messages, Threaded Replies, Bits/Cheers, Hype Chat, Gigantified Emotes, Shared Chat), `USERNOTICE` (Subscriptions, Resubs, Gift Subs, Community Mystery Gifts, Raids, Announcements, Watch Streaks), and Moderation (`CLEARCHAT`, `CLEARMSG`, `ROOMSTATE`).
    - **WebSocket 2 (`wss://pubsub-edge.twitch.tv/v1`):** Captures real-time ~1s channel Predictions, Polls, Pinned Chat Messages (`pinned-chat-updates-v1`), Channel Point Redemptions, Hype Trains, and Outgoing Raids with active overlay state carry-over across game splices.
    - **Full `ChatRenderCLI` Integration & Legacy `TwitchDownloaderCLI` Compatibility:** Enriched `PRIVMSG` and `USERNOTICE` entries populate native `user_notice_params`, `bits_spent`, and `event_data` inside `comments[]`, while non-chat moderation and overlay updates reside in top-level `"events": [...]`. Supports all `ChatRenderCLI` flags (`--prediction-mode`, `--poll-mode`, `--pinned-chat-mode`, `--hype-train-mode`, `--moderation-mode`, `--jobs`, `--image-cache-mb`, `--highlight-users`, etc.) with automatic fallback if a legacy binary is used. Automatically includes the monitored channel's broadcaster login in `--highlight-users` when user highlighting is enabled. See [`docs/CHAT_EVENT_SCHEMA_SPEC.md`](docs/CHAT_EVENT_SCHEMA_SPEC.md) for the formal Renderer Integration Specification.
- **Twitch Enhanced Broadcasting (1440p60 HEVC / CMAF) Support**
  - Automatically advertises `av1,h265,h264` capabilities to Twitch Usher and selects the highest pixel-area, framerate, and bitrate source stream.
  - Automatically upgrades CloudFront VOD backfills to `/chunked/index-dvr.m3u8` (1440p60 HEVC) even when unauthenticated tokens cap master manifests at 1080p60.
  - Strictly isolates live (`init.mp4`) and VOD (`vod_init.mp4`) CMAF initialization headers.
- **Automated Game Category Slicing & Transition Buffering**
  - Detects game changes mid-broadcast, applies a configurable leading/trailing buffer (default: `5 minutes` on both sides), and automatically remuxes completed game segments in the background while live recording continues.
  - **Subathon / Extended Stream Autosplice:** Automatically splits single-game marathon broadcasts (e.g., at the 8-hour mark once a game hits 9 hours) with zero dropped frames.
- **4-Mode Live Manual Video Splice**
  - Cut or extract footage at any moment during a live broadcast:
    1. **Append Extension to Previous Game:** Stitch extra post-switch footage onto the previous game segment and advance the current game's start boundary.
    2. **Extract Standalone Highlight / Clip:** Non-destructively export the whole current game so far or the last `X` minutes without interrupting the master recording.
    3. **Split Game into New Part / Chapter:** Finalize the current segment immediately and start Part `N+1` with leading buffer preserved.
    4. **End Current Game & Await Next Category Switch:** Finalize and stitch the outgoing game immediately (with a configurable leading buffer override defaulting to `2x` buffer time) while recording upcoming footage into a pending segment (`[Previous Game] Part 2`) that automatically adopts the new game name once the broadcaster updates their Twitch category.
- **Intelligent Mid-Stream & Crash Recovery (VOD Backfill)**
  - **Mid-Stream Join Prompt:** Joining a broadcast that is already live prompts to backfill the **Full VOD**, **Current Game Only** (using Twitch VOD chapter markers), or **No Backfill** (with a 60-second AFK auto-selection timer so unattended starts never stall).
  - **Downtime / Restart Gap Recovery:** Automatically detects missed segments after a system reboot or network drop and offers seamless VOD backfill of the interrupted game segment.
  - **Strict VOD vs. Live Isolation:** Standalone VOD backfills (`vod_seq_*.ts`) and live segments (`seq_*.ts`) are never interleaved into the same container, preventing timestamp and discontinuity corruption.
- **Automated & Custom Chat Rendering with Per-Game Resolution Profiles (`ChatRenderCLI` / `TwitchDownloaderCLI`)**
  - Probes exact container durations via `ffprobe` / `ffmpeg` and normalizes chat offsets with codec-specific sync presets (`-2.5s` for H.264 1080p, `-7.5s` for HEVC 1440p) and long-broadcast clock drift compensation.
  - **Per-Game Chat Render Resolution Profiles:** Configure custom `Width × Height` overrides for specific Twitch categories in **Settings → Render: Video & Output**, or click the active game badge directly on a live broadcast card to set or update that game's render resolution on the fly. Automatically applied by mid-stream, end-of-stream, and VOD backfill Auto-Render, as well as the Task Queue and Manual Chat Render modals.
  - Two dedicated Settings tabs (**Render: Video & Output** and **Render: Chat & Events**) configure parallel multi-FFmpeg rendering (`-j / --jobs`), decoded sprite cache budgets (`--image-cache-mb`), sticky top overlays (`Predictions`, `Polls`, `Pinned Chat`, `Hype Train`), moderation strikethroughs (`--moderation-mode`), and custom user highlighting.
- **Windows Background Service & Storage Safety**
  - One-click `install.bat` compiles the production bundle (`dist/server.js`) and registers **VOD Automator** as a native Windows Service (`node-windows`) running on `http://localhost:3000`.
  - Pre-flight and periodic 5-minute disk space checks warn at `< 20 GB` free and gracefully finalize/seal recordings at `< 5 GB` free to prevent disk exhaustion.
  - Real-time **System Log** with keyword search, category filters (`Errors & Warnings`, `Video & Stitch`, `Chat & Render`), and one-click **Open Folder** actions across all completed tasks.

---

## 🛠️ Prerequisites

1. **Operating System:** Windows 10/11 (primary target for Windows Service & `ChatRenderCLI.exe` / `TwitchDownloaderCLI.exe`), macOS, or Linux.
2. **Node.js:** `v20+` (LTS recommended).
3. **ChatRenderCLI / TwitchDownloaderCLI & FFmpeg:**
   - Place `ChatRenderCLI.exe` (or `TwitchDownloaderCLI.exe`) in `C:\TwitchDownloader\` or inside `./TwitchDownloader/` in the project root (or configure a custom path in the **Settings → Render: Video & Output** tab).
   - If `ffmpeg` / `ffprobe` are not already in the same folder as the CLI binary or on your system `PATH`, VOD Automator will automatically invoke `<CLI> ffmpeg -d` on first stitch to download it.

---

## 🚀 Quick Start

### Option A: Windows Background Service (Recommended on Windows)
1. Clone or extract this repository to a permanent folder on your machine.
2. Right-click **`install.bat`** and select **Run as administrator** (or double-click—it will automatically request elevation).
3. `install.bat` will:
   - Back up any existing `config.json`,
   - Install npm dependencies and compile the frontend + backend bundle (`dist/server.js`),
   - Register and start the **`VOD Automator`** Windows background service.
4. Open **`http://localhost:3000`** in your browser.
5. To remove the Windows Service later, run **`uninstall.bat`**.

### Option B: Manual / Cross-Platform CLI Execution
```bash
# 1. Install dependencies
npm install

# 2. Build frontend & bundled server
npm run build

# 3. Start production server on http://localhost:3000
npm start
```
For local development with hot-reloading:
```bash
npm run dev
```

---

## ⚙️ Configuration Guide

Open **`http://localhost:3000`** and navigate to the **Settings** tab:

1. **Browser OAuth Token (Optional, Recommended for 1440p60 & Ad-Free Capture):**
   - Log into `twitch.tv` in your browser, open Developer Tools (`F12` → **Application** / **Storage** → **Cookies**), copy the 30-character value of the `auth-token` cookie, and paste it into **Browser OAuth Token**.
   - Updating the token in Settings immediately refreshes active media playlists. If a token ever expires (`HTTP 401/403`), VOD Automator logs a warning and seamlessly falls back to unauthenticated capture so recordings never stall.
2. **Monitored Channels (Up to 2 Concurrent Streams):**
   - Enter comma-separated Twitch handles in **Settings → General**, or click any paused `@channel` handle directly on the **Livestream Monitor** dashboard to edit it in place.
3. **Save Path:**
   - Defaults to `downloads` (anchored to `<project_root>/downloads`), or provide any absolute path (e.g., `D:\TwitchVODs`).
4. **Game Switch Buffer & Reconnect Grace Period:**
   - **Game Switch Buffer (Default: `5 mins`):** Extra footage retained before and after a category change so game transitions are never cut abruptly.
   - **Reconnect Grace Period (Default: `5 mins`):** How long to wait during a brief streamer disconnect before automatically finalizing the broadcast.

---

## 📂 Output Directory Structure

Each broadcast is saved into an isolated folder under your configured `savePath`:

```text
downloads/
└── <channel>_<YYYY-MM-DD>_<streamId>/
    ├── 1_<game_one>_<YYYY-MM-DD>.mp4                  # Stitched live video for Game 1
    ├── 1_<game_one>_<YYYY-MM-DD>.json                 # Paired, zero-indexed chat JSON for Game 1
    ├── rendered_1_<game_one>_<YYYY-MM-DD>.mp4         # Rendered chat overlay video (when Auto-Render or Render Chat is used)
    ├── <game>_vod_backfill_<YYYY-MM-DD>.mp4           # Standalone VOD backfill video (if joined mid-stream)
    ├── <game>_vod_backfill_<YYYY-MM-DD>.json          # Paired standalone VOD backfill chat JSON
    ├── clip_<game>_5m_<YYYY-MM-DD>_<HHMMSS>.mp4       # Non-destructive highlight clip (if extracted mid-stream)
    ├── Broadcast Titles.txt                           # Timestamped log of stream title changes
    └── failed_segments.txt                            # Diagnostic log of any expired or unrecoverable HLS segments
```
*(Temporary `seq_*.ts` and `vod_seq_*.ts` segment files are automatically cleaned up once their corresponding `.mp4` container is stitched and verified via `ffprobe`.)*

---

## 🏗️ Project Architecture

```text
├── server.ts                  # Express HTTP server, single-instance lock (app.lock), crash guards & Vite middleware
├── src/
│   ├── App.tsx                # React 19 + Tailwind CSS dashboard, live monitor cards, task queue & modals
│   ├── types.ts               # Shared TypeScript interfaces for Config, ActiveDownloadSession, ActiveTask & Status
│   ├── routes/
│   │   └── api.ts             # REST API endpoints (/api/status, /api/config, /api/start, /api/stop, /api/channels/splice-game, etc.)
│   └── services/
│       ├── download.ts        # Stream status polling, HLS/CMAF segment downloading, game switch detection & VOD backfill
│       ├── video.ts           # FIFO FFmpeg remux queue, fMP4 pipe/concat assembly, container probing & paired chat slicing
│       ├── chat.ts            # Live Twitch IRC WebSocket client, VOD chat GQL pagination, JSON repair & TwitchDownloaderCLI runner
│       ├── twitch.ts          # Twitch GraphQL & Usher master playlist resolution (1440p60 HEVC sorting & CloudFront VOD upgrade)
│       ├── emotes.ts          # 7TV, BetterTTV, and FrankerFaceZ emote fetching & embedding
│       ├── ffmpeg.ts          # FFmpeg/FFprobe binary resolution, HEVC codec detection & container duration probing
│       └── state.ts           # Atomic config.json & state.json persistence, log rotation (system.log) & path self-healing
├── docs/
│   └── CHAT_EVENT_SCHEMA_SPEC.md # Formal v2.0-extended JSON schema & C# System.Text.Json integration spec for custom TwitchDownloader renderers
├── scripts/
│   ├── install-service.js     # Windows Service registration wrapper (node-windows -> dist/server.js)
│   └── uninstall-service.js   # Windows Service uninstaller
├── install.bat                # Elevated one-click Windows installer & updater
└── uninstall.bat              # Elevated one-click Windows service uninstaller
```
