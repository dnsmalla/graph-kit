// React wrapper for OrbitView. The three.js view is created in an effect, so
// server rendering never touches window, document or WebGL.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { OrbitLayout, SystemGraph } from "../../../typescript/src/system/index.js";
import { OrbitView, type OrbitPick } from "./OrbitView";

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

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

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

  // Create the view once per mount; dispose on unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new OrbitView(host, {
      reducedMotion: prefersReducedMotion(),
      onHover: (item) => setPick(item),
      onSelect: (item) => selectRef.current?.(item),
    });
    viewRef.current = view;
    return () => {
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
    const x = e.clientX - rect.left + TOOLTIP_OFFSET_PX;
    const y = e.clientY - rect.top + TOOLTIP_OFFSET_PX;
    tip.style.transform = `translate(${x}px, ${y}px)`;
  };

  return (
    <div
      className="orbit-panel"
      style={{ position: "relative", width: "100%", height: "100%", minHeight: 240, overflow: "hidden" }}
      onPointerMove={onMove}
      onPointerLeave={() => setPick(null)}
    >
      <div ref={hostRef} className="orbit-host" style={{ width: "100%", height: "100%" }} />
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
