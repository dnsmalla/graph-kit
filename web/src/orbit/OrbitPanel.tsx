// React wrapper for OrbitView. The three.js view is created in an effect, so
// server rendering never touches window, document or WebGL.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type {
  OrbitLayout,
  SystemGraph,
  SystemRingItem,
  Vec3,
} from "../../../typescript/src/system/index.js";
import { OrbitView, type OrbitPick, type OrbitTheme } from "./OrbitView";

export interface OrbitPanelProps {
  /** The project's core. Compared by identity: pass a new object only when the project changes. */
  core: { graph: SystemGraph; layout: OrbitLayout } | null;
  /** The recent-activity ring. Compared by identity: pass a new object only when the ring changes. */
  ring: { items: SystemRingItem[]; positions: Map<string, Vec3> } | null;
  onSelect?: (item: OrbitPick) => void;
  /** Called once when WebGL is unavailable (the view then shows only its text fallback). */
  onFallback?: () => void;
  /** Show the "No project graph yet" text when there is no core. Default true. */
  showEmpty?: boolean;
}

const EMPTY_GRAPH: SystemGraph = {
  core: [],
  edges: [],
  ring: [],
  truncated: { totalNodes: 0, keptNodes: 0, keptCommunities: 0 },
};
const EMPTY_LAYOUT: OrbitLayout = {
  core: new Map(),
  ring: new Map(),
  communityCenters: [],
  bounds: { radius: 0 },
};
const EMPTY_POSITIONS: Map<string, Vec3> = new Map();
const NO_RING: SystemRingItem[] = [];

const TOOLTIP_OFFSET_PX = 14;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
/** The host needs a definite height: the WebGL canvas is absolutely positioned inside it. */
const HOST_MIN_HEIGHT_PX = 360;

function reducedMotionQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

function prefersReducedMotion(): boolean {
  return reducedMotionQuery()?.matches ?? false;
}

/** Light only for data-theme="light"; "dark", "midnight" and unset are dark. */
function readTheme(): OrbitTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * Renders the OrbitView. The core and the ring are separate inputs with separate
 * effects: a ring change updates only the ring, and the core (with the camera and
 * the hover) is rebuilt only when `core` changes. Both are compared by identity, so
 * callers must memoise them.
 */
export function OrbitPanel({ core, ring, onSelect, onFallback, showEmpty = true }: OrbitPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<OrbitView | null>(null);
  const selectRef = useRef(onSelect);
  const fallbackRef = useRef(onFallback);
  const [pick, setPick] = useState<OrbitPick | null>(null);

  const hasCore = !!core && core.graph.core.length > 0;

  useEffect(() => {
    selectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    fallbackRef.current = onFallback;
  }, [onFallback]);

  // Create the view once per mount; follow the reduced-motion and theme settings
  // while mounted; dispose and detach every listener on unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new OrbitView(host, {
      reducedMotion: prefersReducedMotion(),
      theme: readTheme(),
      onHover: (item) => setPick(item),
      onSelect: (item) => selectRef.current?.(item),
      onFallback: () => fallbackRef.current?.(),
    });
    viewRef.current = view;

    const motionQuery = reducedMotionQuery();
    const onMotionChange = (e: MediaQueryListEvent) => view.setReducedMotion(e.matches);
    motionQuery?.addEventListener("change", onMotionChange);

    let themeObserver: MutationObserver | null = null;
    if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
      themeObserver = new MutationObserver(() => view.setTheme(readTheme()));
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    }

    return () => {
      themeObserver?.disconnect();
      motionQuery?.removeEventListener("change", onMotionChange);
      view.dispose();
      viewRef.current = null;
    };
  }, []);

  // Core: a new project clears the hover (the picked node may be gone) and rebuilds the core.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    setPick(null);
    if (core && core.graph.core.length > 0) view.setGraph(core.graph, core.layout);
    else view.setGraph(EMPTY_GRAPH, EMPTY_LAYOUT);
  }, [core]);

  // Ring: only the ring points change; the hover and the camera stay as they are.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.setRing(ring ? ring.items : NO_RING, ring ? ring.positions : EMPTY_POSITIONS);
  }, [ring]);

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const tip = tipRef.current;
    if (!tip) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    // Keep the tooltip inside the panel: flip to the left / up near the right / bottom edges.
    let x = px + TOOLTIP_OFFSET_PX;
    if (x + tip.offsetWidth > rect.width) x = px - TOOLTIP_OFFSET_PX - tip.offsetWidth;
    let y = py + TOOLTIP_OFFSET_PX;
    if (y + tip.offsetHeight > rect.height) y = py - TOOLTIP_OFFSET_PX - tip.offsetHeight;
    tip.style.transform = `translate(${Math.max(0, x)}px, ${Math.max(0, y)}px)`;
  };

  return (
    <div
      className="orbit-panel"
      style={{ position: "relative", width: "100%", height: "100%", minHeight: 240, overflow: "hidden" }}
      onPointerMove={onMove}
      onPointerLeave={() => setPick(null)}
    >
      <div ref={hostRef} className="orbit-host" style={{ width: "100%", height: "100%", minHeight: HOST_MIN_HEIGHT_PX }} />
      {!hasCore && showEmpty && (
        <div
          className="orbit-empty"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            opacity: 0.7,
          }}
        >
          No project graph yet
        </div>
      )}
      <div
        ref={tipRef}
        className="orbit-tooltip"
        role="tooltip"
        hidden={!pick}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          pointerEvents: "none",
          display: pick ? "flex" : "none",
          flexDirection: "column",
          maxWidth: 280,
          padding: "6px 8px",
          borderRadius: 6,
          background: "rgba(10, 12, 18, 0.85)",
          color: "#f2f4f8",
          fontSize: 12,
          lineHeight: 1.35,
        }}
      >
        <strong style={{ fontWeight: 600 }}>{pick?.label}</strong>
        <span style={{ opacity: 0.7 }}>{pick?.detail}</span>
      </div>
    </div>
  );
}
