# VOD Automator Extended Chat & Broadcast Event Schema (`v2.0-extended`)

## 1. Architecture & Backward-Compatibility Design

**VOD Automator (`v5.2.4`)** captures the full spectrum of Twitch live chat and broadcast overlay events using two simultaneous WebSocket connections per active stream:
1. **Twitch IRCv3 WebSocket (`wss://irc-ws.chat.twitch.tv:443`)** with `CAP REQ :twitch.tv/tags twitch.tv/commands`
2. **Twitch PubSub Edge WebSocket (`wss://pubsub-edge.twitch.tv/v1`)** listening to public channel overlay topics (`predictions-channel-v1`, `polls`, `pinned-chat-updates-v1`, `community-points-channel-v1`, `hype-train-events-v1`, `raid`)

### Why Two Top-Level Arrays (`comments[]` + `events[]`)?
To guarantee **100% drop-in backward compatibility** with both **`ChatRenderCLI`** and un-upgraded legacy **`TwitchDownloaderCLI`** binaries:
- **`FileInfo.Version`** remains `{ "Major": 1, "Minor": 5, "Patch": 3 }` and **`streamer.id`** remains a strict 32-bit integer.
- **`comments[]`** contains only visual chat items (`PRIVMSG` and `USERNOTICE` such as Subscriptions, Resubs, Sub Gifts, Community Mystery Gifts, Raids, Announcements, and Watch Streaks).
  - For `USERNOTICE` and Bits messages, VOD Automator populates stock `TwitchDownloader` fields (`user_notice_params` and `bits_spent`), meaning **even an un-upgraded `TwitchDownloader` renderer immediately renders sub/resub/gift/announcement boxes and cheers natively**.
  - Richer IRCv3 metadata (First-Time Chatter, Returning Chatter, Highlighted Message, Custom Channel Point Redemptions with text, Threaded Reply parent context, Bits Power-Ups / Gigantified Emotes, Paid Hype Chat, Shared Chat) is attached to each comment under `"event_type"` and `"event_data"`.
- **`events[]`** is a top-level, chronologically sorted array containing **non-chat moderation actions and live overlay state updates** (`clearchat`, `clearmsg`, `roomstate`, `prediction`, `poll`, `pinned_chat`, `channel_points`, `hype_train`, `raid`).
  - Keeping these out of `comments[]` ensures that an un-upgraded renderer never prints hundreds of `"System: Prediction updated..."` spam lines in chat.
  - Both `comments[]` and `events[]` share the exact same `content_offset_seconds` floating-point timeline (normalized to `0.0s` at the start of each sliced `.mp4` segment, and automatically shifted/scaled together during `--sync` and clock-drift compensation).

### Live Capture vs. VOD Backfill Availability
- **Live Capture (`*_live_*.json` / `1_<game>_<date>.json`)**: Contains the complete `v2.0-extended` dataset (`comments[]` with full IRCv3 tags + `events[]` with PubSub overlays and moderation timeline). Even when joining a stream mid-broadcast, VOD Automator connects both live WebSockets immediately at second `0` of detection and buffers all live events while awaiting your VOD backfill choice.
- **Standalone VOD Backfill (`*_vod_backfill_*.json`)**: Because Twitch's VOD comment database (`VideoCommentsByOffsetOrCursor`) permanently discards PubSub overlays, IRCv3 tags (`first-msg`, `reply-parent-*`, `msg-id`), and moderation events (retroactively purging deleted messages instead of recording `CLEARCHAT`/`CLEARMSG`), backfilled VOD segments contain standard chat messages, user badges, colors, and emotes (`events: []`).

---

## 2. Top-Level JSON Structure

