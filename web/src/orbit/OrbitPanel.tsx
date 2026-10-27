// React wrapper for OrbitView. The three.js view is created in an effect, so
// server rendering never touches window, document or WebGL.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { OrbitLayout, SystemGraph } from "../../../typescript/src/system/index.js";
import { OrbitView, type OrbitPick, type OrbitTheme } from "./OrbitView";

export interface OrbitPanelProps {
  graph: SystemGraph | null;
  layout: OrbitLayout | null;
  onSelect?: (item: OrbitPick) => void;
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
 * Renders the OrbitView. `graph` and `layout` are compared by identity: every
 * new object rebuilds all GPU buffers and re-sorts the edges, so callers must
 * memoise them (useMemo / state) and only pass a new object when the data changes.
 */
export function OrbitPanel({ graph, layout, onSelect }: OrbitPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<OrbitView | null>(null);
  const selectRef = useRef(onSelect);
  const [pick, setPick] = useState<OrbitPick | null>(null);

  const hasCore = !!graph && graph.core.length > 0 && !!layout;

  useEffect(() => {
    selectRef.current = onSelect;
  }, [onSelect]);

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

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    setPick(null);
    if (graph && layout && graph.core.length > 0) view.setGraph(graph, layout);
    else view.setGraph(EMPTY_GRAPH, EMPTY_LAYOUT);
  }, [graph, layout]);

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
      {!hasCore && (
        <div
          className="orbit-empty"
          role="status"
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
