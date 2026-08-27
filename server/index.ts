import cors from "cors";
import express from "express";
import { existsSync } from "fs";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";

type Member = {
  id: string;
  name: string;
  color: string;
};

type PlaybackState = {
  mode: "link" | "screen";
  videoUrl: string;
  screenSharerId: string | null;
  playing: boolean;
  currentTime: number;
  updatedAt: number;
};

type ChatMessage = {
  id: string;
  userId: string;
  name: string;
  color: string;
  text: string;
  at: number;
};

type Room = {
  code: string;
  hostId: string;
  members: Map<string, Member>;
  playback: PlaybackState;
  messages: ChatMessage[];
};

const COLORS = ["#e8a54b", "#5ec8a7", "#f07178", "#7db4e8", "#d4a574", "#c9a0dc"];

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
});

const rooms = new Map<string, Room>();

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function emptyPlayback(): PlaybackState {
  return {
    mode: "link",
    videoUrl: "",
    screenSharerId: null,
    playing: false,
    currentTime: 0,
    updatedAt: Date.now(),
  };
}

function roomSnapshot(room: Room) {
  return {
    code: room.code,
    hostId: room.hostId,
    members: [...room.members.values()],
    playback: room.playback,
    messages: room.messages.slice(-80),
  };
}

function resolvedTime(playback: PlaybackState) {
  if (!playback.playing) return playback.currentTime;
  const elapsed = (Date.now() - playback.updatedAt) / 1000;
  return playback.currentTime + elapsed;
}

function emitWatch(room: Room) {
  io.to(room.code).emit("playback", room.playback);
}

