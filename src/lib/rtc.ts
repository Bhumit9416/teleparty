export const ICE: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    // Public TURN relays (required when users are on different networks)
    {
      urls: "turn:numb.viagenie.ca",
      username: "webrtc@live.com",
      credential: "muazkh",
    },
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp",
        "turns:openrelay.metered.ca:443?transport=tcp",
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
  iceCandidatePoolSize: 4,
  iceTransportPolicy: "all",
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require",
};

export type IceQueue = Map<string, RTCIceCandidateInit[]>;

export async function flushIce(
  pc: RTCPeerConnection,
  peerId: string,
  queue: IceQueue,
) {
  const pending = queue.get(peerId) || [];
  queue.set(peerId, []);
  for (const candidate of pending) {
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      /* ignore */
    }
  }
}

export async function addIce(
  pc: RTCPeerConnection,
  peerId: string,
  candidate: RTCIceCandidateInit | null,
  queue: IceQueue,
) {
  if (!candidate) return;
  if (!pc.remoteDescription) {
    const list = queue.get(peerId) || [];
    list.push(candidate);
    queue.set(peerId, list);
    return;
  }
  try {
    await pc.addIceCandidate(candidate);
  } catch {
    /* ignore */
  }
}

export function isPcDead(pc: RTCPeerConnection | undefined) {
  if (!pc) return true;
  return (
    pc.connectionState === "failed" ||
    pc.connectionState === "closed" ||
    pc.iceConnectionState === "failed" ||
    pc.iceConnectionState === "closed"
  );
}

/** True if we should tear down and renegotiate (stuck connecting / disconnected). */
export function shouldRenegotiate(pc: RTCPeerConnection | undefined, startedAt?: number) {
  if (!pc) return true;
  if (isPcDead(pc)) return true;
  if (pc.connectionState === "disconnected") return true;
  if (pc.connectionState === "connecting" && startedAt && Date.now() - startedAt > 10000) {
    return true;
  }
  return false;
}
