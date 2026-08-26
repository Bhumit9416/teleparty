import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { Member } from "../types";

const ICE: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

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
  const localRef = useRef<MediaStream | null>(null);
  const membersRef = useRef(members);

  useEffect(() => {
    membersRef.current = members;
  }, [members]);

  const upsertRemote = useCallback((id: string, stream: MediaStream) => {
    const member = membersRef.current.find((m) => m.id === id);
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
    setRemotes((list) => list.filter((r) => r.id !== id));
  }, []);

  const syncSenders = useCallback(async (pc: RTCPeerConnection, stream: MediaStream | null) => {
    for (const kind of ["audio", "video"] as const) {
      const track = stream?.getTracks().find((t) => t.kind === kind) || null;
      const sender = pc.getSenders().find((s) => s.track?.kind === kind);
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
      if (pc) return pc;

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
        upsertRemote(peerId, ev.streams[0] || new MediaStream([ev.track]));
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          pc.close();
          peersRef.current.delete(peerId);
          removeRemote(peerId);
        }
      };

      return pc;
    },
    [removeRemote, socket, upsertRemote],
  );

  const offerTo = useCallback(
    async (peerId: string) => {
      const pc = ensurePeer(peerId);
      if (localRef.current) await syncSenders(pc, localRef.current);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("cam-offer", { to: peerId, sdp: offer });
    },
    [ensurePeer, socket, syncSenders],
  );

  const publish = useCallback(
    async (stream: MediaStream | null) => {
      localRef.current = stream;
      setLocalStream(stream);
      setCamOn(!!stream?.getVideoTracks().some((t) => t.enabled && t.readyState === "live"));
      setMicOn(!!stream?.getAudioTracks().some((t) => t.enabled && t.readyState === "live"));

      for (const m of membersRef.current) {
        if (m.id === youId) continue;
        if (!peersRef.current.has(m.id)) {
          if (stream) await offerTo(m.id);
          continue;
        }
        const pc = peersRef.current.get(m.id)!;
        await syncSenders(pc, stream);
        if (stream && pc.signalingState === "stable") {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit("cam-offer", { to: m.id, sdp: offer });
          } catch {
            /* ignore */
          }
        }
      }
    },
    [offerTo, socket, syncSenders, youId],
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
    const onJoined = (member: Member) => {
      if (member.id === youId) return;
      if (localRef.current) void offerTo(member.id);
    };

    const onLeft = (id: string) => {
      peersRef.current.get(id)?.close();
      peersRef.current.delete(id);
      removeRemote(id);
    };

    const onOffer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      const pc = ensurePeer(from);
      const polite = youId > from;
      if (pc.signalingState !== "stable") {
        if (!polite) return;
        await pc.setLocalDescription({ type: "rollback" });
      }
      await pc.setRemoteDescription(sdp);
      if (localRef.current) await syncSenders(pc, localRef.current);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("cam-answer", { to: from, sdp: answer });
    };

    const onAnswer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      const pc = peersRef.current.get(from) || ensurePeer(from);
      if (pc.signalingState === "have-local-offer") {
        await pc.setRemoteDescription(sdp);
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
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        /* ignore */
      }
    };

    socket.on("member-joined", onJoined);
    socket.on("member-left", onLeft);
    socket.on("cam-offer", onOffer);
    socket.on("cam-answer", onAnswer);
    socket.on("cam-ice", onIce);

    return () => {
      socket.off("member-joined", onJoined);
      socket.off("member-left", onLeft);
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