```json
{
  "FileInfo": {
    "Version": { "Major": 1, "Minor": 5, "Patch": 3 },
    "CreatedAt": "2026-11-02T01:00:00.000Z",
    "UpdatedAt": "2026-11-02T04:30:00.000Z"
  },
  "schemaVersion": "2.0-extended",
  "streamer": {
    "name": "streamer_login",
    "id": 12345678
  },
  "video": {
    "title": "Stream Title",
    "id": "9876543210",
    "created_at": "2026-11-02T01:00:00.000Z",
    "start": 0,
    "end": 3600.452,
    "length": 3600.452,
    "viewCount": 1420,
    "game": "Elden Ring",
    "chapters": []
  },
  "comments": [
    /* Enriched PRIVMSG and USERNOTICE objects (see Section 3) */
  ],
  "events": [
    /* Chronological Moderation & PubSub Overlay events (see Section 4) */
  ],
  "embeddedData": {
    "thirdParty": [ /* 7TV, BTTV, FFZ, Giphy emotes (base64 + dimensions) */ ],
    "firstParty": [ /* 1st-party Twitch emotes used in comments[] (base64 + dimensions) */ ],
    "twitchBadges": [ /* Channel & global Twitch chat badges used in comments[] (base64 versions) */ ]
  }
}
```

---

## 3. Enriched `comments[]` Schema (`PRIVMSG` & `USERNOTICE`)

Every entry in `comments[]` conforms to standard `TwitchDownloader` `Comment` schema, plus optional top-level and nested extension fields:
- `"event_type"`: `"chat_message"` | `"channel_points_custom_reward_redemption"` | `"usernotice"`
- `"first_msg"`: `boolean` (`true` when `first-msg=1`)
- `"returning_chatter"`: `boolean` (`true` when `returning-chatter=1`)
- `"user_notice_params"`: `Dictionary<string, string>` (Raw IRCv3 tags—also read natively by `TwitchDownloader` / `ChatRenderCLI` for `msg-id` banners and `msg-param-sender-count` lifetime gift counts)
- `"event_data"`: Strongly-typed metadata object depending on `"event_type"`.
- **`message.user_color`**: Set to `null` whenever a chatter has not chosen a custom Twitch color (`color=;`), allowing `ChatRenderCLI` and `TwitchDownloaderCLI` to assign deterministic colors from Twitch's 15-color `DefaultUsernameColors` palette instead of rendering usernames in solid white.

### 3.1 Enriched `PRIVMSG` (`event_type: "chat_message"` or `"channel_points_custom_reward_redemption"`)
Captures standard messages plus First-Time Chatter, Returning Chatter, Channel Point Highlighted Messages, Custom Channel Point Redemptions (enriched with cached PubSub reward title, cost, and background color), Threaded Replies, Bits/Cheers, Power-Ups (Gigantified Emotes / Message Effects), Paid Hype Chat, and Shared Chat.

```json
{
  "_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "created_at": "2026-11-02T01:12:34.567Z",
  "channel_id": "12345678",
  "content_type": "video",
  "content_id": "9876543210",
  "content_offset_seconds": 754.567,
  "commenter": {
    "display_name": "ChatterName",
    "_id": "87654321",
    "name": "chattername",
    "type": "user",
    "bio": null,
    "created_at": "2026-11-02T01:12:34.567Z",
    "updated_at": "2026-11-02T01:12:34.567Z",
    "logo": ""
  },
  "source": "chat",
  "state": "published",
  "bits_spent": 100,
  "message": {
    "body": "@StreamerUser Cheer100 Huge play! LUL",
    "bits_spent": 100,
    "fragments": [
      { "text": "@StreamerUser Cheer100 Huge play! ", "emoticon": null },
      { "text": "LUL", "emoticon": { "emoticon_id": "425618", "emoticon_set_id": "" } }
    ],
    "is_action": false,
    "user_badges": [
      { "_id": "subscriber", "version": "12" },
      { "_id": "bits", "version": "100" }
    ],
    "user_color": "#FF4500",
    "emoticons": [
      { "_id": "425618", "begin": 34, "end": 36 }
    ]
  },
  "user_notice_params": {
    "msg-id": "highlighted-message",
    "first-msg": "1",
    "returning-chatter": "0"
  },
  "event_type": "chat_message",
  "event_data": {
    "msg_id": "highlighted-message",
    "is_first_message": true,
    "is_returning_chatter": false,
    "is_highlighted": true,
    "is_subscriber": true,
    "is_mod": false,
    "is_vip": false,
    "bits_spent": 100,
    "custom_reward_id": null,
    "reply": {
      "parent_msg_id": "11112222-3333-4444-5555-666677778888",
      "parent_user_id": "12345678",
      "parent_user_login": "streameruser",
      "parent_display_name": "StreamerUser",
      "parent_msg_body": "What did everyone think of that boss fight?",
      "thread_parent_msg_id": "11112222-3333-4444-5555-666677778888",
      "thread_user_login": "streameruser"
    },
    "power_up": {
      "type": "gigantified-emote-message",
      "emote_id": "425618",
      "animation_id": null
    },
    "hype_chat": {
      "amount": 500,
      "exponent": 2,
      "DecimalAmount": 5.0,
      "currency": "USD",
      "level": "FIVE",
      "is_system_message": false
    },
    "shared_chat": {
      "source_room_id": "99887766",
      "source_msg_id": "deadbeef-1234-5678-90ab-cdef12345678",
      "source_badges": "subscriber/6"
    }
  }
}
```

