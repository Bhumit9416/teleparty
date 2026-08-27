import { useEffect, useRef } from "react";
import type { PlaybackState } from "../types";

type Props = {
  playback: PlaybackState;
  screenStream: MediaStream | null;
  onLocalChange: (playing: boolean, currentTime: number) => void;
  syncToken: string;
  sharerName?: string;
  isLocalShare?: boolean;
};

function resolvedTime(playback: PlaybackState) {
  if (!playback.playing) return playback.currentTime;
  return playback.currentTime + (Date.now() - playback.updatedAt) / 1000;
}

export function VideoStage({
  playback,
  screenStream,
  onLocalChange,
  syncToken,
  sharerName,
  isLocalShare,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const screenRef = useRef<HTMLVideoElement>(null);
  const ignoreUntil = useRef(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || playback.mode !== "link" || !playback.videoUrl) return;

    const target = resolvedTime(playback);
    const drift = Math.abs(video.currentTime - target);

    ignoreUntil.current = Date.now() + 400;

    if (drift > 0.45) {
      video.currentTime = target;
    }

    if (playback.playing) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [syncToken, playback]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || playback.mode !== "link") return;

    const maybeEmit = (playing: boolean) => {
      if (Date.now() < ignoreUntil.current) return;
      onLocalChange(playing, video.currentTime);
    };

    const onPlay = () => maybeEmit(true);
    const onPause = () => maybeEmit(false);
    const onSeeked = () => {
      if (Date.now() < ignoreUntil.current) return;
      onLocalChange(!video.paused, video.currentTime);
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onSeeked);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onSeeked);
    };
  }, [onLocalChange, playback.mode]);

  useEffect(() => {
    const el = screenRef.current;
    if (!el) return;

    if (el.srcObject !== screenStream) {
      el.srcObject = screenStream;
    }

    if (!screenStream) return;

    const tryPlay = () => {
      el.play().catch(() => {});
    };

    tryPlay();
    el.addEventListener("loadedmetadata", tryPlay);
    return () => el.removeEventListener("loadedmetadata", tryPlay);
  }, [screenStream]);

  if (playback.mode === "screen") {
    // Never mirror the sharer's own capture into this page — if they picked this
    // Teleparty tab (or a window that includes it), that creates a recursive "website" preview.
    if (isLocalShare) {
      return (
        <div className="stage stage--empty stage--sharing">
          <p>You’re sharing to the room</p>
          <p className="stage__hint">
            Others see the tab or window you picked — not this Teleparty page. Keep that
            video playing in another tab/window.
          </p>
        </div>
      );
    }

    if (!screenStream) {
      return (
        <div className="stage stage--empty">
          <p>
            {sharerName
              ? `Connecting to ${sharerName}'s screen…`
              : "Someone is sharing a screen — connecting…"}
          </p>
          <p className="stage__hint">Stay in this tab; the live screen appears here for everyone.</p>
        </div>
      );
    }

    return (
      <div className="stage stage--screen">
        <video
          ref={screenRef}
          className="stage__video stage__video--screen"
          autoPlay
          playsInline
        />
      </div>
    );
  }

  if (!playback.videoUrl) {
    return (
      <div className="stage stage--empty">
        <p>Pick a way to watch together above.</p>
        <p className="stage__hint">
          Paste a direct video link, or share a screen so the whole room sees the same thing.
        </p>
      </div>
    );
  }

  return (
    <div className="stage">
      <video
        key={playback.videoUrl}
        ref={videoRef}
        className="stage__video"
        src={playback.videoUrl}
        controls
        playsInline
        crossOrigin="anonymous"
      />
    </div>
  );
}
