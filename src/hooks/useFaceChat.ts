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

export type FacePeer = {
  id: string;
  stream: MediaStream;
  name: string;
  color: string;
};

type Options = {
  socket: Socket;
  youId: string;
  members: Member[];
};

const ICE_BASE =
  import.meta.env.VITE_SOCKET_URL ||
  (import.meta.env.DEV ? "http://localhost:3001" : window.location.origin);

export function useFaceChat({ socket, youId, members }: Options) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remotes, setRemotes] = useState<FacePeer[]>([]);
  const [camOn, setCamOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [error, setError] = useState("");

  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const makingOfferRef = useRef<Set<string>>(new Set());
  const localRef = useRef<MediaStream | null>(null);
  const remoteRtcRef = useRef<Map<string, MediaStream>>(new Map());
  const iceQueueRef = useRef<IceQueue>(new Map());
  const membersRef = useRef(members);
  const youRef = useRef(youId);
  const offerToRef = useRef<(peerId: string) => Promise<void>>(async () => {});
  const relayTimerRef = useRef<number | null>(null);
  const fallbackCanvasRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const fallbackStreamRef = useRef<Map<string, MediaStream>>(new Map());
  const webrtcOkRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    membersRef.current = members;
  }, [members]);
  useEffect(() => {
    youRef.current = youId;
  }, [youId]);

  const memberMeta = useCallback((id: string) => {
    const member = membersRef.current.find((m) => m.id === id);
    return {
      name: member?.name || "Guest",
      color: member?.color || "#e8a54b",
    };
  }, []);

  const publishRemote = useCallback(
    (id: string, stream: MediaStream) => {
      const meta = memberMeta(id);
      setRemotes((list) => [
        ...list.filter((r) => r.id !== id),
        { id, stream, name: meta.name, color: meta.color },
      ]);
    },
    [memberMeta],
  );

  const preferRemote = useCallback(
    (id: string) => {
      if (webrtcOkRef.current.has(id)) {
        const rtc = remoteRtcRef.current.get(id);
        if (rtc?.getVideoTracks().some((t) => t.readyState === "live")) {
          publishRemote(id, rtc);
          return;
        }
      }
      const fallback = fallbackStreamRef.current.get(id);
      if (fallback) publishRemote(id, fallback);
    },
    [publishRemote],
  );

  const removeRemote = useCallback((id: string) => {
    remoteRtcRef.current.delete(id);
    fallbackStreamRef.current.delete(id);
    fallbackCanvasRef.current.delete(id);
    webrtcOkRef.current.delete(id);
    setRemotes((list) => list.filter((r) => r.id !== id));
  }, []);

  const ensureFallback = useCallback((id: string) => {
    if (fallbackCanvasRef.current.has(id) && fallbackStreamRef.current.has(id)) return;
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const stream = canvas.captureStream(6);
    fallbackCanvasRef.current.set(id, canvas);
    fallbackStreamRef.current.set(id, stream);
  }, []);

  const stopRelay = useCallback(() => {
    if (relayTimerRef.current) {
      window.clearInterval(relayTimerRef.current);
      relayTimerRef.current = null;
    }
  }, []);

  const startRelay = useCallback(
    (stream: MediaStream) => {
      stopRelay();
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      void video.play().catch(() => {});

      relayTimerRef.current = window.setInterval(() => {
        if (!localRef.current) return;
        if (!video.videoWidth) return;
        const w = 320;
        const h = Math.max(2, Math.round((video.videoHeight / video.videoWidth) * w));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, w, h);
        canvas.toBlob(
          (blob) => {
            if (!blob || blob.size > 120_000) return;
            void blob.arrayBuffer().then((buf) => {
              socket.volatile.emit("cam-frame", buf);
            });
          },
          "image/jpeg",
          0.5,
        );
      }, 220);
    },
    [socket, stopRelay],
  );

  const syncSenders = useCallback(async (pc: RTCPeerConnection, stream: MediaStream | null) => {
    for (const kind of ["audio", "video"] as const) {
      const track = stream?.getTracks().find((t) => t.kind === kind) || null;
      const sender = pc.getSenders().find((s) => s.track?.kind === kind);
      if (!sender && track && stream) pc.addTrack(track, stream);
      else if (sender) await sender.replaceTrack(track);
    }
  }, []);

  const ensurePeer = useCallback(
    async (peerId: string) => {
      await ensureIce(ICE_BASE);
      let pc = peersRef.current.get(peerId);
      if (pc && !isPcDead(pc)) return pc;
      if (pc) {
        pc.close();
        peersRef.current.delete(peerId);
      }

      pc = new RTCPeerConnection(getIce());
      peersRef.current.set(peerId, pc);

      if (localRef.current) {
        for (const track of localRef.current.getTracks()) {
          pc.addTrack(track, localRef.current);
        }
      }

      pc.onicecandidate = (ev) => {
        socket.emit("cam-ice", {
          to: peerId,
          candidate: ev.candidate ? ev.candidate.toJSON() : null,
        });
      };

      pc.ontrack = (ev) => {
        const inbound = ev.streams[0] || new MediaStream([ev.track]);
        let stream = remoteRtcRef.current.get(peerId) ?? new MediaStream();
        for (const t of inbound.getTracks()) {
          if (!stream.getTrackById(t.id)) stream.addTrack(t);
        }
        if (!stream.getTrackById(ev.track.id)) stream.addTrack(ev.track);
        const next = new MediaStream(stream.getTracks());
        remoteRtcRef.current.set(peerId, next);
        webrtcOkRef.current.add(peerId);
        preferRemote(peerId);
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          webrtcOkRef.current.add(peerId);
          preferRemote(peerId);
        }
        if (pc.connectionState === "failed") {
          webrtcOkRef.current.delete(peerId);
          peersRef.current.delete(peerId);
          pc.close();
          preferRemote(peerId);
          if (localRef.current) {
            window.setTimeout(() => void offerToRef.current(peerId), 1500);
          }
        }
      };

      return pc;
    },
    [preferRemote, socket],
  );

  const offerTo = useCallback(
    async (peerId: string) => {
      if (peerId === youRef.current || !localRef.current) return;
      if (makingOfferRef.current.has(peerId)) return;

      let pc = peersRef.current.get(peerId);
      if (pc?.connectionState === "connected") return;
      if (pc && pc.signalingState !== "stable") return;

      makingOfferRef.current.add(peerId);
      try {
        pc = await ensurePeer(peerId);
        await syncSenders(pc, localRef.current);
        if (pc.signalingState !== "stable") return;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("cam-offer", { to: peerId, sdp: pc.localDescription });
      } catch {
        /* ignore */
      } finally {
        makingOfferRef.current.delete(peerId);
      }
    },
    [ensurePeer, socket, syncSenders],
  );

  useEffect(() => {
    offerToRef.current = offerTo;
  }, [offerTo]);

  const connectAll = useCallback(() => {
    if (!localRef.current) return;
    for (const m of membersRef.current) {
      if (m.id === youRef.current) continue;
      void offerTo(m.id);
    }
  }, [offerTo]);

  const publish = useCallback(
    async (stream: MediaStream | null) => {
      localRef.current = stream;
      setLocalStream(stream);
      setCamOn(!!stream?.getVideoTracks().some((t) => t.enabled && t.readyState === "live"));
      setMicOn(!!stream?.getAudioTracks().some((t) => t.enabled && t.readyState === "live"));

      stopRelay();
      if (stream) {
        socket.emit("cam-ready");
        startRelay(stream);
        window.setTimeout(() => connectAll(), 400);
        window.setTimeout(() => connectAll(), 3000);
      } else {
        for (const pc of peersRef.current.values()) await syncSenders(pc, null);
      }
    },
    [connectAll, socket, startRelay, stopRelay, syncSenders],
  );

  const startCamera = useCallback(async () => {
    setError("");
    try {
      await ensureIce(ICE_BASE);
      const cam = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: true,
      });
      localRef.current?.getTracks().forEach((t) => t.stop());
      await publish(cam);
    } catch {
      setError("Camera/mic permission denied or unavailable.");
    }
  }, [publish]);

  const stopCamera = useCallback(async () => {
    localRef.current?.getTracks().forEach((t) => t.stop());
    await publish(null);
  }, [publish]);

  const toggleMic = useCallback(() => {
    const tracks = localRef.current?.getAudioTracks() || [];
    if (!tracks.length) return;
    const next = !tracks.some((t) => t.enabled);
    tracks.forEach((t) => {
      t.enabled = next;
    });
    setMicOn(next);
  }, []);

  const toggleCam = useCallback(async () => {
    if (!localRef.current?.getVideoTracks().length) {
      await startCamera();
      return;
    }
    const tracks = localRef.current.getVideoTracks();
    const next = !tracks.some((t) => t.enabled);
    tracks.forEach((t) => {
      t.enabled = next;
    });
    setCamOn(next);
  }, [startCamera]);

  useEffect(() => {
    if (!localStream) return;
    const t = window.setTimeout(() => connectAll(), 500);
    return () => window.clearTimeout(t);
  }, [members, localStream, connectAll]);

  useEffect(() => {
    const onJoined = (member: Member) => {
      if (member.id === youId || !localRef.current) return;
      window.setTimeout(() => void offerTo(member.id), 600);
    };

    const onLeft = (id: string) => {
      peersRef.current.get(id)?.close();
      peersRef.current.delete(id);
      iceQueueRef.current.delete(id);
      removeRemote(id);
    };

    const onReady = ({ from }: { from: string }) => {
      if (from === youId || !localRef.current) return;
      window.setTimeout(() => void offerTo(from), 400);
    };

    const onOffer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      const polite = youId > from;
      let pc = peersRef.current.get(from);

      if (pc && makingOfferRef.current.has(from)) {
        if (!polite) return;
        try {
          await pc.setLocalDescription({ type: "rollback" });
        } catch {
          /* ignore */
        }
      }

      try {
        if (!pc || isPcDead(pc)) {
          if (pc) pc.close();
          peersRef.current.delete(from);
          pc = await ensurePeer(from);
        }
        if (pc.signalingState === "have-local-offer" && !polite) return;
        await pc.setRemoteDescription(sdp);
        await flushIce(pc, from, iceQueueRef.current);
        if (localRef.current) await syncSenders(pc, localRef.current);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("cam-answer", { to: from, sdp: pc.localDescription });
      } catch {
        /* ignore */
      }
    };

    const onAnswer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      const pc = peersRef.current.get(from);
      if (!pc || pc.signalingState !== "have-local-offer") return;
      try {
        await pc.setRemoteDescription(sdp);
        await flushIce(pc, from, iceQueueRef.current);
      } catch {
        /* ignore */
      }
    };

    const onIce = async ({
      from,
      candidate,
    }: {
      from: string;
      candidate: RTCIceCandidateInit | null;
    }) => {
      const pc = peersRef.current.get(from) || (await ensurePeer(from));
      await addIce(pc, from, candidate, iceQueueRef.current);
    };

    const onFrame = async (payload: { from: string; data: ArrayBuffer | Blob | Buffer }) => {
      const from = payload?.from;
      const data = payload?.data;
      if (!from || from === youRef.current || !data) return;

      ensureFallback(from);
      const canvas = fallbackCanvasRef.current.get(from);
      if (!canvas) return;
      try {
        const blob =
          data instanceof Blob
            ? data
            : new Blob([data as ArrayBuffer], { type: "image/jpeg" });
        const bmp = await createImageBitmap(blob);
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        canvas.getContext("2d")?.drawImage(bmp, 0, 0);
        bmp.close();
        preferRemote(from);
      } catch {
        /* ignore */
      }
    };

    socket.on("member-joined", onJoined);
    socket.on("member-left", onLeft);
    socket.on("cam-ready", onReady);
    socket.on("cam-offer", onOffer);
    socket.on("cam-answer", onAnswer);
    socket.on("cam-ice", onIce);
    socket.on("cam-frame", onFrame);

    return () => {
      socket.off("member-joined", onJoined);
      socket.off("member-left", onLeft);
      socket.off("cam-ready", onReady);
      socket.off("cam-offer", onOffer);
      socket.off("cam-answer", onAnswer);
      socket.off("cam-ice", onIce);
      socket.off("cam-frame", onFrame);
    };
  }, [
    ensureFallback,
    ensurePeer,
    offerTo,
    preferRemote,
    removeRemote,
    socket,
    syncSenders,
    youId,
  ]);

  useEffect(() => {
    return () => {
      stopRelay();
      for (const pc of peersRef.current.values()) pc.close();
      peersRef.current.clear();
      localRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [stopRelay]);

  return {
    localStream,
    remotes,
    camOn,
    micOn,
    error,
    startCamera,
    stopCamera,
    toggleMic,
    toggleCam,
  };
}