### 3.2 `USERNOTICE` (`event_type: "usernotice"`)
Captures Subscriptions (`sub`), Resubscriptions (`resub`), Gift Subscriptions (`subgift`), Community Mystery Gifts (`submysterygift`), Incoming Raids (`raid`), Moderator/Streamer Announcements (`announcement`), and Watch Streaks (`viewermilestone`).

- **`message.body`**: If the user typed a custom resub/announcement message, `message.body` contains their message and `event_data.system_message` contains the Twitch banner text (e.g. `"ChatterName subscribed at Tier 1. They've subscribed for 14 months!"`). If there is no user text (e.g. `subgift`, `submysterygift`, `raid`), `message.body` falls back to the `system-msg` banner text so nothing is ever blank.

```json
{
  "_id": "f0e9d8c7-b6a5-4321-fedc-ba0987654321",
  "created_at": "2026-11-02T01:15:10.120Z",
  "channel_id": "12345678",
  "content_type": "video",
  "content_id": "9876543210",
  "content_offset_seconds": 910.12,
  "commenter": {
    "display_name": "LoyalSub",
    "_id": "55667788",
    "name": "loyalsub",
    "type": "user",
    "bio": null,
    "created_at": "2026-11-02T01:15:10.120Z",
    "updated_at": "2026-11-02T01:15:10.120Z",
    "logo": ""
  },
  "source": "chat",
  "state": "published",
  "message": {
    "body": "14 months hype! Love the streams!",
    "fragments": [
      { "text": "14 months hype! Love the streams!", "emoticon": null }
    ],
    "is_action": false,
    "user_badges": [
      { "_id": "subscriber", "version": "12" }
    ],
    "user_color": "#9146FF",
    "emoticons": []
  },
  "user_notice_params": {
    "msg-id": "resub",
    "system-msg": "LoyalSub subscribed at Tier 1. They've subscribed for 14 months!",
    "msg-param-cumulative-months": "14",
    "msg-param-sub-plan": "1000",
    "msg-param-sub-plan-name": "Channel Subscription"
  },
  "event_type": "usernotice",
  "event_data": {
    "notice_type": "resub",
    "system_message": "LoyalSub subscribed at Tier 1. They've subscribed for 14 months!",
    "user_message": "14 months hype! Love the streams!",
    "sub_plan": "1000",
    "sub_plan_name": "Channel Subscription",
    "cumulative_months": 14,
    "streak_months": 14,
    "recipient_id": null,
    "recipient_user_name": null,
    "recipient_display_name": null,
    "mass_gift_count": null,
    "sender_total_gifts": null,
    "raid_viewer_count": null,
    "raid_display_name": null,
    "announcement_color": null,
    "milestone_category": null,
    "milestone_value": null,
    "milestone_reward": null,
    "params": {
      "msg-id": "resub",
      "system-msg": "LoyalSub subscribed at Tier 1. They've subscribed for 14 months!",
      "msg-param-cumulative-months": "14",
      "msg-param-sub-plan": "1000"
    }
  }
}
```

