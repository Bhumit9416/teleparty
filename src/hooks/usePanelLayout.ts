import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";

const SIDE_KEY = "teleparty-side-width";
const FACES_KEY = "teleparty-faces-ratio";

function readNumber(key: string, fallback: number) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

export function usePanelLayout(defaults = { sideWidth: 280, facesRatio: 0.42 }) {
  const [sideWidth, setSideWidth] = useState(() => readNumber(SIDE_KEY, defaults.sideWidth));
  const [facesRatio, setFacesRatio] = useState(() => readNumber(FACES_KEY, defaults.facesRatio));

  useEffect(() => {
    try {
      localStorage.setItem(SIDE_KEY, String(sideWidth));
      localStorage.setItem(FACES_KEY, String(facesRatio));
    } catch {
      /* ignore */
    }
  }, [sideWidth, facesRatio]);

  const startSideDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = sideWidth;

    const onMove = (ev: PointerEvent) => {
      const delta = startX - ev.clientX;
      const next = Math.min(560, Math.max(200, startWidth + delta));
      setSideWidth(next);
    };

    const onUp = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }, [sideWidth]);

  const startFacesDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const side = handle.closest(".room__side") as HTMLElement | null;
    if (!side) return;

    const onMove = (ev: PointerEvent) => {
      const rect = side.getBoundingClientRect();
      if (rect.height < 1) return;
      const ratio = (ev.clientY - rect.top) / rect.height;
      setFacesRatio(Math.min(0.75, Math.max(0.2, ratio)));
    };

    const onUp = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }, []);

  return { sideWidth, facesRatio, startSideDrag, startFacesDrag };
}
