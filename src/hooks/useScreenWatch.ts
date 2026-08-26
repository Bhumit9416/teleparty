import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { Member } from "../types";

const ICE: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

type Options = {
  socket: Socket;
  youId: string;
  members: Member[];
  screenSharerId: string | null;
  active: boolean;
};

/** Pushes one person's screen into the main watch stage for everyone else. */
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

  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const screenRef = useRef<MediaStream | null>(null);
  const membersRef = useRef(members);
  const sharerRef = useRef(screenSharerId);

  useEffect(() => {
    membersRef.current = members;
  }, [members]);

  useEffect(() => {
    sharerRef.current = screenSharerId;
  }, [screenSharerId]);

  const closePeer = useCallback((id: string) => {
    peersRef.current.get(id)?.close();
    peersRef.current.delete(id);
  }, []);

  const closeAll = useCallback(() => {
    for (const id of peersRef.current.keys()) closePeer(id);
  }, [closePeer]);

  const ensurePeer = useCallback(
    (peerId: string, asSharer: boolean) => {
      let pc = peersRef.current.get(peerId);
      if (pc) return pc;

      pc = new RTCPeerConnection(ICE);
      peersRef.current.set(peerId, pc);

      if (asSharer && screenRef.current) {
        for (const track of screenRef.current.getTracks()) {
          pc.addTrack(track, screenRef.current);
        }
      }

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          socket.emit("webrtc-ice", { to: peerId, candidate: ev.candidate.toJSON() });
        }
      };

      pc.ontrack = (ev) => {
        if (sharerRef.current && sharerRef.current !== youId) {
          setRemoteScreen(ev.streams[0] || new MediaStream([ev.track]));
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          closePeer(peerId);
        }
      };

      return pc;
    },
    [closePeer, socket, youId],
  );

  const offerTo = useCallback(
    async (peerId: string) => {
      const pc = ensurePeer(peerId, true);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("webrtc-offer", { to: peerId, sdp: offer });
    },
    [ensurePeer, socket],
  );

  const broadcastScreen = useCallback(async () => {
    for (const m of membersRef.current) {
      if (m.id === youId) continue;
      await offerTo(m.id);
    }
  }, [offerTo, youId]);

  const startShare = useCallback(async () => {
    setError("");
    try {
      let screen: MediaStream;
      try {
        screen = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30 },
          audio: true,
        });
      } catch {
        screen = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        });
      }
      screenRef.current?.getTracks().forEach((t) => t.stop());
      screenRef.current = screen;
      setLocalScreen(screen);
      setRemoteScreen(null);
      socket.emit("start-screen");
      await broadcastScreen();

      const end = () => {
        screenRef.current = null;
        setLocalScreen(null);
        closeAll();
        socket.emit("stop-screen");
      };

      screen.getVideoTracks()[0].onended = end;
    } catch {
      setError("Screen share cancelled or unavailable.");
    }
  }, [broadcastScreen, closeAll, socket]);

  const stopShare = useCallback(() => {
    screenRef.current?.getTracks().forEach((t) => t.stop());
    screenRef.current = null;
    setLocalScreen(null);
    closeAll();
    socket.emit("stop-screen");
  }, [closeAll, socket]);

  useEffect(() => {
    if (!active || screenSharerId !== youId) return;
    if (!screenRef.current) return;
    void broadcastScreen();
  }, [active, members, screenSharerId, youId, broadcastScreen]);

  useEffect(() => {
    if (!active || !screenSharerId || screenSharerId === youId) {
      if (screenSharerId !== youId) setRemoteScreen(null);
      if (!active && screenSharerId !== youId) {
        closeAll();
        setRemoteScreen(null);
      }
    }
  }, [active, screenSharerId, youId, closeAll]);

  useEffect(() => {
    const onJoined = (member: Member) => {
      if (member.id === youId) return;
      if (sharerRef.current === youId && screenRef.current) {
        void offerTo(member.id);
      }
    };

    const onLeft = (id: string) => {
      closePeer(id);
      if (sharerRef.current === id) setRemoteScreen(null);
    };

    const onOffer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      if (sharerRef.current !== from) return;
      const pc = ensurePeer(from, false);
      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("webrtc-answer", { to: from, sdp: answer });
    };

    const onAnswer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      const pc = peersRef.current.get(from);
      if (!pc || pc.signalingState !== "have-local-offer") return;
      await pc.setRemoteDescription(sdp);
    };

    const onIce = async ({
      from,
      candidate,
    }: {
      from: string;
      candidate: RTCIceCandidateInit;
    }) => {
      const pc = peersRef.current.get(from) || ensurePeer(from, sharerRef.current === youId);
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        /* ignore */
      }
    };

    socket.on("member-joined", onJoined);
    socket.on("member-left", onLeft);
    socket.on("webrtc-offer", onOffer);
    socket.on("webrtc-answer", onAnswer);
    socket.on("webrtc-ice", onIce);

    return () => {
      socket.off("member-joined", onJoined);
      socket.off("member-left", onLeft);
      socket.off("webrtc-offer", onOffer);
      socket.off("webrtc-answer", onAnswer);
      socket.off("webrtc-ice", onIce);
    };
  }, [closePeer, ensurePeer, offerTo, socket, youId]);

  useEffect(() => {
    return () => {
      screenRef.current?.getTracks().forEach((t) => t.stop());
      closeAll();
    };
  }, [closeAll]);

  const stageStream =
    screenSharerId === youId ? localScreen : screenSharerId ? remoteScreen : null;

  return {
    stageStream,
    isSharing: screenSharerId === youId && !!localScreen,
    error,
    startShare,
    stopShare,
  };
}
