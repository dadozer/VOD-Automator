# Full-Spectrum Twitch Chat & Broadcast Event Capture (`v5.0.0`)

Upgrades VOD Automator's live chat recording engine from basic `PRIVMSG`-only capture to a browser-parity, dual-WebSocket event recorder (Twitch IRCv3 + Twitch PubSub) that captures every chat and overlay event—including first-time chatter flags, replies, power-ups, subscriptions, raids, announcements, moderator timeouts/bans/deletions, predictions, polls, pinned messages, channel point redemptions, and hype trains—while maintaining **100% drop-in backward compatibility** with both your current un-upgraded renderer and stock `TwitchDownloaderCLI`.

---

### User Review & Critical Decisions

> [!IMPORTANT]
> **100% Backward Compatibility Guaranteed (Updated Design)**:
> If we placed non-chat events (like 1-second Prediction update ticks or Moderator Timeouts) directly inside `comments[]`, an un-upgraded `TwitchDownloader` renderer would treat every single tick as a chat message and draw hundreds of `"System: ..."` lines in the rendered video.
>
> To guarantee **zero-friction backward compatibility** with your current renderer and old `TwitchDownloaderCLI` builds while keeping the timeline linear for your upgraded C# fork, the schema uses a **Two-Tier Backward-Compatible Structure**:
> 1. **Enriched `comments[]` (100% Stock-Compatible)**: Holds all actual scrolling chat lines (`PRIVMSG`) and chat banners (`USERNOTICE` for Subs, Resubs, Gift Subs, Raids, Announcements, Watch Streaks). We populate native `TwitchDownloader` fields (`user_notice_params` and `bits_spent`) so **even your un-upgraded renderer and old `TwitchDownloaderCLI` will immediately render Sub/Gift/Raid banners and Bits natively**, while extra per-message fields (`is_first_message`, `reply`, `power_up`, `event_data`) are safely ignored by `System.Text.Json` until you upgrade your C# fork.
> 2. **Chronological `events[]` Top-Level Array (Ignored by Old Renderers)**: Holds all non-message broadcast, moderation, and overlay widget events (`clearchat` timeouts/bans, `clearmsg` deletions, `roomstate`, 1s `prediction` ticks, 1s `poll` ticks, `pinned_chat`, `channel_points`, `hype_train`), each stamped with the exact same `content_offset_seconds` timeline float. Old renderers silently ignore the top-level `"events"` key, while your upgraded C# renderer can step through both arrays linearly (or merge them in one line of LINQ).

