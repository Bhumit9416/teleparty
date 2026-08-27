import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { Member } from "../types";
import {
  addIce,
  ensureIce,
  flushIce,
  getIce,
  isPcDead,
  type IceQueue,
} from "../lib/rtc";

type Options = {
  socket: Socket;
  youId: string;
  members: Member[];
  screenSharerId: string | null;
  active: boolean;
};

const ICE_BASE =
  import.meta.env.VITE_SOCKET_URL ||
  (import.meta.env.DEV ? "http://localhost:3001" : window.location.origin);

async function tuneOutgoing(pc: RTCPeerConnection) {
  for (const sender of pc.getSenders()) {
    if (!sender.track) continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    if (sender.track.kind === "video") {
      params.encodings[0].maxBitrate = 2_500_000;
      params.encodings[0].maxFramerate = 24;
      params.degradationPreference = "maintain-framerate";
    } else if (sender.track.kind === "audio") {
      params.encodings[0].maxBitrate = 128_000;
    }
    try {
      await sender.setParameters(params);
    } catch {
      /* ignore */
    }
  }
}

function socketUrl() {
  return ICE_BASE;
}

export function useScreenWatch({
  socket,
  youId,
  members,
  screenSharerId,
  active,
}: Options) {
  const [localScreen, setLocalScreen] = useState<MediaStream | null>(null);
  const [remoteScreen, setRemoteScreen] = useState<MediaStream | null>(null);
  const [error, setError] = useState("");
  const [linkState, setLinkState] = useState("");

  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const makingOfferRef = useRef<Set<string>>(new Set());
  const screenRef = useRef<MediaStream | null>(null);
  const remoteRtcRef = useRef<MediaStream | null>(null);
  const iceQueueRef = useRef<IceQueue>(new Map());
  const membersRef = useRef(members);
  const sharerRef = useRef(screenSharerId);
  const youRef = useRef(youId);
  const offerToRef = useRef<(peerId: string) => Promise<void>>(async () => {});
  const relayTimerRef = useRef<number | null>(null);
  const fallbackVideoRef = useRef<HTMLVideoElement | null>(null);
  const fallbackCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fallbackStreamRef = useRef<MediaStream | null>(null);
  const webrtcOkRef = useRef(false);

  useEffect(() => {
    membersRef.current = members;
  }, [members]);
  useEffect(() => {
    sharerRef.current = screenSharerId;
  }, [screenSharerId]);
  useEffect(() => {
    youRef.current = youId;
  }, [youId]);

  const preferStream = useCallback(() => {
    if (sharerRef.current === youRef.current) {
      setRemoteScreen(null);
      return;
    }
    if (webrtcOkRef.current && remoteRtcRef.current?.getVideoTracks().some((t) => t.readyState === "live")) {
      setRemoteScreen(remoteRtcRef.current);
      setLinkState("Screen connected");
      return;
    }
    if (fallbackStreamRef.current) {
      setRemoteScreen(fallbackStreamRef.current);
      setLinkState("Screen live (relay)");
    }
  }, []);

  const stopRelay = useCallback(() => {
    if (relayTimerRef.current) {
      window.clearInterval(relayTimerRef.current);
      relayTimerRef.current = null;
    }
    fallbackVideoRef.current = null;
  }, []);

  const ensureFallbackPainter = useCallback(() => {
    if (fallbackCanvasRef.current && fallbackStreamRef.current) return;
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const stream = canvas.captureStream(10);
    fallbackCanvasRef.current = canvas;
    fallbackStreamRef.current = stream;
  }, []);

  const startRelay = useCallback(
    async (screen: MediaStream) => {
      stopRelay();
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = screen;
      fallbackVideoRef.current = video;
      try {
        await video.play();
      } catch {
        /* ignore */
      }

      relayTimerRef.current = window.setInterval(() => {
        if (!screenRef.current || sharerRef.current !== youRef.current) return;
        const v = fallbackVideoRef.current;
        if (!v || !v.videoWidth) return;

        const maxW = 1280;
        const scale = Math.min(1, maxW / v.videoWidth);
        const w = Math.max(2, Math.round(v.videoWidth * scale));
        const h = Math.max(2, Math.round(v.videoHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(v, 0, 0, w, h);
        canvas.toBlob(
          (blob) => {
            if (!blob || blob.size > 900_000) return;
            void blob.arrayBuffer().then((buf) => {
              socket.volatile.emit("screen-frame", buf);
            });
          },
          "image/jpeg",
          0.58,
        );
      }, 140);
    },
    [socket, stopRelay],
  );

  const closePeer = useCallback((id: string) => {
    peersRef.current.get(id)?.close();
    peersRef.current.delete(id);
    iceQueueRef.current.delete(id);
    makingOfferRef.current.delete(id);
  }, []);

  const closeAll = useCallback(() => {
    for (const id of [...peersRef.current.keys()]) closePeer(id);
  }, [closePeer]);

  const ensurePeer = useCallback(
    async (peerId: string, asSharer: boolean) => {
      await ensureIce(socketUrl());
      let pc = peersRef.current.get(peerId);
      if (pc && !isPcDead(pc)) return pc;
      if (pc) {
        pc.close();
        peersRef.current.delete(peerId);
      }

      pc = new RTCPeerConnection(getIce());
      peersRef.current.set(peerId, pc);

      if (asSharer && screenRef.current) {
        for (const track of screenRef.current.getTracks()) {
          pc.addTrack(track, screenRef.current);
        }
      }

      pc.onicecandidate = (ev) => {
        socket.emit("webrtc-ice", {
          to: peerId,
          candidate: ev.candidate ? ev.candidate.toJSON() : null,
        });
      };

      pc.ontrack = (ev) => {
        if (sharerRef.current === youRef.current) return;
        const inbound = ev.streams[0] || new MediaStream([ev.track]);
        const merged = remoteRtcRef.current ?? new MediaStream();
        for (const t of inbound.getTracks()) {
          if (!merged.getTrackById(t.id)) merged.addTrack(t);
        }
        if (!merged.getTrackById(ev.track.id)) merged.addTrack(ev.track);
        remoteRtcRef.current = new MediaStream(merged.getTracks());
        webrtcOkRef.current = true;
        preferStream();
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          webrtcOkRef.current = true;
          preferStream();
        }
        if (pc.connectionState === "failed") {
          webrtcOkRef.current = false;
          closePeer(peerId);
          if (sharerRef.current === youRef.current && screenRef.current) {
            window.setTimeout(() => void offerToRef.current(peerId), 1200);
          }
          preferStream();
        }
      };

      return pc;
    },
    [closePeer, preferStream, socket],
  );

  const offerTo = useCallback(
    async (peerId: string) => {
      if (!screenRef.current || peerId === youRef.current) return;
      if (makingOfferRef.current.has(peerId)) return;

      let pc = peersRef.current.get(peerId);
      if (pc?.connectionState === "connected") return;
      if (pc && pc.signalingState !== "stable") return;

      makingOfferRef.current.add(peerId);
      try {
        if (!pc || isPcDead(pc)) {
          pc = await ensurePeer(peerId, true);
        } else {
          for (const track of screenRef.current.getTracks()) {
            if (!pc.getSenders().some((s) => s.track?.id === track.id)) {
              pc.addTrack(track, screenRef.current);
            }
          }
        }
        await tuneOutgoing(pc);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("webrtc-offer", { to: peerId, sdp: pc.localDescription });
        setLinkState("Sending screen…");
      } catch {
        closePeer(peerId);
      } finally {
        makingOfferRef.current.delete(peerId);
      }
    },
    [closePeer, ensurePeer, socket],
  );

  useEffect(() => {
    offerToRef.current = offerTo;
  }, [offerTo]);

  const pushToEveryone = useCallback(() => {
    if (sharerRef.current !== youRef.current || !screenRef.current) return;
    for (const m of membersRef.current) {
      if (m.id === youRef.current) continue;
      void offerTo(m.id);
    }
  }, [offerTo]);

  const startShare = useCallback(async () => {
    setError("");
    setLinkState("Starting share…");
    try {
      await ensureIce(socketUrl());

      let screen: MediaStream;
      try {
        screen = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: { ideal: 24, max: 30 },
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
          },
          audio: {
            channelCount: 2,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          systemAudio: "include",
        } as DisplayMediaStreamOptions);
      } catch {
        try {
          screen = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
          });
        } catch {
          screen = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: false,
          });
        }
      }

      if (!screen.getAudioTracks().length) {
        setError("Enable “Share tab audio” in the browser dialog for sound.");
      }

      screenRef.current?.getTracks().forEach((t) => t.stop());
      screenRef.current = screen;
      setLocalScreen(screen);
      setRemoteScreen(null);
      remoteRtcRef.current = null;
      webrtcOkRef.current = false;
      closeAll();
      socket.emit("start-screen");
      setLinkState("Sharing…");

      // Relay works on any network; WebRTC upgrades quality when it connects.
      void startRelay(screen);
      window.setTimeout(() => pushToEveryone(), 400);
      window.setTimeout(() => pushToEveryone(), 2500);

      screen.getVideoTracks()[0].onended = () => {
        screenRef.current = null;
        setLocalScreen(null);
        stopRelay();
        closeAll();
        socket.emit("stop-screen");
        setLinkState("");
      };
    } catch {
      setError("Screen share cancelled or unavailable.");
      setLinkState("");
    }
  }, [closeAll, pushToEveryone, socket, startRelay, stopRelay]);

  const stopShare = useCallback(() => {
    screenRef.current?.getTracks().forEach((t) => t.stop());
    screenRef.current = null;
    setLocalScreen(null);
    stopRelay();
    closeAll();
    socket.emit("stop-screen");
    setLinkState("");
  }, [closeAll, socket, stopRelay]);

  useEffect(() => {
    if (!active || screenSharerId !== youId || !screenRef.current) return;
    pushToEveryone();
  }, [active, members, screenSharerId, youId, pushToEveryone]);

  useEffect(() => {
    if (!active || !screenSharerId || screenSharerId === youId) return;
    setLinkState("Waiting for screen…");
    const ping = () => socket.emit("request-screen");
    ping();
    const t = window.setTimeout(ping, 2000);
    return () => window.clearTimeout(t);
  }, [active, screenSharerId, youId, socket]);

  useEffect(() => {
    if (!active && screenSharerId !== youId) {
      setRemoteScreen(null);
      remoteRtcRef.current = null;
      webrtcOkRef.current = false;
      closeAll();
      setLinkState("");
    }
  }, [active, screenSharerId, youId, closeAll]);

  useEffect(() => {
    const onJoined = (member: Member) => {
      if (member.id === youId) return;
      if (sharerRef.current === youId && screenRef.current) {
        window.setTimeout(() => void offerTo(member.id), 500);
      }
    };

    const onLeft = (id: string) => {
      closePeer(id);
      if (sharerRef.current === id) {
        setRemoteScreen(null);
        remoteRtcRef.current = null;
        webrtcOkRef.current = false;
        setLinkState("");
      }
    };

    const onRequest = ({ from }: { from: string }) => {
      if (sharerRef.current !== youId || !screenRef.current) return;
      void offerTo(from);
    };

    const onOffer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      if (from === youId) return;
      sharerRef.current = from;
      try {
        const existing = peersRef.current.get(from);
        if (existing && !isPcDead(existing) && existing.signalingState === "have-local-offer") {
          // ignore glare — sharer is the only offerer
          return;
        }
        closePeer(from);
        const pc = await ensurePeer(from, false);
        await pc.setRemoteDescription(sdp);
        await flushIce(pc, from, iceQueueRef.current);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("webrtc-answer", { to: from, sdp: pc.localDescription });
        setLinkState("Connecting screen…");
      } catch {
        closePeer(from);
        socket.emit("request-screen");
      }
    };

    const onAnswer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      const pc = peersRef.current.get(from);
      if (!pc || pc.signalingState !== "have-local-offer") return;
      try {
        await pc.setRemoteDescription(sdp);
        await flushIce(pc, from, iceQueueRef.current);
        await tuneOutgoing(pc);
      } catch {
        closePeer(from);
      }
    };

    const onIce = async ({
      from,
      candidate,
    }: {
      from: string;
      candidate: RTCIceCandidateInit | null;
    }) => {
      let pc = peersRef.current.get(from);
      if (!pc) {
        pc = await ensurePeer(from, sharerRef.current === youId && !!screenRef.current);
      }
      await addIce(pc, from, candidate, iceQueueRef.current);
    };

    const onFrame = async (payload: ArrayBuffer | Blob) => {
      if (sharerRef.current === youRef.current) return;
      ensureFallbackPainter();
      const canvas = fallbackCanvasRef.current;
      if (!canvas) return;
      try {
        const blob =
          payload instanceof Blob
            ? payload
            : new Blob([payload], { type: "image/jpeg" });
        const bmp = await createImageBitmap(blob);
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(bmp, 0, 0);
        bmp.close();
        preferStream();
      } catch {
        /* ignore bad frame */
      }
    };

    socket.on("member-joined", onJoined);
    socket.on("member-left", onLeft);
    socket.on("request-screen", onRequest);
    socket.on("webrtc-offer", onOffer);
    socket.on("webrtc-answer", onAnswer);
    socket.on("webrtc-ice", onIce);
    socket.on("screen-frame", onFrame);

    return () => {
      socket.off("member-joined", onJoined);
      socket.off("member-left", onLeft);
      socket.off("request-screen", onRequest);
      socket.off("webrtc-offer", onOffer);
      socket.off("webrtc-answer", onAnswer);
      socket.off("webrtc-ice", onIce);
      socket.off("screen-frame", onFrame);
    };
  }, [closePeer, ensureFallbackPainter, ensurePeer, offerTo, preferStream, socket, youId]);

  useEffect(() => {
    return () => {
      screenRef.current?.getTracks().forEach((t) => t.stop());
      stopRelay();
      closeAll();
    };
  }, [closeAll, stopRelay]);

  const stageStream =
    screenSharerId === youId ? localScreen : screenSharerId ? remoteScreen : null;

  const waiting =
    !!screenSharerId &&
    screenSharerId !== youId &&
    !remoteScreen?.getVideoTracks().some((t) => t.readyState === "live");

  return {
    stageStream,
    isSharing: screenSharerId === youId && !!localScreen,
    error: error || (waiting ? linkState || "Waiting for screen…" : ""),
    status: linkState,
    startShare,
    stopShare,
  };
}