#### Common `notice_type` (`msg-id`) Values in `USERNOTICE`:
| `notice_type` | Description | Key `event_data` Fields |
| :--- | :--- | :--- |
| `"sub"` | New subscription | `sub_plan` (`"Prime"`, `"1000"`, `"2000"`, `"3000"`), `sub_plan_name` |
| `"resub"` | Resubscription | `cumulative_months`, `streak_months`, `sub_plan`, `user_message` |
| `"subgift"` | Single gift sub to a recipient | `recipient_display_name`, `recipient_user_name`, `sub_plan`, `sender_total_gifts` (populated from `msg-param-sender-count` or parent `submysterygift` origin cache; `null` when unshared) |
| `"submysterygift"` | Community bomb ("gifted X Tier 1 Subs!") | `mass_gift_count`, `sender_total_gifts`, `sub_plan` |
| `"raid"` | Incoming raid notice in chat (`event_type: "usernotice"`, `notice_type: "raid"`) | `raid_display_name`, `raid_viewer_count` |
| `"announcement"` | `/announce` banner (`event_type: "usernotice"`, `notice_type: "announcement"`) | `announcement_color` (`"PRIMARY"`, `"BLUE"`, `"GREEN"`, `"ORANGE"`, `"PURPLE"`), `user_message` |
| `"viewermilestone"` | Watch streak shared in chat | `milestone_category` (`"watch-streak"`), `milestone_value` (streak count), `milestone_reward` (channel points earned) |

---

## 4. Top-Level `events[]` Schema (Moderation & PubSub Overlay Stream)

Every item in the top-level `"events": [...]` array carries both `"type"` and `"event_type"` for universal C# property binding:

```json
{
  "_id": "clearchat-1730510112000-4",
  "created_at": "2026-11-02T01:15:12.000Z",
  "content_offset_seconds": 912.0,
  "source": "irc",
  "type": "clearchat",
  "event_type": "clearchat",
  "action": "timeout",
  "carried_over": false,
  "data": { /* Event-specific payload */ }
}
```
> **Note on `"carried_over": true`**: When VOD Automator slices a multi-game broadcast into individual game `.mp4` and `.json` files, any Prediction, Poll, Pinned Message, or Hype Train that was *already active on screen* when the new game slice began is automatically injected at `content_offset_seconds: 0.0` with `"carried_over": true`. Your renderer does not need to guess prior state when rendering Game 2!

### 4.1 `event_type: "clearchat"` (Timeout, Permanent Ban, or Full Chat Clear)
```json
{
  "_id": "clearchat-1730510112000-4",
  "created_at": "2026-11-02T01:15:12.000Z",
  "content_offset_seconds": 912.0,
  "source": "irc",
  "type": "clearchat",
  "event_type": "clearchat",
  "action": "timeout",
  "data": {
    "action": "timeout",        // "timeout" | "ban" | "clear_all"
    "target_user_login": "toxicuser",
    "target_user_id": "99887711",
    "ban_duration_seconds": 600 // null if "ban" (permanent) or "clear_all"
  }
}
```

### 4.2 `event_type: "clearmsg"` (Single Message Deleted by Moderator)
```json
{
  "_id": "clearmsg-11223344-5566-7788-99aa-bbccddeeff00",
  "created_at": "2026-11-02T01:15:15.400Z",
  "content_offset_seconds": 915.4,
  "source": "irc",
  "type": "clearmsg",
  "event_type": "clearmsg",
  "data": {
    "target_msg_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "target_user_login": "chattername",
    "deleted_body": "Message text that was removed",
    "deleted_message_body": "Message text that was removed"
  }
}
```

### 4.3 `event_type: "roomstate"` (Sub-Only, Emote-Only, Slow, Followers-Only Mode Changes)
```json
{
  "_id": "roomstate-1730510200000-5",
  "created_at": "2026-11-02T01:16:40.000Z",
  "content_offset_seconds": 1000.0,
  "source": "irc",
  "event_type": "roomstate",
  "data": {
    "emote_only": true,         // boolean | null (null = unchanged in delta)
    "subs_only": false,         // boolean | null
    "slow_seconds": 30,         // int (0 = off) | null
    "followers_only_minutes": 10, // int (-1 = off, 0 = all followers, >0 = min follow time) | null
    "r9k": false                // boolean | null
  }
}
```

