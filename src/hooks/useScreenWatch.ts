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

type Options = {
  socket: Socket;
  youId: string;
  members: Member[];
  screenSharerId: string | null;
  active: boolean;
};

async function tuneOutgoing(pc: RTCPeerConnection) {
  for (const sender of pc.getSenders()) {
    if (!sender.track) continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];

    if (sender.track.kind === "video") {
      params.encodings[0].maxBitrate = 4_000_000;
      params.encodings[0].maxFramerate = 30;
      params.encodings[0].scaleResolutionDownBy = 1;
      params.degradationPreference = "maintain-framerate";
    } else if (sender.track.kind === "audio") {
      params.encodings[0].maxBitrate = 192_000;
    }

    try {
      await sender.setParameters(params);
    } catch {
      /* ignore */
    }
  }
}

async function prepareScreenStream(screen: MediaStream) {
  const video = screen.getVideoTracks()[0];
  const audio = screen.getAudioTracks()[0];
  if (video) {
    video.contentHint = "motion";
    try {
      await video.applyConstraints({
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 30, max: 30 },
      });
    } catch {
      /* keep capture defaults */
    }
  }
  if (audio) audio.contentHint = "music";
  return screen;
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
  const offerStartedRef = useRef<Map<string, number>>(new Map());
  const makingOfferRef = useRef<Set<string>>(new Set());
  const screenRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const iceQueueRef = useRef<IceQueue>(new Map());
  const membersRef = useRef(members);
  const sharerRef = useRef(screenSharerId);
  const youRef = useRef(youId);
  const offerToRef = useRef<(peerId: string, force?: boolean) => Promise<void>>(async () => {});

  useEffect(() => {
    membersRef.current = members;
  }, [members]);
  useEffect(() => {
    sharerRef.current = screenSharerId;
  }, [screenSharerId]);
  useEffect(() => {
    youRef.current = youId;
  }, [youId]);

  const closePeer = useCallback((id: string) => {
    peersRef.current.get(id)?.close();
    peersRef.current.delete(id);
    iceQueueRef.current.delete(id);
    makingOfferRef.current.delete(id);
    offerStartedRef.current.delete(id);
  }, []);

  const closeAll = useCallback(() => {
    for (const id of [...peersRef.current.keys()]) closePeer(id);
  }, [closePeer]);

  const ensurePeer = useCallback(
    (peerId: string, asSharer: boolean) => {
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
        const merged = remoteStreamRef.current ?? new MediaStream();
        for (const t of inbound.getTracks()) {
          if (!merged.getTrackById(t.id)) merged.addTrack(t);
        }
        if (!merged.getTrackById(ev.track.id)) merged.addTrack(ev.track);
        const next = new MediaStream(merged.getTracks());
        remoteStreamRef.current = next;
        setRemoteScreen(next);
        setLinkState("Screen connected");
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === "connecting") setLinkState("Connecting screen…");
        if (state === "connected") {
          setLinkState("Screen connected");
          offerStartedRef.current.set(peerId, Date.now());
        }
        if (state === "failed" || state === "disconnected") {
          setLinkState("Screen reconnecting…");
          closePeer(peerId);
          window.setTimeout(() => {
            if (sharerRef.current === youRef.current && screenRef.current) {
              void offerToRef.current(peerId, true);
            } else if (sharerRef.current && sharerRef.current !== youRef.current) {
              socket.emit("request-screen");
            }
          }, 800);
        }
      };

      return pc;
    },
    [closePeer, socket],
  );

  const offerTo = useCallback(
    async (peerId: string, force = false) => {
      if (!screenRef.current || peerId === youRef.current) return;
      if (makingOfferRef.current.has(peerId)) return;

      let pc = peersRef.current.get(peerId);
      if (!force && pc?.connectionState === "connected") return;

      if (force || shouldRenegotiate(pc, offerStartedRef.current.get(peerId))) {
        if (pc) closePeer(peerId);
        pc = ensurePeer(peerId, true);
      } else if (!pc) {
        pc = ensurePeer(peerId, true);
      } else if (pc.signalingState !== "stable") {
        return;
      } else {
        for (const track of screenRef.current.getTracks()) {
          if (!pc.getSenders().some((s) => s.track?.id === track.id)) {
            pc.addTrack(track, screenRef.current);
          }
        }
      }

      makingOfferRef.current.add(peerId);
      offerStartedRef.current.set(peerId, Date.now());
      try {
        await tuneOutgoing(pc);
        const offer = await pc.createOffer({ iceRestart: force });
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

  const pushToEveryone = useCallback(
    (force = false) => {
      if (sharerRef.current !== youRef.current || !screenRef.current) return;
      for (const m of membersRef.current) {
        if (m.id === youRef.current) continue;
        void offerTo(m.id, force);
      }
    },
    [offerTo],
  );

  const startShare = useCallback(async () => {
    setError("");
    setLinkState("Starting share…");
    try {
      let screen: MediaStream;
      try {
        screen = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: { ideal: 30, max: 30 },
            width: { ideal: 1920, max: 1920 },
            height: { ideal: 1080, max: 1080 },
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

      await prepareScreenStream(screen);
      if (!screen.getAudioTracks().length) {
        setError("Enable “Share tab audio” in the browser dialog for sound.");
      }

      screenRef.current?.getTracks().forEach((t) => t.stop());
      screenRef.current = screen;
      setLocalScreen(screen);
      setRemoteScreen(null);
      remoteStreamRef.current = null;
      closeAll();
      socket.emit("start-screen");

      window.setTimeout(() => pushToEveryone(true), 300);
      window.setTimeout(() => pushToEveryone(true), 1500);
      window.setTimeout(() => pushToEveryone(false), 4000);

      screen.getVideoTracks()[0].onended = () => {
        screenRef.current = null;
        setLocalScreen(null);
        closeAll();
        socket.emit("stop-screen");
        setLinkState("");
      };
    } catch {
      setError("Screen share cancelled or unavailable.");
      setLinkState("");
    }
  }, [closeAll, pushToEveryone, socket]);

  const stopShare = useCallback(() => {
    screenRef.current?.getTracks().forEach((t) => t.stop());
    screenRef.current = null;
    setLocalScreen(null);
    closeAll();
    socket.emit("stop-screen");
    setLinkState("");
  }, [closeAll, socket]);

  useEffect(() => {
    if (!active || screenSharerId !== youId || !screenRef.current) return;
    pushToEveryone(false);
  }, [active, members, screenSharerId, youId, pushToEveryone]);

  useEffect(() => {
    if (!active || !screenSharerId || screenSharerId === youId) return;
    if (remoteScreen?.getVideoTracks().some((t) => t.readyState === "live")) return;

    setLinkState("Waiting for screen…");
    const ping = () => socket.emit("request-screen");
    ping();
    const timers = [800, 2000, 4000, 7000, 11000].map((ms) => window.setTimeout(ping, ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [active, screenSharerId, youId, remoteScreen, socket, members.length]);

  // Watchdog: if stuck connecting, force renegotiate.
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      if (sharerRef.current === youRef.current && screenRef.current) {
        for (const m of membersRef.current) {
          if (m.id === youRef.current) continue;
          const pc = peersRef.current.get(m.id);
          if (shouldRenegotiate(pc, offerStartedRef.current.get(m.id))) {
            void offerTo(m.id, true);
          }
        }
      } else if (
        sharerRef.current &&
        sharerRef.current !== youRef.current &&
        !remoteStreamRef.current?.getVideoTracks().length
      ) {
        socket.emit("request-screen");
      }
    }, 5000);
    return () => window.clearInterval(id);
  }, [active, offerTo, socket]);

  useEffect(() => {
    if (!active && screenSharerId !== youId) {
      setRemoteScreen(null);
      remoteStreamRef.current = null;
      closeAll();
      setLinkState("");
    }
  }, [active, screenSharerId, youId, closeAll]);

  useEffect(() => {
    const onJoined = (member: Member) => {
      if (member.id === youId) return;
      if (sharerRef.current === youId && screenRef.current) {
        window.setTimeout(() => void offerTo(member.id, true), 400);
        window.setTimeout(() => void offerTo(member.id, true), 2000);
      }
    };

    const onLeft = (id: string) => {
      closePeer(id);
      if (sharerRef.current === id) {
        setRemoteScreen(null);
        remoteStreamRef.current = null;
        setLinkState("");
      }
    };

    const onRequest = ({ from }: { from: string }) => {
      if (sharerRef.current !== youId || !screenRef.current) return;
      void offerTo(from, true);
    };

    const onOffer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      if (from === youId) return;
      sharerRef.current = from;

      closePeer(from);
      const pc = ensurePeer(from, false);
      try {
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
        void offerTo(from, true);
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
        pc = ensurePeer(from, sharerRef.current === youId && !!screenRef.current);
      }
      await addIce(pc, from, candidate, iceQueueRef.current);
    };

    socket.on("member-joined", onJoined);
    socket.on("member-left", onLeft);
    socket.on("request-screen", onRequest);
    socket.on("webrtc-offer", onOffer);
    socket.on("webrtc-answer", onAnswer);
    socket.on("webrtc-ice", onIce);

    return () => {
      socket.off("member-joined", onJoined);
      socket.off("member-left", onLeft);
      socket.off("request-screen", onRequest);
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
