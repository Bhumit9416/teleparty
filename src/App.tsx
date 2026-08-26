import { useEffect, useMemo, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Lobby } from "./components/Lobby";
import { Room } from "./components/Room";
import type { Member, RoomState } from "./types";

const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ||
  (import.meta.env.DEV ? "http://localhost:3001" : window.location.origin);

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [you, setYou] = useState<Member | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const s = io(SOCKET_URL, { autoConnect: true });
    setSocket(s);
    return () => {
      s.disconnect();
    };
  }, []);

  const isHost = useMemo(
    () => !!(room && you && room.hostId === you.id),
    [room, you],
  );

  function createRoom(name: string) {
    if (!socket) return;
    setConnecting(true);
    setError("");
    socket.emit("create-room", { name }, (res: { ok: boolean; room?: RoomState; you?: Member; error?: string }) => {
      setConnecting(false);
      if (!res?.ok || !res.room || !res.you) {
        setError(res?.error || "Could not create room");
        return;
      }
      setRoom(res.room);
      setYou(res.you);
    });
  }

  function joinRoom(code: string, name: string) {
    if (!socket) return;
    setConnecting(true);
    setError("");
    socket.emit(
      "join-room",
      { code, name },
      (res: { ok: boolean; room?: RoomState; you?: Member; error?: string }) => {
        setConnecting(false);
        if (!res?.ok || !res.room || !res.you) {
          setError(res?.error || "Could not join room");
          return;
        }
        setRoom(res.room);
        setYou(res.you);
      },
    );
  }

  function leaveRoom() {
    socket?.disconnect();
    setRoom(null);
    setYou(null);
    const s = io(SOCKET_URL, { autoConnect: true });
    setSocket(s);
  }

  if (room && you && socket) {
    return (
      <Room
        socket={socket}
        room={room}
        setRoom={setRoom}
        you={you}
        isHost={isHost}
        onLeave={leaveRoom}
      />
    );
  }

  return (
    <Lobby
      onCreate={createRoom}
      onJoin={joinRoom}
      error={error}
      connecting={connecting}
    />
  );
}
