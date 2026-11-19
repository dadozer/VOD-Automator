import WebSocket from "ws";
import { state, addLog, cleanChannelName, DEFAULT_TWITCH_BROWSER_CLIENT_ID } from "./state";
import { emitSessionsDelta } from "./eventBus";
import type { ChatBroadcastEvent } from "../types";

export interface RewardMetadataEntry {
  title: string;
  cost: number;
  prompt: string;
  background_color: string;
}

export interface HermesOverlayClientOptions {
  channelLogin: string;
  twitchId: string;
  rewardMetadataCache: Map<string, RewardMetadataEntry>;
  computeOffsetSec: (eventTsMs: number) => number;
  appendBroadcastEvent: (channelLogin: string, event: ChatBroadcastEvent) => void;
}

/**
 * Companion Twitch Hermes WebSocket Client (wss://hermes.twitch.tv/v1)
 * Replaces decommissioned pubsub-edge.twitch.tv/v1 for Predictions, Polls,
 * Pinned Messages, Channel Points, Hype Trains & Raids.
 */
export function attachHermesOverlayClient(options: HermesOverlayClientOptions): void {
  const { channelLogin, twitchId, rewardMetadataCache, computeOffsetSec, appendBroadcastEvent } = options;

  const lastPredictionTracker = new Map<string, { sig: string; ts: number; status: string }>();
  const lastPollTracker = new Map<string, { sig: string; ts: number; status: string }>();
  const activePinnedChatTracker = new Map<string, Record<string, any>>();
  let latestActivePinId: string | null = null;
  let activeHypeTrainState: Record<string, any> | null = null;

  let hermesReconnectAttempts = 0;
  let hermesSkipAuth = false;

  function connectHermesWebSocket(overrideUrl?: string): void {
    const activeSession = state.activeDownloadSessions[channelLogin];
    if (!activeSession || activeSession.isStopped || !twitchId) {
      return;
    }

    if (activeSession.hermesReconnectTimer) {
      clearTimeout(activeSession.hermesReconnectTimer);
      activeSession.hermesReconnectTimer = null;
    }

    const prevSocket = activeSession.hermesWs || activeSession.pubsubWs;
    if (prevSocket && !overrideUrl) {
      try {
        prevSocket.removeAllListeners();
        prevSocket.terminate();
      } catch {}
      activeSession.hermesWs = null;
      activeSession.pubsubWs = null;
    }

    let watchdogTimer: NodeJS.Timeout | null = null;
    const clearWatchdog = () => {
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      if (activeSession.hermesKeepaliveInterval) {
        clearInterval(activeSession.hermesKeepaliveInterval);
        activeSession.hermesKeepaliveInterval = null;
      }
    };

    const clientId =
      (state.config.browserClientId || DEFAULT_TWITCH_BROWSER_CLIENT_ID).trim() ||
      DEFAULT_TWITCH_BROWSER_CLIENT_ID;
    const targetUrl = overrideUrl || `wss://hermes.twitch.tv/v1?clientId=${encodeURIComponent(clientId)}`;

    const hermesWs = new WebSocket(targetUrl, {
      headers: {
        Origin: "https://www.twitch.tv",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
    });

    const socketToRetireOnWelcome = overrideUrl ? prevSocket : null;
    activeSession.hermesWs = hermesWs;
    activeSession.pubsubWs = hermesWs;

    const subscriptionTopicMap = new Map<string, string>();
    let lastHermesFrameMs = Date.now();
    let recoveryUrl: string | undefined = undefined;
    let confirmedSubscriptions = 0;
    let hasLoggedSubscribed = false;
    let isReplacedByReconnect = false;

    const topics = [
      `predictions-channel-v1.${twitchId}`,
      `polls.${twitchId}`,
      `pinned-chat-updates-v1.${twitchId}`,
      `community-points-channel-v1.${twitchId}`,
      `hype-train-events-v1.${twitchId}`,
      `raid.${twitchId}`,
    ];

    const makeId = (prefix: string) =>
      `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

    const sendHermesSubscriptions = () => {
      const nowIso = new Date().toISOString();
      for (const topicName of topics) {
        const subId = makeId("sub");
        subscriptionTopicMap.set(subId, topicName);
        try {
          hermesWs.send(
            JSON.stringify({
              type: "subscribe",
              id: makeId("req"),
              subscribe: {
                id: subId,
                type: "pubsub",
                pubsub: {
                  topic: topicName,
                },
              },
              timestamp: nowIso,
            })
          );
        } catch (err: any) {
          addLog(`[Hermes] Failed to send subscribe frame for ${topicName} on @${channelLogin}: ${err.message}`);
        }
      }
    };

    const startWatchdog = (keepaliveSec: number) => {
      clearWatchdog();
      const silenceLimitMs = Math.max(45_000, keepaliveSec * 2500 + 10_000);
      watchdogTimer = setInterval(() => {
        const s = state.activeDownloadSessions[channelLogin];
        if (!s || s.isStopped || hermesWs.readyState !== WebSocket.OPEN) {
          clearWatchdog();
          return;
        }
        const idleMs = Date.now() - lastHermesFrameMs;
        if (idleMs > silenceLimitMs) {
          addLog(
            `[Hermes] Keepalive silence (${Math.round(idleMs / 1000)}s > ${Math.round(
              silenceLimitMs / 1000
            )}s) on @${channelLogin}. Cycling Hermes connection...`
          );
          clearWatchdog();
          try {
            hermesWs.terminate();
          } catch {
            try {
              hermesWs.close();
            } catch {}
          }
        }
      }, 5000);
      activeSession.hermesKeepaliveInterval = watchdogTimer;
    };

    const handleHermesOpen = () => {
      const curSession = state.activeDownloadSessions[channelLogin];
      if (!curSession || curSession.isStopped) {
        clearWatchdog();
        try {
          hermesWs.terminate();
        } catch {}
        return;
      }
      lastHermesFrameMs = Date.now();
      startWatchdog(20);
    };

    const handleHermesMessage = (rawData: WebSocket.Data) => {
      lastHermesFrameMs = Date.now();
      const curSession = state.activeDownloadSessions[channelLogin];
      if (!curSession || curSession.isStopped) return;

      let packet: any;
      try {
        packet = JSON.parse(rawData.toString());
      } catch {
        return;
      }

      // 1. Hermes Welcome Handshake
      if (packet.type === "welcome") {
        hermesReconnectAttempts = 0;
        const keepaliveSec = Number(packet.welcome?.keepaliveSec) || 15;
        if (packet.welcome?.recoveryUrl && typeof packet.welcome.recoveryUrl === "string") {
          recoveryUrl = packet.welcome.recoveryUrl;
        }
        startWatchdog(keepaliveSec);

        if (socketToRetireOnWelcome && socketToRetireOnWelcome !== hermesWs) {
          try {
            socketToRetireOnWelcome.removeAllListeners();
            socketToRetireOnWelcome.close();
          } catch {}
        }

        const rawOAuth = state.config.browserOAuthToken
          ? state.config.browserOAuthToken.replace(/^oauth:/i, "").trim()
          : "";
        if (rawOAuth && !hermesSkipAuth) {
          try {
            hermesWs.send(
              JSON.stringify({
                id: makeId("auth"),
                type: "authenticate",
                authenticate: {
                  token: rawOAuth,
                },
                timestamp: new Date().toISOString(),
              })
            );
          } catch {}
        }

        sendHermesSubscriptions();
        return;
      }

      // 2. Keepalive Frame
      if (packet.type === "keepalive") {
        return;
      }

      // 3. Authenticate Response
      if (packet.type === "authenticateResponse") {
        const resStatus = String(packet.authenticateResponse?.result || "").toLowerCase();
        if (resStatus && resStatus !== "ok") {
          hermesSkipAuth = true;
          addLog(
            `[Hermes] Browser OAuth token rejected on Hermes (${
              packet.authenticateResponse?.error || resStatus
            }); continuing with unauthenticated viewer topic subscriptions for @${channelLogin}.`
          );
        }
        return;
      }

      // 4. Subscription Confirmation
      if (packet.type === "subscribeResponse") {
        const resStatus = String(packet.subscribeResponse?.result || "").toLowerCase();
        const subId = packet.subscribeResponse?.subscription?.id;
        if (resStatus === "ok") {
          confirmedSubscriptions++;
          if (!curSession.hermesConnected) {
            curSession.hermesConnected = true;
            emitSessionsDelta(true);
          }
          if (!hasLoggedSubscribed && confirmedSubscriptions >= topics.length) {
            hasLoggedSubscribed = true;
            addLog(
              `[Hermes] Subscribed to ${confirmedSubscriptions}/${topics.length} live broadcast overlay topics for @${channelLogin} (Predictions, Polls, Pinned Messages, Channel Points, Hype Trains, Raids).`
            );
          } else if (!hasLoggedSubscribed && confirmedSubscriptions === 1) {
            setTimeout(() => {
              if (
                !hasLoggedSubscribed &&
                confirmedSubscriptions > 0 &&
                state.activeDownloadSessions[channelLogin] &&
                !state.activeDownloadSessions[channelLogin].isStopped
              ) {
                hasLoggedSubscribed = true;
                addLog(
                  `[Hermes] Subscribed to ${confirmedSubscriptions}/${topics.length} live broadcast overlay topics for @${channelLogin}.`
                );
              }
            }, 2000);
          }
        } else {
          const failedTopic = subId ? subscriptionTopicMap.get(subId) : "unknown";
          addLog(
            `[Hermes] Topic subscription notice on @${channelLogin} (${failedTopic}): ${
              packet.subscribeResponse?.errorCode || resStatus
            }`
          );
        }
        return;
      }

      // 5. Server-Requested Hitless Reconnect
      if (packet.type === "reconnect" || packet.type === "RECONNECT") {
        const nextUrl = packet.reconnect?.url || recoveryUrl;
        isReplacedByReconnect = true;
        addLog(`[Hermes] Server requested hitless reconnect for @${channelLogin}. Migrating overlay socket...`);
        connectHermesWebSocket(
          typeof nextUrl === "string" && nextUrl.startsWith("wss://") ? nextUrl : undefined
        );
        return;
      }

      // 6. Unwrap Hermes `notification` (or legacy `MESSAGE` test packet)
      let topic = "";
      let inner: any = null;

      if (packet.type === "notification" && packet.notification) {
        const subId = packet.notification.subscription?.id;
        topic = (subId && subscriptionTopicMap.get(subId)) || packet.notification.pubsub?.topic || "";
        const rawPubsub = packet.notification.pubsub;
        if (typeof rawPubsub === "string") {
          try {
            inner = JSON.parse(rawPubsub);
          } catch {
            return;
          }
        } else if (rawPubsub && typeof rawPubsub === "object") {
          if (typeof rawPubsub.message === "string") {
            try {
              inner = JSON.parse(rawPubsub.message);
            } catch {
              return;
            }
          } else {
            inner = rawPubsub;
          }
        }
      } else if (packet.type === "MESSAGE" && packet.data?.topic && packet.data?.message) {
        topic = packet.data.topic;
        try {
          inner = JSON.parse(packet.data.message);
        } catch {
          return;
        }
      }

      if (!topic || !inner) {
        return;
      }

      const nowMs = Date.now();
      const offsetSec = computeOffsetSec(nowMs);

      // Topic 1: Predictions (predictions-channel-v1)
      if (topic.startsWith("predictions-channel-v1.")) {
        const ev = inner?.data?.event;
        if (!ev || !ev.id) return;

        const predId = String(ev.id);
        const status = String(ev.status || "ACTIVE").toUpperCase();
        const outcomes = Array.isArray(ev.outcomes)
          ? ev.outcomes.map((o: any) => ({
              id: o.id,
              title: o.title,
              color: o.color,
              total_points: o.total_points || 0,
              total_users: o.total_users || 0,
              top_predictors: Array.isArray(o.top_predictors)
                ? o.top_predictors.slice(0, 5).map((tp: any) => ({
                    user_id: tp.user_id,
                    user_display_name: tp.user_display_name,
                    points: tp.points,
                  }))
                : [],
            }))
          : [];

        const sig = `${status}|${outcomes
          .map((o: any) => `${o.id}:${o.total_points}:${o.total_users}`)
          .join(",")}`;
        const prev = lastPredictionTracker.get(predId);

        if (inner.type === "event-updated" && status === "ACTIVE" && prev) {
          if (prev.sig === sig || nowMs - prev.ts < 900) {
            return;
          }
        }

        let category = "prediction_updated";
        if (inner.type === "event-created" || !prev) {
          category = "prediction_created";
          addLog(
            `[PubSub] Prediction started on @${channelLogin}: "${ev.title}" (${outcomes
              .map((o: any) => o.title)
              .join(" vs ")})`
          );
        } else if (inner.type === "event-locked" || (status === "LOCKED" && prev.status !== "LOCKED")) {
          category = "prediction_locked";
          addLog(`[PubSub] Prediction locked on @${channelLogin}: "${ev.title}"`);
        } else if (status === "RESOLVED" && prev.status !== "RESOLVED") {
          category = "prediction_resolved";
          const winner = outcomes.find((o: any) => o.id === ev.winning_outcome_id);
          addLog(
            `[PubSub] Prediction resolved on @${channelLogin}: "${ev.title}" -> Winner: "${
              winner?.title || ev.winning_outcome_id
            }"`
          );
        } else if ((status === "CANCELED" || status === "CANCELLED") && prev.status !== status) {
          category = "prediction_canceled";
          addLog(`[PubSub] Prediction canceled on @${channelLogin}: "${ev.title}"`);
        }

        lastPredictionTracker.set(predId, { sig, ts: nowMs, status });

        appendBroadcastEvent(channelLogin, {
          _id: `pred-${predId}-${category}-${nowMs}`,
          created_at: new Date(nowMs).toISOString(),
          content_offset_seconds: offsetSec,
          source: "pubsub",
          type: "prediction",
          event_type: "prediction",
          category,
          data: {
            pubsub_type: inner.type || "event-updated",
            prediction_id: predId,
            title: ev.title || "",
            status,
            prediction_window_seconds: ev.prediction_window_seconds || 0,
            created_at: ev.created_at || new Date(nowMs).toISOString(),
            locked_at: ev.locked_at || null,
            ended_at: ev.ended_at || null,
            winning_outcome_id: ev.winning_outcome_id || null,
            outcomes,
          },
        });
        return;
      }

      // Topic 2: Polls (polls.<twitchId>)
      if (topic.startsWith("polls.")) {
        const poll = inner?.data?.poll;
        if (!poll || !poll.poll_id) return;

        const pollId = String(poll.poll_id);
        const status = String(poll.status || "ACTIVE").toUpperCase();
        const choices = Array.isArray(poll.choices)
          ? poll.choices.map((c: any) => ({
              choice_id: c.choice_id,
              title: c.title,
              total_voters: c.votes?.total ?? c.total_voters ?? 0,
              bits_votes: c.votes?.bits ?? 0,
              channel_points_votes: c.votes?.channel_points ?? 0,
            }))
          : [];
        const totalVoters = choices.reduce((sum: number, c: any) => sum + (c.total_voters || 0), 0);

        const sig = `${status}|${choices.map((c: any) => `${c.choice_id}:${c.total_voters}`).join(",")}`;
        const prev = lastPollTracker.get(pollId);

        if (inner.type === "POLL_UPDATE" && status === "ACTIVE" && prev) {
          if (prev.sig === sig || nowMs - prev.ts < 900) {
            return;
          }
        }

        let category = "poll_updated";
        if (inner.type === "POLL_CREATE" || !prev) {
          category = "poll_created";
          addLog(`[PubSub] Poll started on @${channelLogin}: "${poll.title}"`);
        } else if (inner.type === "POLL_COMPLETE" || status === "COMPLETED") {
          category = "poll_completed";
          addLog(`[PubSub] Poll completed on @${channelLogin}: "${poll.title}"`);
        } else if (inner.type === "POLL_ARCHIVE" || status === "ARCHIVED") {
          category = "poll_archived";
        } else if (inner.type === "POLL_TERMINATE" || status === "TERMINATED") {
          category = "poll_terminated";
        }

        lastPollTracker.set(pollId, { sig, ts: nowMs, status });

        appendBroadcastEvent(channelLogin, {
          _id: `poll-${pollId}-${category}-${nowMs}`,
          created_at: new Date(nowMs).toISOString(),
          content_offset_seconds: offsetSec,
          source: "pubsub",
          type: "poll",
          event_type: "poll",
          category,
          data: {
            pubsub_type: inner.type || "POLL_UPDATE",
            poll_id: pollId,
            title: poll.title || "",
            status,
            duration_seconds: poll.duration_seconds || 0,
            started_at: poll.started_at || new Date(nowMs).toISOString(),
            ended_at: poll.ended_at || null,
            total_voters: totalVoters,
            choices,
          },
        });
        return;
      }

      // Topic 3: Moderator / Streamer Pinned Messages (pinned-chat-updates-v1.<twitchId>)
      if (topic.startsWith("pinned-chat-updates-v1.")) {
        const d = inner?.data;
        if (!d) return;
        const rawAction =
          inner.type === "unpin-message"
            ? "unpin-message"
            : inner.type === "update-message"
            ? "update-message"
            : "pin-message";
        const category =
          rawAction === "unpin-message"
            ? "unpin_message"
            : rawAction === "update-message"
            ? "update_pinned_message"
            : "pin_message";

        const incomingPinId = d.id || d.pin_id || null;
        const pinId = String(incomingPinId || latestActivePinId || `pin-${nowMs}`);
        const prevPinState =
          activePinnedChatTracker.get(pinId) ||
          (latestActivePinId ? activePinnedChatTracker.get(latestActivePinId) : undefined);

        const msgObj = d.message || {};
        if (category === "pin_message") {
          addLog(
            `[PubSub] Message pinned on @${channelLogin} by ${
              d.pinned_by?.display_name || "Moderator"
            }: "${msgObj.content?.text || ""}"`
          );
        }

        const hasSenderBadges = Array.isArray(msgObj.sender?.badges);
        const senderBadges = hasSenderBadges
          ? msgObj.sender.badges.map((b: any) => ({
              _id: b.id || b._id || b.setID || "",
              version: String(b.version || "1"),
            }))
          : undefined;

        if (senderBadges && senderBadges.length > 0) {
          if (!curSession.usedTwitchBadges) {
            curSession.usedTwitchBadges = new Map<string, Set<string>>();
          }
          for (const b of senderBadges) {
            if (b._id && b.version) {
              if (!curSession.usedTwitchBadges.has(b._id)) {
                curSession.usedTwitchBadges.set(b._id, new Set<string>());
              }
              curSession.usedTwitchBadges.get(b._id)!.add(b.version);
            }
          }
        }

        const deltaData: Record<string, any> = {
          action: rawAction,
          pin_id: pinId,
        };

        const rawPinType = d.type || msgObj.type;
        if (rawPinType) {
          deltaData.type = rawPinType;
          deltaData.pin_type = rawPinType;
        } else if (!prevPinState && category === "pin_message") {
          deltaData.type = "MOD_PIN";
          deltaData.pin_type = "MOD_PIN";
        }

        if (msgObj.id !== undefined) deltaData.message_id = msgObj.id;
        if (msgObj.content?.text !== undefined) deltaData.message_text = msgObj.content.text;
        if (msgObj.sender?.id !== undefined) deltaData.sender_id = msgObj.sender.id;
        if (msgObj.sender?.display_name !== undefined) {
          deltaData.sender_display_name = msgObj.sender.display_name;
        }
        if (msgObj.sender !== undefined) {
          deltaData.sender_color = msgObj.sender.chat_color || null;
        }
        if (senderBadges !== undefined) deltaData.sender_badges = senderBadges;
        if (d.pinned_by?.id !== undefined) deltaData.pinned_by_id = d.pinned_by.id;
        if (d.pinned_by?.display_name !== undefined) {
          deltaData.pinned_by_display_name = d.pinned_by.display_name;
        }
        if (msgObj.starts_at !== undefined || d.starts_at !== undefined) {
          deltaData.starts_at = msgObj.starts_at ?? d.starts_at;
        } else if (!prevPinState && category === "pin_message") {
          deltaData.starts_at = Math.floor(nowMs / 1000);
        }
        if (msgObj.ends_at !== undefined || d.ends_at !== undefined) {
          deltaData.ends_at = msgObj.ends_at ?? d.ends_at;
        }
        if (msgObj.updated_at !== undefined || d.updated_at !== undefined) {
          deltaData.updated_at = msgObj.updated_at ?? d.updated_at;
        } else {
          deltaData.updated_at = Math.floor(nowMs / 1000);
        }
        if (d.pinned_by) {
          deltaData.pinned_by = {
            id: d.pinned_by.id,
            display_name: d.pinned_by.display_name,
          };
        }
        if (d.unpinned_by) {
          deltaData.unpinned_by = {
            id: d.unpinned_by.id,
            display_name: d.unpinned_by.display_name,
          };
        }

        const mergedData: Record<string, any> = prevPinState
          ? { ...prevPinState, ...deltaData }
          : deltaData;

        if (mergedData.message_id || msgObj.id || prevPinState?.message) {
          const prevMsg = prevPinState?.message || {};
          const prevSender = prevMsg.sender || {};
          mergedData.message = {
            ...prevMsg,
            id: mergedData.message_id || prevMsg.id,
            ...(mergedData.message_text !== undefined ? { text: mergedData.message_text } : {}),
            ...(mergedData.sender_id || mergedData.sender_display_name || prevMsg.sender
              ? {
                  sender: {
                    ...prevSender,
                    ...(mergedData.sender_id !== undefined ? { id: mergedData.sender_id } : {}),
                    ...(mergedData.sender_display_name !== undefined
                      ? { display_name: mergedData.sender_display_name }
                      : {}),
                    chat_color:
                      mergedData.sender_color !== undefined
                        ? mergedData.sender_color
                        : prevSender.chat_color ?? null,
                    ...(mergedData.sender_badges !== undefined
                      ? { badges: mergedData.sender_badges }
                      : {}),
                  },
                }
              : {}),
            ...(mergedData.starts_at !== undefined ? { starts_at: mergedData.starts_at } : {}),
            ...(mergedData.ends_at !== undefined ? { ends_at: mergedData.ends_at } : {}),
            updated_at: mergedData.updated_at,
          };
        }

        if (category === "unpin_message") {
          activePinnedChatTracker.delete(pinId);
          if (latestActivePinId === pinId) {
            latestActivePinId = null;
          }
        } else {
          activePinnedChatTracker.set(pinId, mergedData);
          latestActivePinId = pinId;
        }

        appendBroadcastEvent(channelLogin, {
          _id: `pin-${pinId}-${category}-${nowMs}`,
          created_at: new Date(nowMs).toISOString(),
          content_offset_seconds: offsetSec,
          source: "pubsub",
          type: "pinned_chat",
          event_type: "pinned_chat",
          category,
          action: rawAction,
          data: mergedData,
        });
        return;
      }

      // Topic 4: Channel Points Redemptions (community-points-channel-v1.<twitchId>)
      if (topic.startsWith("community-points-channel-v1.")) {
        const redemption = inner?.data?.redemption;
        if (!redemption || !redemption.id) return;

        const rewardId = redemption.reward?.id || "";
        const rewardTitle = redemption.reward?.title || "";
        const rewardCost = redemption.reward?.cost || 0;
        const rewardPrompt = redemption.reward?.prompt || "";
        const rewardBgColor = redemption.reward?.background_color || "#9146FF";

        if (rewardId) {
          rewardMetadataCache.set(rewardId, {
            title: rewardTitle,
            cost: rewardCost,
            prompt: rewardPrompt,
            background_color: rewardBgColor,
          });
        }

        appendBroadcastEvent(channelLogin, {
          _id: `cp-${redemption.id}`,
          created_at: redemption.redeemed_at || new Date(nowMs).toISOString(),
          content_offset_seconds: offsetSec,
          source: "pubsub",
          type: "channel_points",
          event_type: "channel_points",
          category: "channel_points_custom_reward_redemption",
          data: {
            redemption_id: redemption.id,
            user_id: redemption.user?.id || "",
            user_login: redemption.user?.login || "",
            user_display_name: redemption.user?.display_name || "",
            reward_id: rewardId,
            reward_title: rewardTitle,
            reward_cost: rewardCost,
            reward_prompt: rewardPrompt,
            reward_background_color: rewardBgColor,
            user_input: redemption.user_input || null,
            status: redemption.status || "FULFILLED",
            user: {
              id: redemption.user?.id || "",
              login: redemption.user?.login || "",
              display_name: redemption.user?.display_name || "",
            },
            reward: {
              id: rewardId,
              title: rewardTitle,
              prompt: rewardPrompt,
              cost: rewardCost,
              background_color: rewardBgColor,
            },
          },
        });
        return;
      }

      // Topic 5: Hype Trains (hype-train-events-v1.<twitchId>)
      if (topic.startsWith("hype-train-events-v1.")) {
        const d = inner?.data || {};
        const rawType = String(inner?.type || "hype-train-progression");
        const category = rawType.replace(/-/g, "_");

        const deltaTrain: Record<string, any> = {
          pubsub_type: rawType,
        };

        const rawTrainId = d.id || d.progression?.id || d.train_id;
        if (rawTrainId) {
          deltaTrain.train_id = String(rawTrainId);
        }

        const rawLevel = d.progress?.level?.value ?? d.level;
        if (rawLevel !== undefined && rawLevel !== null) {
          deltaTrain.level = rawLevel;
        }

        const rawGoal = d.progress?.level?.goal ?? d.goal;
        if (rawGoal !== undefined && rawGoal !== null) {
          deltaTrain.goal = rawGoal;
        }

        const rawProgress =
          d.progress?.value ?? (typeof d.progress === "number" ? d.progress : undefined) ?? d.value;
        if (rawProgress !== undefined && rawProgress !== null) {
          deltaTrain.progress = rawProgress;
        }

        const rawTotal = d.progress?.total ?? d.total;
        if (rawTotal !== undefined && rawTotal !== null) {
          deltaTrain.total = rawTotal;
        }

        if (d.started_at !== undefined) deltaTrain.started_at = d.started_at;
        if (d.expires_at !== undefined) {
          deltaTrain.expires_at = d.expires_at;
          deltaTrain.ends_at = d.expires_at;
        }
        if (d.ended_at !== undefined) {
          deltaTrain.ended_at = d.ended_at;
          deltaTrain.ends_at = d.ended_at;
        }
        if (d.is_golden_kappa_train !== undefined) {
          deltaTrain.is_golden_kappa = Boolean(d.is_golden_kappa_train);
        }
        if (d.source !== undefined && (d.user_id || d.user_login || d.user_display_name)) {
          deltaTrain.conductor = {
            source: d.source,
            user_id: d.user_id || null,
            user_login: d.user_login || null,
            user_display_name: d.user_display_name || null,
            participations: d.participations || null,
          };
        }

        const mergedTrainData: Record<string, any> = activeHypeTrainState
          ? { ...activeHypeTrainState, ...deltaTrain }
          : deltaTrain;

        if (rawType === "hype-train-end" || d.ended_at) {
          activeHypeTrainState = null;
        } else {
          activeHypeTrainState = mergedTrainData;
        }

        appendBroadcastEvent(channelLogin, {
          _id: `hypetrain-${mergedTrainData.train_id || d.channel_id || twitchId}-${category}-${nowMs}`,
          created_at: new Date(nowMs).toISOString(),
          content_offset_seconds: offsetSec,
          source: "pubsub",
          type: "hype_train",
          event_type: "hype_train",
          category,
          data: mergedTrainData,
        });
        return;
      }

      // Topic 6: Outgoing / Incoming Raid Updates (raid.<twitchId>)
      if (topic.startsWith("raid.")) {
        const r = inner?.raid;
        if (!r) return;
        const rawType = String(inner.type || "raid_update_v2");

        appendBroadcastEvent(channelLogin, {
          _id: `raid-${r.id || nowMs}-${rawType}`,
          created_at: new Date(nowMs).toISOString(),
          content_offset_seconds: offsetSec,
          source: "pubsub",
          type: "raid",
          event_type: "raid",
          category: rawType,
          data: {
            pubsub_type: rawType,
            raid_id: r.id || "",
            source_id: r.source_id || twitchId,
            target_id: r.target_id || "",
            target_login: r.target_login || "",
            target_display_name: r.target_display_name || "",
            viewer_count: r.viewer_count || 0,
          },
        });
        return;
      }
    };

    const cleanupHermesListeners = () => {
      clearWatchdog();
      hermesWs.removeListener("open", handleHermesOpen);
      hermesWs.removeListener("message", handleHermesMessage);
      hermesWs.removeListener("close", handleHermesClose);
      hermesWs.removeListener("error", handleHermesError);
    };

    const handleHermesClose = () => {
      cleanupHermesListeners();
      if (isReplacedByReconnect) return;

      const curSession = state.activeDownloadSessions[channelLogin];
      if (curSession && curSession.hermesWs === hermesWs) {
        curSession.hermesConnected = false;
        emitSessionsDelta(true);
      }
      if (curSession && !curSession.isStopped) {
        if (curSession.hermesReconnectTimer) {
          clearTimeout(curSession.hermesReconnectTimer);
        }
        hermesReconnectAttempts++;
        const baseDelayMs = Math.min(30_000, 2000 * Math.pow(2, Math.min(4, hermesReconnectAttempts - 1)));
        const jitterMs = Math.floor(Math.random() * 1000);
        const delayMs = baseDelayMs + jitterMs;
        const reconnectTarget = hermesReconnectAttempts === 1 && recoveryUrl ? recoveryUrl : undefined;
        curSession.hermesReconnectTimer = setTimeout(() => {
          if (
            state.activeDownloadSessions[channelLogin] &&
            !state.activeDownloadSessions[channelLogin].isStopped
          ) {
            connectHermesWebSocket(reconnectTarget);
          }
        }, delayMs);
      }
    };

    const handleHermesError = (err: any) => {
      if (hermesReconnectAttempts <= 1) {
        addLog(`[Hermes] WebSocket notice for @${channelLogin}: ${err.message}`);
      }
    };

    hermesWs.on("open", handleHermesOpen);
    hermesWs.on("message", handleHermesMessage);
    hermesWs.on("close", handleHermesClose);
    hermesWs.on("error", handleHermesError);
  }

  if (state.activeDownloadSessions[channelLogin]) {
    state.activeDownloadSessions[channelLogin].refreshHermesSocket = () => {
      hermesSkipAuth = false;
      hermesReconnectAttempts = 0;
      connectHermesWebSocket();
    };
  }

  connectHermesWebSocket();
}

/**
 * Immediately refreshes the Hermes companion WebSocket when Twitch Browser OAuth Token
 * or Client-ID credentials are updated in Settings.
 */
export function refreshLiveChatAuth(channelLogin: string): void {
  const cleaned = cleanChannelName(channelLogin);
  const matchingKey =
    Object.keys(state.activeDownloadSessions).find((k) => cleanChannelName(k) === cleaned) ||
    channelLogin;
  const session = state.activeDownloadSessions[matchingKey];
  if (session && !session.isStopped && typeof session.refreshHermesSocket === "function") {
    addLog(`[Config Update] Refreshing live Hermes overlay socket for @${matchingKey}...`);
    session.refreshHermesSocket();
  }
}