### 4.4 `event_type: "prediction"` (1s Real-Time Channel Point Predictions)
```json
{
  "_id": "pred-77889900-event-updated-1024",
  "created_at": "2026-11-02T01:17:04.210Z",
  "content_offset_seconds": 1024.21,
  "source": "pubsub",
  "event_type": "prediction",
  "data": {
    "pubsub_type": "event-updated", // "event-created" | "event-updated" | "event-locked"
    "prediction_id": "77889900-aaaa-bbbb-cccc-ddddeeeeffff",
    "title": "Will he beat Malenia on this attempt?",
    "status": "ACTIVE",             // "ACTIVE" | "LOCKED" | "RESOLVED" | "CANCELED"
    "prediction_window_seconds": 120,
    "created_at": "2026-11-02T01:17:00.000Z",
    "locked_at": null,
    "ended_at": null,
    "winning_outcome_id": null,
    "outcomes": [
      {
        "id": "outcome-1",
        "title": "BELIEVE (Yes)",
        "color": "BLUE",
        "total_points": 450200,
        "total_users": 184,
        "top_predictors": [
          { "user_id": "111", "user_display_name": "HighRoller", "points": 50000 }
        ]
      },
      {
        "id": "outcome-2",
        "title": "DOUBT (No)",
        "color": "PINK",
        "total_points": 890500,
        "total_users": 312,
        "top_predictors": [
          { "user_id": "222", "user_display_name": "DoubterKing", "points": 150000 }
        ]
      }
    ]
  }
}
```

### 4.5 `event_type: "poll"` (1s Real-Time Twitch Polls)
```json
{
  "_id": "poll-44556677-POLL_UPDATE-1205",
  "created_at": "2026-11-02T01:20:05.100Z",
  "content_offset_seconds": 1205.1,
  "source": "pubsub",
  "event_type": "poll",
  "data": {
    "pubsub_type": "POLL_UPDATE", // "POLL_CREATE" | "POLL_UPDATE" | "POLL_COMPLETE" | "POLL_ARCHIVE"
    "poll_id": "44556677-1111-2222-3333-444455556666",
    "title": "Which build should we run next?",
    "status": "ACTIVE",           // "ACTIVE" | "COMPLETED" | "ARCHIVED" | "TERMINATED"
    "duration_seconds": 60,
    "started_at": "2026-11-02T01:20:00.000Z",
    "ended_at": null,
    "total_voters": 542,
    "choices": [
      { "choice_id": "c1", "title": "Strength / Greatsword", "total_voters": 310, "channel_points_votes": 1200 },
      { "choice_id": "c2", "title": "Dex / Bleed", "total_voters": 232, "channel_points_votes": 400 }
    ]
  }
}
```

### 4.6 `event_type: "pinned_chat"` (Pinned Messages & Paid Hype Chat Pins)
```json
{
  "_id": "pin-pin-message-99001122-18",
  "created_at": "2026-11-02T01:22:00.000Z",
  "content_offset_seconds": 1320.0,
  "source": "pubsub",
  "event_type": "pinned_chat",
  "data": {
    "action": "pin-message",     // "pin-message" | "unpin-message" | "update-message"
    "pin_id": "99001122-aaaa-bbbb-cccc-000011112222",
    "type": "MOD_PIN",           // "MOD_PIN" | "PAID_PIN"
    "message_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "message_text": " Merch drop is live at example.com! ",
    "sender_id": "12345678",
    "sender_display_name": "StreamerUser",
    "sender_color": "#9146FF",
    "sender_badges": [{ "_id": "broadcaster", "version": "1" }],
    "pinned_by_id": "88889999",
    "pinned_by_display_name": "LeadMod",
    "starts_at": 1730510520,
    "ends_at": 1730510820,
    "updated_at": 1730510520
  }
}
```

### 4.7 `event_type: "channel_points"` (Custom Channel Point Redemptions)
```json
{
  "_id": "cp-33445566-aaaa-bbbb-cccc-ddddeeeeffff",
  "created_at": "2026-11-02T01:25:10.000Z",
  "content_offset_seconds": 1510.0,
  "source": "pubsub",
  "event_type": "channel_points",
  "data": {
    "redemption_id": "33445566-aaaa-bbbb-cccc-ddddeeeeffff",
    "user_id": "87654321",
    "user_login": "chattername",
    "user_display_name": "ChatterName",
    "reward_id": "reward-hydrate-01",
    "reward_title": "Hydrate!",
    "reward_cost": 500,
    "reward_prompt": "Remind the streamer to drink water",
    "reward_background_color": "#00C7AC",
    "user_input": "Time for a sip!",
    "status": "FULFILLED"
  }
}
```

