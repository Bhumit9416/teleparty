import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { Member } from "../types";
import { ICE, addIce, flushIce, type IceQueue } from "../lib/rtc";

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
      params.encodings[0].maxBitrate = 2_000_000;
      params.encodings[0].maxFramerate = 24;
      params.degradationPreference = "maintain-framerate";
    } else if (sender.track.kind === "audio") {
      params.encodings[0].maxBitrate = 160_000;
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
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 24, max: 24 },
      });
    } catch {
      try {
        await video.applyConstraints({ frameRate: { max: 24 } });
      } catch {
        /* keep defaults */
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

  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
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
  }, []);

  const closeAll = useCallback(() => {
    for (const id of [...peersRef.current.keys()]) closePeer(id);
  }, [closePeer]);

  const ensurePeer = useCallback(
    (peerId: string, asSharer: boolean) => {
      let pc = peersRef.current.get(peerId);
      if (pc && pc.connectionState !== "failed" && pc.connectionState !== "closed") {
        return pc;
      }
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
        if (youRef.current && sharerRef.current === youRef.current) return;

        let stream = ev.streams[0];
        if (!stream) {
          stream = remoteStreamRef.current ?? new MediaStream();
          if (!stream.getTrackById(ev.track.id)) stream.addTrack(ev.track);
        } else {
          // Merge later tracks into the same stream identity for React.
          if (remoteStreamRef.current && remoteStreamRef.current !== stream) {
            for (const t of stream.getTracks()) {
              if (!remoteStreamRef.current.getTrackById(t.id)) {
                remoteStreamRef.current.addTrack(t);
              }
            }
            stream = remoteStreamRef.current;
          }
        }
        remoteStreamRef.current = stream;
        setRemoteScreen(stream);
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          closePeer(peerId);
        }
      };

      return pc;
    },
    [closePeer, socket],
  );

  const offerTo = useCallback(
    async (peerId: string) => {
      if (!screenRef.current) return;

      // Always rebuild offer path for that peer so late joiners get media.
      closePeer(peerId);
      const pc = ensurePeer(peerId, true);
      await tuneOutgoing(pc);

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("webrtc-offer", { to: peerId, sdp: pc.localDescription || offer });
      } catch {
        /* ignore glare */
      }
    },
    [closePeer, ensurePeer, socket],
  );

  const broadcastScreen = useCallback(async () => {
    for (const m of membersRef.current) {
      if (m.id === youRef.current) continue;
      await offerTo(m.id);
    }
  }, [offerTo]);

  const startShare = useCallback(async () => {
    setError("");
    try {
      let screen: MediaStream;
      try {
        screen = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: { ideal: 24, max: 24 },
            width: { ideal: 1280, max: 1280 },
            height: { ideal: 720, max: 720 },
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
              frameRate: { ideal: 24, max: 24 },
              width: { ideal: 1280, max: 1280 },
              height: { ideal: 720, max: 720 },
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
      // Give viewers a moment to apply playback mode before offers arrive.
      window.setTimeout(() => {
        void broadcastScreen();
      }, 250);

      screen.getVideoTracks()[0].onended = () => {
        screenRef.current = null;
        setLocalScreen(null);
        closeAll();
        socket.emit("stop-screen");
      };
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

  // Sharer: push to everyone when member list changes.
  useEffect(() => {
    if (!active || screenSharerId !== youId) return;
    if (!screenRef.current) return;
    void broadcastScreen();
  }, [active, members, screenSharerId, youId, broadcastScreen]);

  // Viewer: ask sharer for a fresh offer if we joined mid-share / missed the first offer.
  useEffect(() => {
    if (!active || !screenSharerId || screenSharerId === youId) return;
    if (remoteScreen) return;

    socket.emit("request-screen");
    const t1 = window.setTimeout(() => socket.emit("request-screen"), 800);
    const t2 = window.setTimeout(() => socket.emit("request-screen"), 2000);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [active, screenSharerId, youId, remoteScreen, socket, members.length]);

  useEffect(() => {
    if (!active) {
      if (screenSharerId !== youId) {
        setRemoteScreen(null);
        remoteStreamRef.current = null;
        closeAll();
      }
    }
  }, [active, screenSharerId, youId, closeAll]);

  useEffect(() => {
    const onJoined = (member: Member) => {
      if (member.id === youId) return;
      if (sharerRef.current === youId && screenRef.current) {
        window.setTimeout(() => void offerTo(member.id), 300);
      }
    };

    const onLeft = (id: string) => {
      closePeer(id);
      if (sharerRef.current === id) {
        setRemoteScreen(null);
        remoteStreamRef.current = null;
      }
    };

    const onRequest = ({ from }: { from: string }) => {
      if (sharerRef.current !== youId || !screenRef.current) return;
      void offerTo(from);
    };

    const onOffer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      // Don't drop offers if playback state is slightly late — treat sender as sharer.
      if (from === youId) return;
      sharerRef.current = from;

      closePeer(from);
      const pc = ensurePeer(from, false);
      await pc.setRemoteDescription(sdp);
      await flushIce(pc, from, iceQueueRef.current);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("webrtc-answer", { to: from, sdp: pc.localDescription || answer });
    };

    const onAnswer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      const pc = peersRef.current.get(from);
      if (!pc) return;
      if (pc.signalingState !== "have-local-offer") return;
      await pc.setRemoteDescription(sdp);
      await flushIce(pc, from, iceQueueRef.current);
      await tuneOutgoing(pc);
    };

    const onIce = async ({
      from,
      candidate,
    }: {
      from: string;
      candidate: RTCIceCandidateInit;
    }) => {
      const pc =
        peersRef.current.get(from) ||
        ensurePeer(from, sharerRef.current === youId && !!screenRef.current);
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
    error,
    startShare,
    stopShare,
  };
}
