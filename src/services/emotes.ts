import axios from "axios";

export interface ThirdPartyEmote {
  api: number;
  id: string;
  name: string;
  imageScale: number;
  width: number;
  height: number;
  isZeroWidth: boolean;
}

export async function fetchThirdPartyEmotes(twitchId: string): Promise<ThirdPartyEmote[]> {
  const thirdPartyEmotes: ThirdPartyEmote[] = [];
  
  const pushEmote = (api: number, id: string, name: string, isZeroWidth: boolean = false) => {
    thirdPartyEmotes.push({ api, id, name, imageScale: 1, width: 0, height: 0, isZeroWidth });
  };

  try {
    const [bttvGlobal, bttvChannel, ffzGlobal, ffzChannel, stvGlobal, stvChannel] = await Promise.allSettled([
      axios.get("https://api.betterttv.net/3/cached/emotes/global"),
      axios.get(`https://api.betterttv.net/3/cached/users/twitch/${twitchId}`),
      axios.get("https://api.frankerfacez.com/v1/set/global"),
      axios.get(`https://api.frankerfacez.com/v1/room/id/${twitchId}`),
      axios.get("https://7tv.io/v3/emote-sets/global"),
      axios.get(`https://7tv.io/v3/users/twitch/${twitchId}`)
    ]);

    if (bttvGlobal.status === "fulfilled") bttvGlobal.value.data.forEach((e: any) => pushEmote(1, e.id, e.code));
    if (bttvChannel.status === "fulfilled") {
      if (bttvChannel.value.data.channelEmotes) bttvChannel.value.data.channelEmotes.forEach((e: any) => pushEmote(1, e.id, e.code));
      if (bttvChannel.value.data.sharedEmotes) bttvChannel.value.data.sharedEmotes.forEach((e: any) => pushEmote(1, e.id, e.code));
    }

    if (ffzGlobal.status === "fulfilled") {
      const sets = ffzGlobal.value.data.sets;
      for (const set in sets) sets[set].emoticons.forEach((e: any) => pushEmote(2, e.id.toString(), e.name));
    }
    if (ffzChannel.status === "fulfilled") {
      const sets = ffzChannel.value.data.sets;
      for (const set in sets) sets[set].emoticons.forEach((e: any) => pushEmote(2, e.id.toString(), e.name));
    }

    if (stvGlobal.status === "fulfilled") stvGlobal.value.data.emotes.forEach((e: any) => pushEmote(3, e.id, e.name, !!e.flags));
    if (stvChannel.status === "fulfilled") {
      const stvSet = stvChannel.value.data.emote_set;
      if (stvSet && stvSet.emotes) stvSet.emotes.forEach((e: any) => pushEmote(3, e.id, e.name, !!e.flags));
    }
  } catch (e) {
    // Intentionally silent, error will bubble or be handled by consumer if needed.
    // Generally individual promise failure handles this.
  }

  return thirdPartyEmotes;
}