### 4.8 `event_type: "hype_train"` & `event_type: "raid"`
- **`hype_train`**: `data.pubsub_type` (`"hype-train-start"`, `"hype-train-progression"`, `"hype-train-level-up"`, `"hype-train-conductor-update"`, `"hype-train-end"`), `data.level`, `data.goal`, `data.total`, `data.progress`, `data.ends_at`.
  - **Stateful Delta Merging (`pinned_chat` & `hype_train`)**: When Twitch PubSub emits lightweight delta updates (such as `"update-message"` or `"unpin-message"` on `pinned-chat-updates-v1`, or `"hype-train-conductor-update"` / `"hype-train-end"` on `hype-train-events-v1`), VOD Automator merges the delta fields into the active in-memory overlay state and omits absent keys rather than overwriting `message_text`, `sender_display_name`, `goal`, or `progress` with `""` or `0`.
- **`raid`**: `data.pubsub_type` (`"raid_update_v2"`, `"raid_go_v2"`, `"raid_cancel_v2"`), `data.target_login`, `data.target_display_name`, `data.viewer_count`.

---

## 5. Ready-to-Paste C# (`System.Text.Json`) Models for Your Renderer Fork

Drop these classes into `TwitchDownloaderCore/Chat/` (or alongside `ChatRoot.cs`) in your C# renderer project:

```csharp
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TwitchDownloaderCore.Chat
{
    // Add these properties to your existing ChatRoot class:
    public partial class ChatRoot
    {
        [JsonPropertyName("schemaVersion")]
        public string SchemaVersion { get; set; }

        [JsonPropertyName("events")]
        public List<ChatBroadcastEvent> Events { get; set; } = new();
    }

    // Add these properties to your existing Comment class:
    public partial class Comment
    {
        [JsonPropertyName("event_type")]
        public string EventType { get; set; } // "chat_message" | "usernotice"

        [JsonPropertyName("user_notice_params")]
        public Dictionary<string, string> UserNoticeParams { get; set; }

        [JsonPropertyName("event_data")]
        public CommentEventData EventData { get; set; }
    }

    public class CommentEventData
    {
        // Shared / PRIVMSG fields
        [JsonPropertyName("msg_id")]
        public string MsgId { get; set; }

        [JsonPropertyName("is_first_message")]
        public bool IsFirstMessage { get; set; }

        [JsonPropertyName("is_returning_chatter")]
        public bool IsReturningChatter { get; set; }

        [JsonPropertyName("is_highlighted")]
        public bool IsHighlighted { get; set; }

        [JsonPropertyName("is_subscriber")]
        public bool IsSubscriber { get; set; }

        [JsonPropertyName("is_mod")]
        public bool IsMod { get; set; }

        [JsonPropertyName("is_vip")]
        public bool IsVip { get; set; }

        [JsonPropertyName("bits_spent")]
        public int BitsSpent { get; set; }

        [JsonPropertyName("custom_reward_id")]
        public string CustomRewardId { get; set; }

        [JsonPropertyName("reply")]
        public CommentReplyInfo Reply { get; set; }

        [JsonPropertyName("power_up")]
        public CommentPowerUpInfo PowerUp { get; set; }

        [JsonPropertyName("hype_chat")]
        public CommentHypeChatInfo HypeChat { get; set; }

        [JsonPropertyName("shared_chat")]
        public CommentSharedChatInfo SharedChat { get; set; }

        // USERNOTICE fields
        [JsonPropertyName("notice_type")]
        public string NoticeType { get; set; }

        [JsonPropertyName("system_message")]
        public string SystemMessage { get; set; }

        [JsonPropertyName("user_message")]
        public string UserMessage { get; set; }

        [JsonPropertyName("sub_plan")]
        public string SubPlan { get; set; }

        [JsonPropertyName("sub_plan_name")]
        public string SubPlanName { get; set; }

        [JsonPropertyName("cumulative_months")]
        public int? CumulativeMonths { get; set; }

        [JsonPropertyName("streak_months")]
        public int? StreakMonths { get; set; }

        [JsonPropertyName("recipient_display_name")]
        public string RecipientDisplayName { get; set; }

        [JsonPropertyName("mass_gift_count")]
        public int? MassGiftCount { get; set; }

        [JsonPropertyName("sender_total_gifts")]
        public int? SenderTotalGifts { get; set; }

        [JsonPropertyName("raid_viewer_count")]
        public int? RaidViewerCount { get; set; }

        [JsonPropertyName("raid_display_name")]
        public string RaidDisplayName { get; set; }

        [JsonPropertyName("announcement_color")]
        public string AnnouncementColor { get; set; }

        [JsonPropertyName("milestone_category")]
        public string MilestoneCategory { get; set; }

        [JsonPropertyName("milestone_value")]
        public int? MilestoneValue { get; set; }
    }

    public class CommentReplyInfo
    {
        [JsonPropertyName("parent_msg_id")]
        public string ParentMsgId { get; set; }

        [JsonPropertyName("parent_user_login")]
        public string ParentUserLogin { get; set; }

        [JsonPropertyName("parent_display_name")]
        public string ParentDisplayName { get; set; }

        [JsonPropertyName("parent_msg_body")]
        public string ParentMsgBody { get; set; }
    }

    public class CommentPowerUpInfo
    {
        [JsonPropertyName("type")]
        public string Type { get; set; } // "gigantified-emote-message" | "message-effect" | "celebration"

        [JsonPropertyName("emote_id")]
        public string EmoteId { get; set; }

        [JsonPropertyName("animation_id")]
        public string AnimationId { get; set; }
    }

    public class CommentHypeChatInfo
    {
        [JsonPropertyName("DecimalAmount")]
        public double DecimalAmount { get; set; }

        [JsonPropertyName("currency")]
        public string Currency { get; set; }

        [JsonPropertyName("level")]
        public string Level { get; set; }
    }

    public class CommentSharedChatInfo
    {
        [JsonPropertyName("source_room_id")]
        public string SourceRoomId { get; set; }
    }

    public class ChatBroadcastEvent
    {
        [JsonPropertyName("_id")]
        public string Id { get; set; }

        [JsonPropertyName("created_at")]
        public string CreatedAt { get; set; }

        [JsonPropertyName("content_offset_seconds")]
        public double ContentOffsetSeconds { get; set; }

        [JsonPropertyName("source")]
        public string Source { get; set; } // "irc" | "pubsub"

        [JsonPropertyName("event_type")]
        public string EventType { get; set; } // "clearchat" | "clearmsg" | "roomstate" | "prediction" | "poll" | "pinned_chat" | "channel_points" | "hype_train" | "raid"

        [JsonPropertyName("carried_over")]
        public bool CarriedOver { get; set; }

        [JsonPropertyName("data")]
        public JsonElement Data { get; set; }
    }
}
```