io.on("connection", (socket) => {
  let joinedCode: string | null = null;

  socket.on("create-room", ({ name }: { name: string }, ack) => {
    const trimmed = (name || "Host").trim().slice(0, 24) || "Host";
    let code = makeCode();
    while (rooms.has(code)) code = makeCode();

    const member: Member = {
      id: socket.id,
      name: trimmed,
      color: COLORS[0],
    };

    const room: Room = {
      code,
      hostId: socket.id,
      members: new Map([[socket.id, member]]),
      playback: emptyPlayback(),
      messages: [],
    };

    rooms.set(code, room);
    joinedCode = code;
    socket.join(code);
    ack?.({ ok: true, room: roomSnapshot(room), you: member });
  });

  socket.on("join-room", ({ code, name }: { code: string; name: string }, ack) => {
    const room = rooms.get((code || "").toUpperCase().trim());
    if (!room) {
      ack?.({ ok: false, error: "Room not found" });
      return;
    }

    const trimmed = (name || "Guest").trim().slice(0, 24) || "Guest";
    const member: Member = {
      id: socket.id,
      name: trimmed,
      color: COLORS[room.members.size % COLORS.length],
    };

    room.members.set(socket.id, member);
    joinedCode = room.code;
    socket.join(room.code);

    const snap = roomSnapshot(room);
    snap.playback = {
      ...room.playback,
      currentTime: resolvedTime(room.playback),
      updatedAt: Date.now(),
    };

    ack?.({ ok: true, room: snap, you: member });
    socket.to(room.code).emit("member-joined", member);
    io.to(room.code).emit("members", [...room.members.values()]);
  });

  socket.on("set-video", ({ videoUrl }: { videoUrl: string }) => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room || room.hostId !== socket.id) return;

    room.playback = {
      mode: "link",
      videoUrl: (videoUrl || "").trim(),
      screenSharerId: null,
      playing: false,
      currentTime: 0,
      updatedAt: Date.now(),
    };
    emitWatch(room);
  });

  socket.on("start-screen", () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;

    room.playback = {
      mode: "screen",
      videoUrl: "",
      screenSharerId: socket.id,
      playing: false,
      currentTime: 0,
      updatedAt: Date.now(),
    };
    emitWatch(room);
  });

  socket.on("stop-screen", () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    if (room.playback.screenSharerId !== socket.id) return;

    room.playback = emptyPlayback();
    emitWatch(room);
  });

  /** Late joiner asks the current sharer to re-send the WebRTC offer. */
  socket.on("request-screen", () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room?.playback.screenSharerId) return;
    if (room.playback.screenSharerId === socket.id) return;
    io.to(room.playback.screenSharerId).emit("request-screen", { from: socket.id });
  });

  /** Tell peers with cameras to offer toward this socket. */
  socket.on("cam-ready", () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    socket.to(joinedCode).emit("cam-ready", { from: socket.id });
  });

  socket.on(
    "playback",
    ({
      playing,
      currentTime,
    }: {
      playing: boolean;
      currentTime: number;
    }) => {
      if (!joinedCode) return;
      const room = rooms.get(joinedCode);
      if (!room || room.playback.mode !== "link") return;

      room.playback = {
        ...room.playback,
        playing: !!playing,
        currentTime: Math.max(0, Number(currentTime) || 0),
        updatedAt: Date.now(),
      };
      socket.to(joinedCode).emit("playback", room.playback);
    },
  );

  socket.on("chat", ({ text }: { text: string }) => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    const member = room.members.get(socket.id);
    if (!member) return;

    const clean = (text || "").trim().slice(0, 400);
    if (!clean) return;

    const message: ChatMessage = {
      id: `${Date.now()}-${socket.id}`,
      userId: member.id,
      name: member.name,
      color: member.color,
      text: clean,
      at: Date.now(),
    };
    room.messages.push(message);
    if (room.messages.length > 200) room.messages.shift();
    io.to(joinedCode).emit("chat", message);
  });

  socket.on("reaction", ({ emoji }: { emoji: string }) => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    const member = room.members.get(socket.id);
    if (!member) return;

    const allowed = ["❤️", "😂", "🔥", "👏", "😮", "😢", "👍", "🎉"];
    if (!allowed.includes(emoji)) return;

    io.to(joinedCode).emit("reaction", {
      id: `${Date.now()}-${Math.random()}`,
      emoji,
      name: member.name,
      color: member.color,
      x: 12 + Math.random() * 76,
    });
  });

  socket.on("webrtc-offer", ({ to, sdp }: { to: string; sdp: unknown }) => {
    if (!joinedCode || !to || !sdp) return;
    const room = rooms.get(joinedCode);
    if (!room?.members.has(to)) return;
    io.to(to).emit("webrtc-offer", { from: socket.id, sdp });
  });

  socket.on("webrtc-answer", ({ to, sdp }: { to: string; sdp: unknown }) => {
    if (!joinedCode || !to || !sdp) return;
    const room = rooms.get(joinedCode);
    if (!room?.members.has(to)) return;
    io.to(to).emit("webrtc-answer", { from: socket.id, sdp });
  });

  socket.on("webrtc-ice", ({ to, candidate }: { to: string; candidate: unknown }) => {
    if (!joinedCode || !to) return;
    const room = rooms.get(joinedCode);
    if (!room?.members.has(to)) return;
    io.to(to).emit("webrtc-ice", { from: socket.id, candidate: candidate ?? null });
  });

  socket.on("cam-offer", ({ to, sdp }: { to: string; sdp: unknown }) => {
    if (!joinedCode || !to || !sdp) return;
    const room = rooms.get(joinedCode);
    if (!room?.members.has(to)) return;
    io.to(to).emit("cam-offer", { from: socket.id, sdp });
  });

  socket.on("cam-answer", ({ to, sdp }: { to: string; sdp: unknown }) => {
    if (!joinedCode || !to || !sdp) return;
    const room = rooms.get(joinedCode);
    if (!room?.members.has(to)) return;
    io.to(to).emit("cam-answer", { from: socket.id, sdp });
  });

  socket.on("cam-ice", ({ to, candidate }: { to: string; candidate: unknown }) => {
    if (!joinedCode || !to) return;
    const room = rooms.get(joinedCode);
    if (!room?.members.has(to)) return;
    io.to(to).emit("cam-ice", { from: socket.id, candidate: candidate ?? null });
  });

  socket.on("disconnect", () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;

    const wasSharer = room.playback.screenSharerId === socket.id;
    room.members.delete(socket.id);

    if (room.members.size === 0) {
      rooms.delete(joinedCode);
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = [...room.members.keys()][0];
      io.to(joinedCode).emit("host-changed", room.hostId);
    }

    if (wasSharer) {
      room.playback = emptyPlayback();
      emitWatch(room);
    }

    io.to(joinedCode).emit("members", [...room.members.values()]);
    io.to(joinedCode).emit("member-left", socket.id);
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, "..", "dist");

if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/socket.io") || req.path.startsWith("/health")) {
      next();
      return;
    }
    res.sendFile(path.join(distPath, "index.html"));
  });
}

const PORT = Number(process.env.PORT) || 3001;
httpServer.listen(PORT, () => {
  console.log(`Teleparty server on http://localhost:${PORT}`);
});
