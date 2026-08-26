import { useEffect, useRef } from "react";
import type { FacePeer } from "../hooks/useFaceChat";

type Props = {
  localStream: MediaStream | null;
  remotes: FacePeer[];
  youName: string;
  camOn: boolean;
  micOn: boolean;
  error: string;
  onStart: () => void;
  onStop: () => void;
  onToggleCam: () => void;
  onToggleMic: () => void;
};

function FaceTile({
  stream,
  label,
  muted,
  mirror,
  color,
}: {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
  mirror?: boolean;
  color?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
    if (stream) {
      el.play().catch(() => {});
    }
  }, [stream]);

  return (
    <figure className={`face-tile ${stream ? "" : "is-empty"}`}>
      <video ref={ref} autoPlay playsInline muted={muted} className={mirror ? "is-mirror" : ""} />
      <figcaption style={color ? { color } : undefined}>{label}</figcaption>
    </figure>
  );
}

export function FaceDock({
  localStream,
  remotes,
  youName,
  camOn,
  micOn,
  error,
  onStart,
  onStop,
  onToggleCam,
  onToggleMic,
}: Props) {
  return (
    <aside className="faces" aria-label="Participant cameras">
      <div className="faces__head">
        <h2>Together</h2>
      </div>

      <div className="faces__grid">
        <FaceTile
          stream={localStream}
          label={localStream ? `${youName} (you)` : "You"}
          muted
          mirror
        />
        {remotes.map((r) => (
          <FaceTile key={r.id} stream={r.stream} label={r.name} color={r.color} />
        ))}
        {!localStream && remotes.length === 0 && (
          <p className="faces__empty">Turn on your camera to appear here.</p>
        )}
      </div>

      <div className="faces__controls" role="toolbar" aria-label="Camera controls">
        {!localStream ? (
          <button type="button" className="btn-primary btn-compact" onClick={onStart}>
            Turn on camera
          </button>
        ) : (
          <>
            <button
              type="button"
              className={`btn-ghost ${camOn ? "is-on" : ""}`}
              onClick={onToggleCam}
            >
              {camOn ? "Cam" : "Cam off"}
            </button>
            <button
              type="button"
              className={`btn-ghost ${micOn ? "is-on" : ""}`}
              onClick={onToggleMic}
            >
              {micOn ? "Mic" : "Mic off"}
            </button>
            <button type="button" className="btn-ghost is-danger" onClick={onStop}>
              Stop
            </button>
          </>
        )}
      </div>

      {error && <p className="call__error">{error}</p>}
    </aside>
  );
}