---

## 6. Linear Timeline State-Machine Guide for the C# Render Pipeline

Because your 20x-accelerated renderer steps forward linearly through `currentRenderTimeSec`, you can maintain two lightweight cursors (`commentIndex` and `eventIndex`) with **zero `O(N)` scanning overhead**:

1. **Advancing the Event Cursor (`while (eventIndex < chatRoot.Events.Count && chatRoot.Events[eventIndex].ContentOffsetSeconds <= currentRenderTimeSec)`)**:
   - **`clearchat`**:
     - If `action == "clear_all"`, mark all currently visible messages in the active viewport buffer as deleted/faded, or insert a system line (`"Chat was cleared by a moderator"`).
     - If `action == "timeout"` or `"ban"`, mark recent visible messages in the viewport from `target_user_id` / `target_user_login` with `<message deleted>` (or strikethrough) and optionally append a compact gray moderation row (`"toxicuser was timed out for 600s"`).
   - **`clearmsg`**:
     - Look up `target_msg_id` in your active visible message ring-buffer and replace its rendered surface with `<message deleted>` (or apply a 50% opacity strikethrough).
   - **`prediction` / `poll` / `pinned_chat` (Sticky Top Header Bar)**:
     - Maintain a single `ActiveHeaderWidget` state in your renderer loop.
     - When `event_type == "prediction"` arrives with `status == "ACTIVE"` or `"LOCKED"`, update the sticky top overlay surface with the title, blue/pink percentage bars (`outcome.total_points / sumTotalPoints`), and countdown timer. When `status == "RESOLVED"` or `"CANCELED"`, display the winning outcome badge for `8.0` seconds and then hide the widget.
     - Same pattern for `poll` (`ACTIVE` -> `COMPLETED` + 8s linger) and `pinned_chat` (`pin-message` -> hide on `unpin-message` or when `ends_at` expires).
   - **`channel_points`**:
     - Insert a stylized Channel Point card into the scrolling message feed with background tint `reward_background_color`.
