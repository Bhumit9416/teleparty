export type IceQueue = Map<string, RTCIceCandidateInit[]>;

const FALLBACK_ICE: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
  iceCandidatePoolSize: 4,
  iceTransportPolicy: "all",
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require",
};

let iceConfig: RTCConfiguration = { ...FALLBACK_ICE };
let iceReady: Promise<RTCConfiguration> | null = null;
let hasTurnRelay = false;

export function getIce(): RTCConfiguration {
  return iceConfig;
}

export function iceHasTurn(): boolean {
  return hasTurnRelay;
}

/** Load STUN/TURN from the signaling server (supports Metered / env TURN). */
export function ensureIce(baseUrl = ""): Promise<RTCConfiguration> {
  if (iceReady) return iceReady;

  iceReady = (async () => {
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/ice`);
      if (!res.ok) return iceConfig;
      const data = (await res.json()) as {
        iceServers?: RTCIceServer[];
        hasTurn?: boolean;
      };
      if (data.iceServers?.length) {
        iceConfig = {
          ...FALLBACK_ICE,
          iceServers: data.iceServers,
        };
      }
      hasTurnRelay = !!data.hasTurn;
    } catch {
      /* keep STUN-only fallback */
    }
    return iceConfig;
  })();

  return iceReady;
}

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
  // null = end-of-candidates
  if (!pc.remoteDescription) {
    const list = queue.get(peerId) || [];
    list.push(candidate ?? { candidate: "" });
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

/** True if we should tear down and renegotiate (stuck connecting / failed). */
export function shouldRenegotiate(pc: RTCPeerConnection | undefined, startedAt?: number) {
  if (!pc) return true;
  if (isPcDead(pc)) return true;
  if (pc.connectionState === "connecting" && startedAt && Date.now() - startedAt > 12000) {
    return true;
  }
  if (pc.iceConnectionState === "checking" && startedAt && Date.now() - startedAt > 12000) {
    return true;
  }
  return false;
}
