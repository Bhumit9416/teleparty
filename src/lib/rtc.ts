export const ICE: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
  iceCandidatePoolSize: 8,
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
      /* ignore bad/early candidates */
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
