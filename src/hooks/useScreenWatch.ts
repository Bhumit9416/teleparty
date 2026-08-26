import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { Member } from "../types";
import { ICE, addIce, flushIce, isPcDead, type IceQueue } from "../lib/rtc";

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
      params.encodings[0].maxBitrate = 5_500_000;
      params.encodings[0].maxFramerate = 30;
      params.encodings[0].scaleResolutionDownBy = 1;
      params.degradationPreference = "maintain-resolution";
    } else if (sender.track.kind === "audio") {
      params.encodings[0].maxBitrate = 256_000;
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
      try {
        await video.applyConstraints({
          width: { ideal: 1600, max: 1920 },
          height: { ideal: 900, max: 1080 },
          frameRate: { ideal: 30, max: 30 },
        });
      } catch {
        /* keep capture defaults */
      }
    }
  }

  if (audio) audio.contentHint = "music";
  return screen;
}

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
  const [linkState, setLinkState] = useState("");

  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const makingOfferRef = useRef<Set<string>>(new Set());
  const screenRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const iceQueueRef = useRef<IceQueue>(new Map());
  const membersRef = useRef(members);
  const sharerRef = useRef(screenSharerId);
  const youRef = useRef(youId);

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
  }, []);

  const closeAll = useCallback(() => {
    for (const id of [...peersRef.current.keys()]) closePeer(id);
  }, [closePeer]);

  const ensurePeer = useCallback(
    (peerId: string, asSharer: boolean) => {
      let pc = peersRef.current.get(peerId);
      if (pc && !isPcDead(pc)) return pc;
      if (pc) {
        pc.close();
        peersRef.current.delete(peerId);
      }

      pc = new RTCPeerConnection(ICE);
      peersRef.current.set(peerId, pc);

      if (asSharer && screenRef.current) {
        for (const track of screenRef.current.getTracks()) {
          pc.addTrack(track, screenRef.current);
        }
        void tuneOutgoing(pc);
      }

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          socket.emit("webrtc-ice", { to: peerId, candidate: ev.candidate.toJSON() });
        }
      };

      pc.ontrack = (ev) => {
        if (sharerRef.current === youRef.current) return;

        let stream = remoteStreamRef.current;
        if (!stream) {
          stream = ev.streams[0] ? ev.streams[0] : new MediaStream();
          remoteStreamRef.current = stream;
        }
        if (!stream.getTrackById(ev.track.id)) {
          stream.addTrack(ev.track);
        }
        // New MediaStream reference so React refreshes the <video>.
        const next = new MediaStream(stream.getTracks());
        remoteStreamRef.current = next;
        setRemoteScreen(next);
        setLinkState("Screen connected");
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === "connecting") setLinkState("Connecting screen…");
        if (state === "connected") setLinkState("Screen connected");
        if (state === "failed") {
          setLinkState("Screen connection failed — retrying…");
          closePeer(peerId);
          if (sharerRef.current === youRef.current && screenRef.current) {
            window.setTimeout(() => {
              void offerToRef.current(peerId);
            }, 600);
          } else if (sharerRef.current && sharerRef.current !== youRef.current) {
            socket.emit("request-screen");
          }
        }
        if (state === "closed") closePeer(peerId);
      };

      return pc;
    },
    [closePeer, socket],
  );

  const offerToRef = useRef<(peerId: string) => Promise<void>>(async () => {});

  const offerTo = useCallback(
    async (peerId: string) => {
      if (!screenRef.current || peerId === youRef.current) return;
      if (makingOfferRef.current.has(peerId)) return;

      let pc = peersRef.current.get(peerId);
      if (pc && (pc.connectionState === "connected" || pc.connectionState === "connecting")) {
        return;
      }
      if (pc && pc.signalingState !== "stable") return;

      if (isPcDead(pc)) {
        if (pc) closePeer(peerId);
        pc = ensurePeer(peerId, true);
      } else if (!pc) {
        pc = ensurePeer(peerId, true);
      } else {
        // Re-attach tracks if needed
        const senders = pc.getSenders();
        for (const track of screenRef.current.getTracks()) {
          const has = senders.some((s) => s.track?.id === track.id);
          if (!has) pc.addTrack(track, screenRef.current);
        }
      }

      makingOfferRef.current.add(peerId);
      try {
        await tuneOutgoing(pc);
        const offer = await pc.createOffer();
        if (pc.signalingState !== "stable") return;
        await pc.setLocalDescription(offer);
        socket.emit("webrtc-offer", { to: peerId, sdp: pc.localDescription });
        setLinkState("Sending screen…");
      } catch {
        /* ignore glare */
      } finally {
        makingOfferRef.current.delete(peerId);
      }
    },
    [closePeer, ensurePeer, socket],
  );

  useEffect(() => {
    offerToRef.current = offerTo;
  }, [offerTo]);

  const ensureOffersToMembers = useCallback(() => {
    if (sharerRef.current !== youRef.current || !screenRef.current) return;
    for (const m of membersRef.current) {
      if (m.id === youRef.current) continue;
      const pc = peersRef.current.get(m.id);
      if (!pc || isPcDead(pc)) void offerTo(m.id);
    }
  }, [offerTo]);

  const startShare = useCallback(async () => {
    setError("");
    setLinkState("");
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
            video: {
              frameRate: { ideal: 30, max: 30 },
              width: { ideal: 1920, max: 1920 },
              height: { ideal: 1080, max: 1080 },
            },
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
        setError(
          "No tab/system audio was shared. In the browser share dialog, enable “Share audio”.",
        );
      }

      screenRef.current?.getTracks().forEach((t) => t.stop());
      screenRef.current = screen;
      setLocalScreen(screen);
      setRemoteScreen(null);
      remoteStreamRef.current = null;
      closeAll();
      socket.emit("start-screen");

      window.setTimeout(() => ensureOffersToMembers(), 400);
      window.setTimeout(() => ensureOffersToMembers(), 1200);

      screen.getVideoTracks()[0].onended = () => {
        screenRef.current = null;
        setLocalScreen(null);
        closeAll();
        socket.emit("stop-screen");
        setLinkState("");
      };
    } catch {
      setError("Screen share cancelled or unavailable.");
    }
  }, [closeAll, ensureOffersToMembers, socket]);

  const stopShare = useCallback(() => {
    screenRef.current?.getTracks().forEach((t) => t.stop());
    screenRef.current = null;
    setLocalScreen(null);
    closeAll();
    socket.emit("stop-screen");
    setLinkState("");
  }, [closeAll, socket]);

  // Sharer: only offer to peers that aren't connected yet (don't tear down live links).
  useEffect(() => {
    if (!active || screenSharerId !== youId) return;
    if (!screenRef.current) return;
    ensureOffersToMembers();
  }, [active, members, screenSharerId, youId, ensureOffersToMembers]);

  // Viewer: keep requesting until we actually have remote tracks.
  useEffect(() => {
    if (!active || !screenSharerId || screenSharerId === youId) return;
    if (remoteScreen?.getVideoTracks().length) return;

    setLinkState("Waiting for screen…");
    socket.emit("request-screen");
    const timers = [600, 1500, 3000, 5000].map((ms) =>
      window.setTimeout(() => {
        if (!remoteStreamRef.current?.getVideoTracks().length) {
          socket.emit("request-screen");
        }
      }, ms),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [active, screenSharerId, youId, remoteScreen, socket, members.length]);

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
        window.setTimeout(() => void offerTo(member.id), 400);
        window.setTimeout(() => void offerTo(member.id), 1400);
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
      void offerTo(from);
    };

    const onOffer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      if (from === youId) return;
      sharerRef.current = from;

      let pc = peersRef.current.get(from);
      if (isPcDead(pc)) {
        if (pc) closePeer(from);
        pc = ensurePeer(from, false);
      } else if (!pc) {
        pc = ensurePeer(from, false);
      }

      try {
        if (pc.signalingState !== "stable" && pc.signalingState !== "have-remote-offer") {
          // Ignore glare while we aren't the sharer.
          if (pc.signalingState === "have-local-offer") return;
        }
        await pc.setRemoteDescription(sdp);
        await flushIce(pc, from, iceQueueRef.current);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("webrtc-answer", { to: from, sdp: pc.localDescription });
        setLinkState("Answering screen…");
      } catch {
        closePeer(from);
        socket.emit("request-screen");
      }
    };

    const onAnswer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      const pc = peersRef.current.get(from);
      if (!pc) return;
      if (pc.signalingState !== "have-local-offer") return;
      try {
        await pc.setRemoteDescription(sdp);
        await flushIce(pc, from, iceQueueRef.current);
        await tuneOutgoing(pc);
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

  return {
    stageStream,
    isSharing: screenSharerId === youId && !!localScreen,
    error: error || (linkState && !remoteScreen && screenSharerId && screenSharerId !== youId ? linkState : ""),
    status: linkState,
    startShare,
    stopShare,
  };
}
