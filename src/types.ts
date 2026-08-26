export type Member = {
  id: string;
  name: string;
  color: string;
};

export type PlaybackState = {
  mode: "link" | "screen";
  videoUrl: string;
  screenSharerId: string | null;
  playing: boolean;
  currentTime: number;
  updatedAt: number;
};

export type ChatMessage = {
  id: string;
  userId: string;
  name: string;
  color: string;
  text: string;
  at: number;
};

export type RoomState = {
  code: string;
  hostId: string;
  members: Member[];
  playback: PlaybackState;
  messages: ChatMessage[];
};

export type FloatingReaction = {
  id: string;
  emoji: string;
  name: string;
  color: string;
  x: number;
};

export const REACTIONS = ["❤️", "😂", "🔥", "👏", "😮", "😢", "👍", "🎉"] as const;
