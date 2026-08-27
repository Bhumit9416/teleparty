import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { Member } from "../types";
import {
  ICE,
  addIce,
  flushIce,
  isPcDead,
  shouldRenegotiate,
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

export function useFaceChat({ socket, youId, members }: Options) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remotes, setRemotes] = useState<FacePeer[]>([]);
  const [camOn, setCamOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [error, setError] = useState("");

  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const offerStartedRef = useRef<Map<string, number>>(new Map());
  const makingOfferRef = useRef<Set<string>>(new Set());
  const localRef = useRef<MediaStream | null>(null);
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const iceQueueRef = useRef<IceQueue>(new Map());
  const membersRef = useRef(members);
  const youRef = useRef(youId);
  const offerToRef = useRef<(peerId: string, force?: boolean) => Promise<void>>(async () => {});

  useEffect(() => {
    membersRef.current = members;
  }, [members]);
  useEffect(() => {
    youRef.current = youId;
  }, [youId]);

  const upsertRemote = useCallback((id: string, stream: MediaStream) => {
    const member = membersRef.current.find((m) => m.id === id);
    remoteStreamsRef.current.set(id, stream);
    setRemotes((list) => [
      ...list.filter((r) => r.id !== id),
      {
        id,
        stream,
        name: member?.name || "Guest",
        color: member?.color || "#e8a54b",
      },
    ]);
  }, []);

  const removeRemote = useCallback((id: string) => {
    remoteStreamsRef.current.delete(id);
    setRemotes((list) => list.filter((r) => r.id !== id));
  }, []);

  const syncSenders = useCallback(async (pc: RTCPeerConnection, stream: MediaStream | null) => {
    for (const kind of ["audio", "video"] as const) {
      const track = stream?.getTracks().find((t) => t.kind === kind) || null;
      const sender = pc.getSenders().find((s) => s.track?.kind === kind);
      if (!sender && track && stream) pc.addTrack(track, stream);
      else if (sender) await sender.replaceTrack(track);
    }
  }, []);

  const ensurePeer = useCallback(
    (peerId: string) => {
      let pc = peersRef.current.get(peerId);
      if (pc && !isPcDead(pc) && !shouldRenegotiate(pc, offerStartedRef.current.get(peerId))) {
        return pc;
      }
      if (pc) {
        pc.close();
        peersRef.current.delete(peerId);
      }

      pc = new RTCPeerConnection(ICE);
      peersRef.current.set(peerId, pc);
      offerStartedRef.current.set(peerId, Date.now());

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
        let stream = remoteStreamsRef.current.get(peerId) ?? new MediaStream();
        for (const t of inbound.getTracks()) {
          if (!stream.getTrackById(t.id)) stream.addTrack(t);
        }
        if (!stream.getTrackById(ev.track.id)) stream.addTrack(ev.track);
        const next = new MediaStream(stream.getTracks());
        upsertRemote(peerId, next);
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          peersRef.current.delete(peerId);
          pc.close();
          removeRemote(peerId);
          if (localRef.current) {
            window.setTimeout(() => void offerToRef.current(peerId, true), 900);
          }
        }
      };

      return pc;
    },
    [removeRemote, socket, upsertRemote],
  );

  const offerTo = useCallback(
    async (peerId: string, force = false) => {
      if (peerId === youRef.current || !localRef.current) return;
      if (makingOfferRef.current.has(peerId)) return;

      let pc = peersRef.current.get(peerId);
      if (!force && pc?.connectionState === "connected") return;

      // Lower socket id initiates when both have cameras (avoids glare).
      const polite = youRef.current > peerId;
      if (!force && polite && pc && !isPcDead(pc)) return;

      if (force || shouldRenegotiate(pc, offerStartedRef.current.get(peerId))) {
        if (pc) {
          pc.close();
          peersRef.current.delete(peerId);
        }
        pc = ensurePeer(peerId);
      } else {
        pc = ensurePeer(peerId);
        if (pc.signalingState !== "stable") return;
      }

      makingOfferRef.current.add(peerId);
      offerStartedRef.current.set(peerId, Date.now());
      try {
        await syncSenders(pc, localRef.current);
        const offer = await pc.createOffer({ iceRestart: force });
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

  const connectAll = useCallback(
    (force = false) => {
      if (!localRef.current) return;
      for (const m of membersRef.current) {
        if (m.id === youRef.current) continue;
        void offerTo(m.id, force);
      }
    },
    [offerTo],
  );

  const publish = useCallback(
    async (stream: MediaStream | null) => {
      localRef.current = stream;
      setLocalStream(stream);
      setCamOn(!!stream?.getVideoTracks().some((t) => t.enabled && t.readyState === "live"));
      setMicOn(!!stream?.getAudioTracks().some((t) => t.enabled && t.readyState === "live"));

      if (stream) {
        socket.emit("cam-ready");
        window.setTimeout(() => connectAll(true), 250);
        window.setTimeout(() => connectAll(true), 1500);
      } else {
        for (const pc of peersRef.current.values()) await syncSenders(pc, null);
      }
    },
    [connectAll, socket, syncSenders],
  );

  const startCamera = useCallback(async () => {
    setError("");
    try {
      const cam = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
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
    const t = window.setTimeout(() => connectAll(false), 400);
    return () => window.clearTimeout(t);
  }, [members, localStream, connectAll]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (!localRef.current) return;
      for (const m of membersRef.current) {
        if (m.id === youRef.current) continue;
        const pc = peersRef.current.get(m.id);
        if (shouldRenegotiate(pc, offerStartedRef.current.get(m.id))) {
          void offerTo(m.id, true);
        }
      }
    }, 6000);
    return () => window.clearInterval(id);
  }, [offerTo]);

  useEffect(() => {
    const onJoined = (member: Member) => {
      if (member.id === youId || !localRef.current) return;
      window.setTimeout(() => void offerTo(member.id, true), 400);
      window.setTimeout(() => void offerTo(member.id, true), 2000);
    };

    const onLeft = (id: string) => {
      peersRef.current.get(id)?.close();
      peersRef.current.delete(id);
      iceQueueRef.current.delete(id);
      offerStartedRef.current.delete(id);
      removeRemote(id);
    };

    const onReady = ({ from }: { from: string }) => {
      if (from === youId || !localRef.current) return;
      window.setTimeout(() => void offerTo(from, true), 300);
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

      if (!pc || isPcDead(pc)) {
        if (pc) pc.close();
        peersRef.current.delete(from);
        pc = ensurePeer(from);
      }

      try {
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
      const pc = peersRef.current.get(from) || ensurePeer(from);
      await addIce(pc, from, candidate, iceQueueRef.current);
    };

    socket.on("member-joined", onJoined);
    socket.on("member-left", onLeft);
    socket.on("cam-ready", onReady);
    socket.on("cam-offer", onOffer);
    socket.on("cam-answer", onAnswer);
    socket.on("cam-ice", onIce);

    return () => {
      socket.off("member-joined", onJoined);
      socket.off("member-left", onLeft);
      socket.off("cam-ready", onReady);
      socket.off("cam-offer", onOffer);
      socket.off("cam-answer", onAnswer);
      socket.off("cam-ice", onIce);
    };
  }, [ensurePeer, offerTo, removeRemote, socket, syncSenders, youId]);

  useEffect(() => {
    return () => {
      for (const pc of peersRef.current.values()) pc.close();
      peersRef.current.clear();
      localRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

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
