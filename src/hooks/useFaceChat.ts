import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { Member } from "../types";
import { ICE, addIce, flushIce, isPcDead, type IceQueue } from "../lib/rtc";

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

/** Mesh camera/mic so participants can see and talk to each other. */
export function useFaceChat({ socket, youId, members }: Options) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remotes, setRemotes] = useState<FacePeer[]>([]);
  const [camOn, setCamOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [error, setError] = useState("");

  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const makingOfferRef = useRef<Set<string>>(new Set());
  const ignoreOfferRef = useRef<Set<string>>(new Set());
  const localRef = useRef<MediaStream | null>(null);
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const iceQueueRef = useRef<IceQueue>(new Map());
  const membersRef = useRef(members);
  const youRef = useRef(youId);

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
      let sender = pc.getSenders().find((s) => s.track?.kind === kind);
      if (!sender && track && stream) {
        pc.addTrack(track, stream);
      } else if (sender) {
        await sender.replaceTrack(track);
      }
    }
  }, []);

  const ensurePeer = useCallback(
    (peerId: string) => {
      let pc = peersRef.current.get(peerId);
      if (pc && !isPcDead(pc)) return pc;
      if (pc) {
        pc.close();
        peersRef.current.delete(peerId);
      }

      pc = new RTCPeerConnection(ICE);
      peersRef.current.set(peerId, pc);

      if (localRef.current) {
        for (const track of localRef.current.getTracks()) {
          pc.addTrack(track, localRef.current);
        }
      }

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          socket.emit("cam-ice", { to: peerId, candidate: ev.candidate.toJSON() });
        }
      };

      pc.ontrack = (ev) => {
        let stream = remoteStreamsRef.current.get(peerId);
        if (!stream) {
          stream = ev.streams[0] ? new MediaStream(ev.streams[0].getTracks()) : new MediaStream();
        }
        if (!stream.getTrackById(ev.track.id)) stream.addTrack(ev.track);
        const next = new MediaStream(stream.getTracks());
        upsertRemote(peerId, next);
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          pc.close();
          peersRef.current.delete(peerId);
          removeRemote(peerId);
          if (localRef.current) {
            window.setTimeout(() => void offerToRef.current(peerId), 700);
          }
        }
      };

      return pc;
    },
    [removeRemote, socket, upsertRemote],
  );

  const offerToRef = useRef<(peerId: string) => Promise<void>>(async () => {});

  const offerTo = useCallback(
    async (peerId: string) => {
      if (peerId === youRef.current || !localRef.current) return;
      if (makingOfferRef.current.has(peerId)) return;

      // Perfect negotiation: only the "impolite" (lower id) side creates offers when both may.
      // If the other side has no connection yet, we still offer so they can see us.
      const pcExisting = peersRef.current.get(peerId);
      const mustOffer = !pcExisting || isPcDead(pcExisting);
      const impolite = youRef.current < peerId;
      if (!mustOffer && !impolite && pcExisting?.connectionState === "connected") return;

      const pc = ensurePeer(peerId);
      if (pc.signalingState !== "stable") return;

      makingOfferRef.current.add(peerId);
      try {
        await syncSenders(pc, localRef.current);
        const offer = await pc.createOffer();
        if (pc.signalingState !== "stable") return;
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

  const connectMissing = useCallback(() => {
    if (!localRef.current) return;
    for (const m of membersRef.current) {
      if (m.id === youRef.current) continue;
      const pc = peersRef.current.get(m.id);
      if (!pc || isPcDead(pc) || pc.connectionState === "disconnected") {
        void offerTo(m.id);
      }
    }
  }, [offerTo]);

  const publish = useCallback(
    async (stream: MediaStream | null) => {
      localRef.current = stream;
      setLocalStream(stream);
      setCamOn(!!stream?.getVideoTracks().some((t) => t.enabled && t.readyState === "live"));
      setMicOn(!!stream?.getAudioTracks().some((t) => t.enabled && t.readyState === "live"));

      if (stream) {
        socket.emit("cam-ready");
        window.setTimeout(() => connectMissing(), 300);
        window.setTimeout(() => connectMissing(), 1200);
      } else {
        for (const pc of peersRef.current.values()) {
          await syncSenders(pc, null);
        }
      }
    },
    [connectMissing, socket, syncSenders],
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
    if (!localRef.current) {
      await startCamera();
      return;
    }
    const tracks = localRef.current.getVideoTracks();
    if (!tracks.length) {
      await startCamera();
      return;
    }
    const next = !tracks.some((t) => t.enabled);
    tracks.forEach((t) => {
      t.enabled = next;
    });
    setCamOn(next);
  }, [startCamera]);

  useEffect(() => {
    if (!localStream) return;
    const t = window.setTimeout(() => connectMissing(), 400);
    return () => window.clearTimeout(t);
  }, [members, localStream, connectMissing]);

  useEffect(() => {
    const onJoined = (member: Member) => {
      if (member.id === youId) return;
      if (localRef.current) {
        window.setTimeout(() => void offerTo(member.id), 400);
        window.setTimeout(() => void offerTo(member.id), 1400);
      }
    };

    const onLeft = (id: string) => {
      peersRef.current.get(id)?.close();
      peersRef.current.delete(id);
      iceQueueRef.current.delete(id);
      makingOfferRef.current.delete(id);
      removeRemote(id);
    };

    const onReady = ({ from }: { from: string }) => {
      if (from === youId) return;
      if (localRef.current) {
        window.setTimeout(() => void offerTo(from), 300);
      }
    };

    const onOffer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      const pc = ensurePeer(from);
      const polite = youId > from;
      const offering = makingOfferRef.current.has(from) || pc.signalingState !== "stable";

      if (offering) {
        if (!polite) {
          ignoreOfferRef.current.add(from);
          return;
        }
        try {
          await pc.setLocalDescription({ type: "rollback" });
        } catch {
          /* ignore */
        }
      }

      try {
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
      candidate: RTCIceCandidateInit;
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