2. **Rendering Enriched `Comment` Rows**:
   - **`Comment.EventData?.IsFirstMessage == true`**: Draw a subtle green/purple pill or left border (`✨ First Time Chatter`).
   - **`Comment.EventData?.IsHighlighted == true`**: Fill the row background with a translucent purple highlight (`rgba(145, 70, 255, 0.22)`).
   - **`Comment.EventData?.Reply != null`**: Render a single-line muted header above the username (`↱ Replying to @ParentDisplayName: "ParentMsgBody..."`).
   - **`Comment.EventData?.PowerUp?.Type == "gigantified-emote-message"`**: Render the final emote matching `PowerUp.EmoteId` at `2.5x` height on its own line.
   - **`Comment.EventType == "usernotice"`**: Draw a colored card (Purple for Subs/Gifts, Amber/Blue/Green/Purple for Announcements) showing `EventData.SystemMessage` in bold at the top and `EventData.UserMessage` (if non-empty) below it.

---

## 7. `ChatRenderCLI` Command-Line Invocation Mapping (`v5.1.0`)

VOD Automator (`src/services/chat.ts -> executeChatRenderMultiple`) automatically resolves `ChatRenderCLI.exe` (preferring it over `TwitchDownloaderCLI.exe` if both are present in the same directory) and passes all configured options from the two Settings tabs (**Render: Video & Output** and **Render: Chat & Events**):

| Setting Property (`config.chatRender`) | CLI Flag Passed to `ChatRenderCLI` | Default Value |
| :--- | :--- | :--- |
| `width` / `height` | `-w <even_px>` / `-h <even_px>` | `350` / `800` (e.g. `640` / `936`) |
| `framerate` / `updateRate` | `--framerate <fps>` / `--update-rate <sec>` | `60` / `0.2` |
| `jobs` | `-j <0..16>` | `0` (Auto-scale `1`–`4` workers) |
| `imageCacheMb` | `--image-cache-mb <64..8192>` | `256` |
| `giphy` / `gifMaxHeightPercent` | `--giphy=true\|false` / `--gif-max-height-percent <5..100>` | `true` / `33` |
| `predictionMode` | `--prediction-mode StickyTop\|ChatScroll\|Off` | `StickyTop` |
| `pollMode` | `--poll-mode StickyTop\|ChatScroll\|Off` | `StickyTop` |
| `pinnedChatMode` | `--pinned-chat-mode StickyTop\|ChatScroll\|Off` | `StickyTop` |
| `hypeTrainMode` | `--hype-train-mode StickyTop\|ChatScroll\|Off` | `ChatScroll` |
| `moderationMode` | `--moderation-mode Strikethrough\|ReplaceDeleted\|Hide\|Off` | `Strikethrough` |
| `moderationNotices` | `--moderation-notices=false` (when unchecked) | `true` |
| `clearAll` | `--clear-all` (when checked) | `true` |
| `roomstateNotices` | `--roomstate-notices=false` (when unchecked) | `true` |
| `replies` | `--replies=false` (when unchecked) | `true` |
| `firstChatter` | `--first-chatter=false` (when unchecked) | `true` |
| `announcements` | `--announcements=false` (when unchecked) | `true` |
| `raids` | `--raids=false` (when unchecked) | `true` |
| `channelPoints` | `--channel-points=false` (when unchecked) | `true` |
| `hypeChat` | `--hype-chat=false` (when unchecked) | `true` |
| `powerUps` | `--power-ups=false` (when unchecked) | `true` |
| `sharedChatBadge` | `--shared-chat-badge=false` (when unchecked) | `true` |
| `highlightUsers` / `highlightUserColor` | `--highlight-users <csv>` / `--highlight-user-color <hex>` | `""` / `#3D1A52` |
| `scaleUsername` | `--scale-username <double>` | `1.0` |

*(If an older, un-upgraded `TwitchDownloaderCLI` binary is used and returns an unknown-option error, VOD Automator automatically strips the `extendedArgs` list and retries with legacy `TwitchDownloaderCLI` flags.)*