- **Confirmed Decision 1 (100% Backward-Compatible `FileInfo` & Header)**: `FileInfo.Version` remains strictly `{ "Major": 1, "Minor": 5, "Patch": 3 }` and `streamer.id` remains a 32-bit integer (`System.Int32`) so stock `TwitchDownloaderCLI` version/schema checks never fail. A new optional `"schemaVersion": "2.0-extended"` field is added at the root for your upgraded renderer to detect extended files.
- **Confirmed Decision 2 (Capture Everything in the JSON)**: Captures all IRCv3 tags, IRC commands (`PRIVMSG`, `USERNOTICE`, `CLEARCHAT`, `CLEARMSG`, `ROOMSTATE`), and public PubSub channel topics (`predictions-channel-v1`, `polls`, `pinned-chat-updates-v1`, `community-points-channel-v1`, `hype-train-events-v1`, `raid`).
- **Confirmed Decision 3 (Crash-Safe Disk Streaming for Both `comments[]` and `events[]`)**: During live recording, `comments[]` streams directly to `chat_[date].json` as before, while `events[]` streams to a lightweight crash-safe sidecar (`chat_[date].events.jsonl`) and is sealed directly into `"events": [...]` inside `chat_[date].json` upon stream conclusion, game-switch slicing, manual splice, or repair.
- **Confirmed Decision 4 (Formal C# Renderer Spec Document)**: Generates `docs/CHAT_EVENT_SCHEMA_SPEC.md` with complete JSON examples, drop-in C# `System.Text.Json` classes, and a 5-line C# timeline merger pattern for your renderer project.

---

### 1. Overview & Core Concept

- **What It Does**:
  1. **Expanded IRCv3 WebSocket Engine (`wss://irc-ws.chat.twitch.tv:443`)**:
     - Unescapes full IRCv3 tag payloads (`\s`, `\:`, `\\`, `\r`, `\n`) and parses both body and bodyless IRC commands.
     - **Enriches `comments[]` (`PRIVMSG`)**:
       - **First-Time Chatter** (`first-msg=1`) & **Returning Chatter** (`returning-chatter=1`)
       - **Threaded Replies** (`reply-parent-msg-id`, `reply-parent-user-login`, `reply-parent-display-name`, `reply-parent-msg-body`)
       - **Highlighted Messages & Power-Ups** (`msg-id=highlighted-message`, `gigantified-emote-message`, `animation-id`, `custom-reward-id`)
       - **Cheers/Bits** (`bits` $\rightarrow$ populates native `bits_spent` for stock `TwitchDownloader` compatibility)
       - **Paid Pinned / Hype Chat** (`pinned-chat-paid-*`)
     - **Adds `USERNOTICE` to `comments[]`**:
       - Captures Subscriptions (`sub`, `resub`), Gift Subscriptions (`subgift`, `submysterygift`), Prime/Gift upgrades, Announcements (`announcement` with banner color), Incoming Raids (`raid`), and Watch Streaks (`viewermilestone`).
       - Populates `message.user_notice_params` with the exact IRCv3 tag dictionary (`msg-id`, `system-msg`, `msg-param-cumulative-months`, `msg-param-sub-plan`, `msg-param-recipient-display-name`, `msg-param-color`, etc.) so stock `TwitchDownloader` renders sub/announcement boxes natively right away.
     - **Streams Moderation & Room Events to `events[]`**:
       - **`CLEARCHAT`**: User Timeouts (`ban_duration_seconds`, `target_user_id`, `target_user_login`), Permanent Bans, and full room `/clear` actions.
       - **`CLEARMSG`**: Single-message deletions (`target_msg_id`, `target_user_login`, `deleted_message_body`) so your upgraded renderer can retroactively cross out or hide deleted messages at the exact timestamp a moderator deleted them.
       - **`ROOMSTATE`**: Slow mode, Sub-only, Follower-only, Emote-only, and R9K toggles.
  2. **Companion Twitch PubSub WebSocket Engine (`wss://pubsub-edge.twitch.tv/v1`)**:
     - Automatically connects alongside the IRC socket for every active live recording session using the channel's numeric `twitchId` (no OAuth token required for public channel topics).
     - Subscribes to public channel topics and writes normalized timeline entries to `events[]`:
       - `predictions-channel-v1.<twitchId>` (Created, 1s live point/odds updates with state-diff deduplication, Locked, Resolved with winning outcome, Cancelled)
       - `polls.<twitchId>` (Created, 1s live vote updates with state-diff deduplication, Completed, Archived)
       - `pinned-chat-updates-v1.<twitchId>` (Moderator/Broadcaster pinned and unpinned messages, pin duration, pinned-by metadata, and full message payload)
       - `community-points-channel-v1.<twitchId>` (Custom Channel Point reward redemptions)
       - `hype-train-events-v1.<twitchId>` (Hype Train start, progress/level-ups, conclusion)
       - `raid.<twitchId>` (Raid countdowns and execution)
     - Maintains automatic 4-minute `PING`/`PONG` heartbeats with jitter and exponential reconnection backoff.
  3. **Seamless Game Slicing, Drift Compensation & Crash Repair**:
     - Both `comments[]` and `events[]` share the exact same `content_offset_seconds` anchor (`videoStartTimeMs`).
     - During automatic game-switch slicing, 4-mode manual splicing, and clock-drift compensation, VOD Automator slices and time-shifts both `comments[]` and `events[]` in lockstep. If a sticky overlay widget (an active Prediction, Poll, or Pinned Message) began before a game split and is still active when the new segment starts, its latest state snapshot is automatically carried over to `0.0s` of the new segment.
  4. **Formal C# Renderer Schema Specification (`docs/CHAT_EVENT_SCHEMA_SPEC.md`)**:
     - Documents every extended field on `Comment` and every object in `events[]`, complete with copy-pasteable C# `System.Text.Json` models and a linear timeline consumer guide for your `TwitchDownloader` fork.

---

### 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Zero-Config Automatic Capture**: Whenever a monitored channel goes live, both the IRCv3 WebSocket and the PubSub WebSocket start automatically.
  2. **Works Immediately with Current Renderer**: Passing any newly recorded `.json` file into your current un-upgraded renderer (or stock `TwitchDownloaderCLI`) works without a single change—and immediately gains native rendering of Subscriptions, Gift Subs, Raids, Announcements, and Bits.
  3. **Live Stream Card Telemetry**: Active stream cards on the Livestream Monitor display live chat & broadcast event counts so you can see both chat messages and rich PubSub/moderation events arriving in real time.
- **Visual Identity & Theme**:
  - Retains VOD Automator's dark appliance theme (`#0a0a0a` background, `#141416` cards, `purple-500` and `cyan-400` badges, monospace numeric counters).

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: Enriched `comments[]` + Top-Level `events[]` (Why Not Put Everything in `comments[]`?)**
  - *Chosen Approach*: Keep `comments[]` strictly for items that are visible chat lines or `USERNOTICE` banners (`PRIVMSG` + `USERNOTICE`), and store non-chat broadcast/moderation events (`CLEARCHAT`, `CLEARMSG`, `ROOMSTATE`, `predictions`, `polls`, `pinned_chat`, `hype_train`, `channel_points`) in a top-level chronological `"events": [...]` array.
  - *Why*: An un-upgraded `TwitchDownloader` renderer iterates over `comments[]` and draws every entry as a chat message. If 1-second prediction updates or timeout events were placed inside `comments[]`, un-upgraded renderers would draw hundreds of unwanted system lines in the video. Putting them in `"events": [...]` makes the file **100% drop-in compatible with old renderers** (which ignore unknown root keys) while allowing your upgraded C# renderer to iterate through both sorted lists with a trivial two-pointer cursor.

- **Decision 2: Crash-Safe `.events.jsonl` Sidecar During Live Recording**
  - *Chosen Approach*: Append incoming non-comment events to `chat_[date].events.jsonl` during live capture, then embed them as `"events": [...]` when sealing `chat_[date].json` and when slicing per-game JSON files.
  - *Why*: Avoids holding thousands of 1-second prediction/poll updates in Node.js RAM during 12+ hour broadcasts and guarantees zero lost events even if the host PC loses power mid-stream.

- **Decision 3: State-Diff Deduplication for 1-Second PubSub Updates**
  - *Chosen Approach*: Record live `event-updated` ticks from `predictions-channel-v1` and `polls` (capped at 1 tick/sec), skipping duplicate ticks when total points/votes have not changed.
  - *Why*: Preserves 1-second animation fidelity for your renderer while keeping JSON file sizes lean.

---

### 4. Technical Architecture & Data Strategy *(Technical Reference)*

#### Architecture & Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                        LIVE BROADCAST RECORDING SESSION                          │
│                        (Anchored to videoStartTimeMs)                            │
└───────────────────┬──────────────────────────────────────────┬───────────────────┘
                    │                                          │
                    ▼                                          ▼
┌───────────────────────────────────────┐  ┌───────────────────────────────────────┐
│   WebSocket 1: Twitch IRCv3 Engine    │  │   WebSocket 2: Twitch PubSub Engine   │
│     wss://irc-ws.chat.twitch.tv       │  │     wss://pubsub-edge.twitch.tv/v1    │
├───────────────────────────────────────┤  ├───────────────────────────────────────┤
│ • PRIVMSG (First-Msg, Replies, Bits,  │  │ • predictions-channel-v1.<twitchId>   │
│   Highlights, Power-Ups, Hype Chat)   │  │ • polls.<twitchId>                    │
│ • USERNOTICE (Subs, Gifts, Raids,     │  │ • pinned-chat-updates-v1.<twitchId>   │
│   Announcements, Watch Streaks)       │  │ • community-points-channel-v1.<id>    │
│ • CLEARCHAT (Timeouts, Bans, Clears)  │  │ • hype-train-events-v1.<twitchId>     │
│ • CLEARMSG (Single Message Deletions) │  │ • raid.<twitchId>                     │
│ • ROOMSTATE (Slow/Sub/Emote Modes)    │  │ • 4m PING/PONG Keepalive & Reconnect  │
└─────────┬───────────────────┬─────────┘  └───────────────────┬───────────────────┘
          │                   │                                │
   (PRIVMSG + USERNOTICE)     └───────────────┬────────────────┘
          │                                   │ (Moderation, Roomstate & PubSub)
          ▼                                   ▼
┌───────────────────────────────┐   ┌──────────────────────────────────────────────┐
│   Enriched `comments[]`       │   │   Chronological `events[]` (`.events.jsonl`) │
│ • 100% Stock TD Compatible    │   │ • Ignored by old/un-upgraded renderers       │
│ • Native `user_notice_params` │   │ • Same `content_offset_seconds` float clock  │
│ • Extended `event_data` tags  │   │ • Predictions, Polls, Pins, Timeouts, Bans   │
└───────────────┬───────────────┘   └──────────────────────┬───────────────────────┘
                └─────────────────────┬────────────────────┘
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                 SEALED & SPLICED CHAT JSON (`chat_[date].json`)                  │
│ • Contains `{ FileInfo, streamer, video, comments, events, embeddedData }`       │
│ • Synchronized across Game Switch Slicing, 4-Mode Manual Splice, Clock Drift     │
│   Compensation, and Pre-Flight JSON Repair                                       │
│ • Documented in Formal C# Renderer Specification (`CHAT_EVENT_SCHEMA_SPEC.md`)   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

#### Backward-Compatible JSON Structure Overview

```json
{
  "FileInfo": {
    "Version": { "Major": 1, "Minor": 5, "Patch": 3 },
    "CreatedAt": "2026-11-01T20:00:00.000Z",
    "UpdatedAt": "2026-11-01T23:00:00.000Z"
  },
  "schemaVersion": "2.0-extended",
  "streamer": { "name": "channel_name", "id": 12345678 },
  "video": {
    "title": "Stream Title",
    "id": "987654321",
    "start": 0,
    "end": 3600.5,
    "length": 3600.5
  },
  "comments": [
    {
      "_id": "msg-uuid",
      "created_at": "2026-11-01T20:01:12.345Z",
      "content_offset_seconds": 72.345,
      "commenter": { "display_name": "Viewer", "_id": "111", "name": "viewer" },
      "message": {
        "body": "Hello stream!",
        "fragments": [{ "text": "Hello stream!" }],
        "user_badges": [{ "_id": "subscriber", "version": "6" }],
        "user_color": "#00FF7F",
        "bits_spent": 0,
        "user_notice_params": {
          "first-msg": "1",
          "reply-parent-msg-id": "parent-uuid",
          "reply-parent-display-name": "OtherUser",
          "reply-parent-msg-body": "Welcome!"
        }
      },
      "event_type": "chat_message",
      "event_data": {
        "is_first_message": true,
        "is_returning_chatter": false,
        " is_highlighted": false,
        "reply": {
          "parent_msg_id": "parent-uuid",
          "parent_user_id": "222",
          "parent_user_login": "otheruser",
          "parent_display_name": "OtherUser",
          "parent_msg_body": "Welcome!"
        }
      }
    }
  ],
  "events": [
    {
      "_id": "evt-uuid",
      "created_at": "2026-11-01T20:02:00.100Z",
      "content_offset_seconds": 120.1,
      "event_type": "clearchat | clearmsg | roomstate | prediction | poll | pinned_chat | channel_points | hype_train | raid",
      "category": "timeout | ban | clear_chat | delete_message | prediction_created | prediction_updated | prediction_locked | prediction_resolved | poll_created | poll_updated | poll_completed | pin_message | unpin_message | reward_redeemed | hype_train_start | hype_train_progress | hype_train_end",
      "data": { }
    }
  ],
  "embeddedData": {
    "thirdParty": [],
    "firstParty": [],
    "twitchBadges": []
  }
}
```
