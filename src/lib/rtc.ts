export const ICE: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    // Free public TURN (needed when you're on different Wi‑Fi / mobile data)
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:80?transport=tcp",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp",
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
  iceCandidatePoolSize: 10,
  iceTransportPolicy: "all",
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
  candidate: RTCIceCandidateInit,
  queue: IceQueue,
) {
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
