import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import type { Socket } from "socket.io-client";
import type {
  ChatMessage,
  FloatingReaction,
  Member,
  PlaybackState,
  RoomState,
} from "../types";
import { REACTIONS } from "../types";
import { useFaceChat } from "../hooks/useFaceChat";
import { useScreenWatch } from "../hooks/useScreenWatch";
import { usePanelLayout } from "../hooks/usePanelLayout";
import { VideoStage } from "./VideoStage";
import { ChatPanel } from "./ChatPanel";
import { ReactionBurst } from "./ReactionBurst";
import { FaceDock } from "./FaceDock";

type Props = {
  socket: Socket;
  room: RoomState;
  setRoom: Dispatch<SetStateAction<RoomState | null>>;
  you: Member;
  isHost: boolean;
  onLeave: () => void;
};

export function Room({ socket, room, setRoom, you, isHost, onLeave }: Props) {
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const [copied, setCopied] = useState(false);
  const [videoDraft, setVideoDraft] = useState(room.playback.videoUrl);
  const [picker, setPicker] = useState<"link" | "screen">(
    room.playback.mode === "screen" ? "screen" : "link",
  );

  const screen = useScreenWatch({
    socket,
    youId: you.id,
    members: room.members,
    screenSharerId: room.playback.screenSharerId,
    active: room.playback.mode === "screen",
  });

  const faces = useFaceChat({
    socket,
    youId: you.id,
    members: room.members,
  });

  const layout = usePanelLayout();

  useEffect(() => {
    setPicker(room.playback.mode === "screen" ? "screen" : "link");
  }, [room.playback.mode]);

  useEffect(() => {
    const onMembers = (members: Member[]) => {
      setRoom((r) => (r ? { ...r, members } : r));
    };
    const onHost = (hostId: string) => {
      setRoom((r) => (r ? { ...r, hostId } : r));
    };
    const onPlayback = (playback: PlaybackState) => {
      setRoom((r) => (r ? { ...r, playback } : r));
      if (playback.mode === "link" && playback.videoUrl) {
        setVideoDraft(playback.videoUrl);
      }
    };
    const onChat = (message: ChatMessage) => {
      setRoom((r) => (r ? { ...r, messages: [...r.messages, message] } : r));
    };
    const onReaction = (reaction: FloatingReaction) => {
      setReactions((list) => [...list, reaction]);
      window.setTimeout(() => {
        setReactions((list) => list.filter((x) => x.id !== reaction.id));
      }, 2800);
    };

    socket.on("members", onMembers);
    socket.on("host-changed", onHost);
    socket.on("playback", onPlayback);
    socket.on("chat", onChat);
    socket.on("reaction", onReaction);

    return () => {
      socket.off("members", onMembers);
      socket.off("host-changed", onHost);
      socket.off("playback", onPlayback);
      socket.off("chat", onChat);
      socket.off("reaction", onReaction);
    };
  }, [socket, setRoom]);

  function copyCode() {
    navigator.clipboard.writeText(room.code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }

  function setVideo(e: FormEvent) {
    e.preventDefault();
    if (!isHost) return;
    if (screen.isSharing) screen.stopShare();
    socket.emit("set-video", { videoUrl: videoDraft.trim() });
  }

  function emitPlayback(playing: boolean, currentTime: number) {
    socket.emit("playback", { playing, currentTime });
  }

  function sendChat(text: string) {
    socket.emit("chat", { text });
  }

  function sendReaction(emoji: string) {
    socket.emit("reaction", { emoji });
  }

  const sharer = room.members.find((m) => m.id === room.playback.screenSharerId);
  const cinema = room.playback.mode === "screen" && !!room.playback.screenSharerId;

  return (
    <div className={`room ${cinema ? "room--cinema" : ""}`}>
      <div className="room__grain" aria-hidden />
      <ReactionBurst reactions={reactions} />

      {!cinema && (
        <header className="room__bar">
          <div className="room__brand">
            <span className="room__wordmark">Teleparty</span>
            <button type="button" className="room__code" onClick={copyCode} title="Copy room code">
              {room.code}
              <span>{copied ? "Copied" : "Invite"}</span>
            </button>
          </div>

          <ul className="room__people">
            {room.members.map((m) => (
              <li key={m.id} style={{ ["--dot" as string]: m.color }}>
                {m.name}
                {m.id === room.hostId ? " · host" : ""}
                {m.id === you.id ? " · you" : ""}
              </li>
            ))}
          </ul>

          <button type="button" className="btn-ghost" onClick={onLeave}>
            Leave
          </button>
        </header>
      )}

      <main className="room__main">
        <div
          className="room__watch"
          style={{
            gridTemplateColumns: `minmax(0, 1fr) 8px ${layout.sideWidth}px`,
          }}
        >
          <section className="room__stage">
            {!cinema && (
              <>
                <div className="watch-picker" role="tablist" aria-label="How to watch">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={picker === "link"}
                    className={picker === "link" ? "is-active" : ""}
                    onClick={() => setPicker("link")}
                  >
                    Video link
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={picker === "screen"}
                    className={picker === "screen" ? "is-active" : ""}
                    onClick={() => setPicker("screen")}
                  >
                    Share screen
                  </button>
                </div>

                {picker === "link" && isHost && (
                  <form className="room__video-form" onSubmit={setVideo}>
                    <input
                      value={videoDraft}
                      onChange={(e) => setVideoDraft(e.target.value)}
                      placeholder="Paste a direct video URL (https://…/movie.mp4)"
                      spellCheck={false}
                    />
                    <button type="submit" className="btn-primary btn-compact">
                      Watch together
                    </button>
                  </form>
                )}

                {picker === "link" && !isHost && (
                  <p className="watch-hint">Host pastes the video link. Everyone stays in sync here.</p>
                )}

                {picker === "screen" && (
                  <div className="screen-actions">
                    <p className="watch-hint">
                      Share a window or display so the room watches that instead of a link.
                    </p>
                    <button
                      type="button"
                      className="btn-primary btn-compact"
                      onClick={() => void screen.startShare()}
                    >
                      Share my screen
                    </button>
                    {screen.error && <p className="call__error">{screen.error}</p>}
                  </div>
                )}
              </>
            )}

            {cinema && (
              <div className="cinema-controls">
                <button type="button" className="room__code" onClick={copyCode} title="Copy room code">
                  {room.code}
                  <span>{copied ? "Copied" : "Invite"}</span>
                </button>
                <span className="cinema-controls__live">
                  Live{sharer ? ` · ${sharer.name}` : ""}
                  {screen.status ? ` · ${screen.status}` : ""}
                </span>
                {(screen.isSharing || room.playback.screenSharerId === you.id) && (
                  <button
                    type="button"
                    className="btn-ghost is-danger"
                    onClick={() => screen.stopShare()}
                  >
                    Stop share
                  </button>
                )}
                <button type="button" className="btn-ghost" onClick={onLeave}>
                  Leave
                </button>
              </div>
            )}
            {cinema && screen.error && <p className="call__error">{screen.error}</p>}

            <VideoStage
              playback={room.playback}
              screenStream={screen.stageStream}
              onLocalChange={emitPlayback}
              syncToken={`${room.playback.updatedAt}-${room.playback.playing}-${room.playback.videoUrl}`}
              sharerName={sharer?.name}
              isLocalShare={room.playback.screenSharerId === you.id}
            />

            <div className="room__reactions" role="toolbar" aria-label="Reactions">
              {REACTIONS.map((emoji) => (
                <button key={emoji} type="button" onClick={() => sendReaction(emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
          </section>

          <div
            className="resize-handle resize-handle--col"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize main stage and side panel"
            onPointerDown={layout.startSideDrag}
          />

          <aside
            className="room__side"
            style={{
              gridTemplateRows: `minmax(0, ${layout.facesRatio}fr) 8px minmax(0, ${1 - layout.facesRatio}fr)`,
            }}
          >
            <FaceDock
              localStream={faces.localStream}
              remotes={faces.remotes}
              youName={you.name}
              camOn={faces.camOn}
              micOn={faces.micOn}
              error={faces.error}
              onStart={() => void faces.startCamera()}
              onStop={() => void faces.stopCamera()}
              onToggleCam={() => void faces.toggleCam()}
              onToggleMic={faces.toggleMic}
            />
            <div
              className="resize-handle resize-handle--row"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize cameras and chat"
              onPointerDown={layout.startFacesDrag}
            />
            <ChatPanel messages={room.messages} youId={you.id} onSend={sendChat} />
          </aside>
        </div>
      </main>
    </div>
  );
}
