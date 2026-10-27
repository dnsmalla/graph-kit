// React wrapper for OrbitView. The three.js view is created in an effect, so
// server rendering never touches window, document or WebGL.

import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";
import type {
  OrbitLayout,
  SystemGraph,
  SystemRingItem,
  Vec3,
} from "../../../typescript/src/system/index.js";
import { OrbitView, type OrbitColorMode, type OrbitPick, type OrbitTheme } from "./OrbitView";
import type { CameraPose, VizGraph } from "../viz";

/** Imperative handle: the search box, the breadcrumb and the camera memory fly the camera through it. */
export interface OrbitPanelHandle {
  /** Flies to a core node or ring item (or an OS-graph node). False when the id is not drawn or there is no WebGL. */
  focusNode(id: string): boolean;
  /** The camera as plain numbers, or null without WebGL. */
  getCamera(): CameraPose | null;
  /** Puts the camera at a remembered pose. */
  setCamera(pose: CameraPose): void;
  /** Frames the camera on the current scene again. */
  refit(): void;
}

/** The OS graph (or a hub's graph) and its layout. When given, the brain draws it instead of `core`. */
export interface OrbitVizInput {
  graph: VizGraph;
  layout: OrbitLayout;
}

export interface OrbitPanelProps {
  /** The project's core. Compared by identity: pass a new object only when the project changes. */
  core: { graph: SystemGraph; layout: OrbitLayout } | null;
  /** The recent-activity ring. Compared by identity: pass a new object only when the ring changes. */
  ring: { items: SystemRingItem[]; positions: Map<string, Vec3> } | null;
  /** The OS graph or a hub's graph. Compared by identity. When set, it is drawn and `core` is ignored. */
  viz?: OrbitVizInput | null;
  onSelect?: (item: OrbitPick) => void;
  /** Called once when WebGL is unavailable (the view then shows only its text fallback). */
  onFallback?: () => void;
  /** Show the "No project graph yet" text when there is no core. Default true. */
  showEmpty?: boolean;
  /** The highlighted item: a core node id or a ring item id. Null clears the highlight. */
  selectedId?: string | null;
  /** What the core is coloured by. Default "kind". Controlled: pair with onColorByChange. */
  colorBy?: OrbitColorMode;
  onColorByChange?: (mode: OrbitColorMode) => void;
  /** Imperative handle (React 19 passes `ref` as a prop). */
  ref?: Ref<OrbitPanelHandle>;
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
const EMPTY_VIZ_TEXT = "Nothing in this part yet.";
const NO_GRAPH_TEXT = "No project graph yet";
const NO_RING: SystemRingItem[] = [];

const TOOLTIP_OFFSET_PX = 14;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
/** The host needs a definite height: the WebGL canvas is absolutely positioned inside it. */
const HOST_MIN_HEIGHT_PX = 360;

const COLOR_MODES: Array<{ id: OrbitColorMode; label: string }> = [
  { id: "kind", label: "Kind" },
  { id: "cluster", label: "Cluster" },
];

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

const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: "false",
} as const;

const TOOLBAR_STYLE: CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  zIndex: 3,
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const BUTTON_STYLE: CSSProperties = {
  width: 28,
  height: 28,
  padding: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 6,
  border: "1px solid var(--tok-color-border, rgba(255, 255, 255, 0.18))",
  background: "var(--tok-color-surface2, rgba(10, 12, 18, 0.78))",
  color: "var(--tok-color-text, #f2f4f8)",
  cursor: "pointer",
};

const SEGMENT_STYLE: CSSProperties = {
  display: "inline-flex",
  height: 28,
  borderRadius: 6,
  overflow: "hidden",
  border: "1px solid var(--tok-color-border, rgba(255, 255, 255, 0.18))",
};

function segmentButtonStyle(on: boolean): CSSProperties {
  return {
    padding: "0 10px",
    border: 0,
    font: "inherit",
    fontSize: 12,
    cursor: "pointer",
    background: on ? "var(--tok-color-accent, #66b8d1)" : "var(--tok-color-surface2, rgba(10, 12, 18, 0.78))",
    color: on ? "#0b0d12" : "var(--tok-color-text, #f2f4f8)",
  };
}

export interface OrbitToolbarProps {
  colorBy: OrbitColorMode;
  /** The rotation is paused (shows Play). */
  paused: boolean;
  /** Rotation is off for the whole view (reduced motion): the pause button is disabled. */
  rotationDisabled: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onTogglePause: () => void;
  onColorByChange: (mode: OrbitColorMode) => void;
}

/** The on-canvas controls: zoom in and out, reset, pause or play, and the colour mode. */
export function OrbitToolbar({
  colorBy,
  paused,
  rotationDisabled,
  onZoomIn,
  onZoomOut,
  onReset,
  onTogglePause,
  onColorByChange,
}: OrbitToolbarProps) {
  const pauseLabel = paused ? "Play rotation" : "Pause rotation";
  return (
    <div className="orbit-toolbar" role="toolbar" aria-label="Brain view controls" style={TOOLBAR_STYLE}>
      <button type="button" className="orbit-btn" aria-label="Zoom in" title="Zoom in (+)" style={BUTTON_STYLE} onClick={onZoomIn}>
        <svg {...ICON_PROPS}>
          <path d="M8 3.5v9M3.5 8h9" />
        </svg>
      </button>
      <button type="button" className="orbit-btn" aria-label="Zoom out" title="Zoom out (-)" style={BUTTON_STYLE} onClick={onZoomOut}>
        <svg {...ICON_PROPS}>
          <path d="M3.5 8h9" />
        </svg>
      </button>
      <button type="button" className="orbit-btn" aria-label="Reset view" title="Reset view (0)" style={BUTTON_STYLE} onClick={onReset}>
        <svg {...ICON_PROPS}>
          <path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2" />
          <path d="M3.5 2.8v2.6h2.6" />
        </svg>
      </button>
      <button
        type="button"
        className="orbit-btn"
        aria-label={pauseLabel}
        title={rotationDisabled ? "Rotation is off while reduced motion is on" : `${pauseLabel} (Space)`}
        disabled={rotationDisabled}
        style={{ ...BUTTON_STYLE, opacity: rotationDisabled ? 0.5 : 1 }}
        onClick={onTogglePause}
      >
        {paused ? (
          <svg {...ICON_PROPS}>
            <path d="M5 3.5l7 4.5-7 4.5z" fill="currentColor" />
          </svg>
        ) : (
          <svg {...ICON_PROPS}>
            <path d="M5.5 3.5v9M10.5 3.5v9" />
          </svg>
        )}
      </button>
      <div role="group" aria-label="Colour by" className="orbit-seg" style={SEGMENT_STYLE}>
        {COLOR_MODES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={colorBy === id}
            style={segmentButtonStyle(colorBy === id)}
            onClick={() => onColorByChange(id)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Renders the OrbitView. The core and the ring are separate inputs with separate
 * effects: a ring change updates only the ring, and the core (with the camera and
 * the hover) is rebuilt only when `core` changes. Both are compared by identity, so
 * callers must memoise them.
 */
export function OrbitPanel({
  core,
  ring,
  viz = null,
  onSelect,
  onFallback,
  showEmpty = true,
  selectedId = null,
  colorBy = "kind",
  onColorByChange,
  ref,
}: OrbitPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<OrbitView | null>(null);
  const selectRef = useRef(onSelect);
  const fallbackRef = useRef(onFallback);
  const [pick, setPick] = useState<OrbitPick | null>(null);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [noWebgl, setNoWebgl] = useState(false);

  const hasCore = viz ? viz.graph.nodes.length > 0 : !!core && core.graph.core.length > 0;

  useImperativeHandle(
    ref,
    () => ({
      focusNode: (id: string) => viewRef.current?.focusNode(id) ?? false,
      getCamera: () => viewRef.current?.getCamera() ?? null,
      setCamera: (pose: CameraPose) => viewRef.current?.setCamera(pose),
      refit: () => viewRef.current?.refit(),
    }),
    [],
  );

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
    const motion = prefersReducedMotion();
    setReduced(motion);
    const view = new OrbitView(host, {
      reducedMotion: motion,
      theme: readTheme(),
      onHover: (item) => setPick(item),
      onSelect: (item) => selectRef.current?.(item),
      onPausedChange: (next) => setPaused(next),
      onFallback: () => {
        setNoWebgl(true);
        fallbackRef.current?.();
      },
    });
    viewRef.current = view;

    const motionQuery = reducedMotionQuery();
    const onMotionChange = (e: MediaQueryListEvent) => {
      setReduced(e.matches);
      view.setReducedMotion(e.matches);
    };
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

  // Core: a new project (or a new OS level) clears the hover and rebuilds the drawn graph. The OS
  // graph wins while it is given; otherwise the project's core is drawn.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    setPick(null);
    if (viz) view.setViz(viz.graph, viz.layout);
    else if (core && core.graph.core.length > 0) view.setGraph(core.graph, core.layout);
    else view.setGraph(EMPTY_GRAPH, EMPTY_LAYOUT);
  }, [core, viz]);

  // Ring: only the ring points change; the hover and the camera stay as they are.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.setRing(ring ? ring.items : NO_RING, ring ? ring.positions : EMPTY_POSITIONS);
  }, [ring]);

  // Selection and colour mode are applied in place; they survive core and ring rebuilds inside the view.
  useEffect(() => {
    viewRef.current?.setSelection(selectedId ?? null);
  }, [selectedId]);

  useEffect(() => {
    viewRef.current?.setColorMode(colorBy);
  }, [colorBy]);

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
          {viz ? EMPTY_VIZ_TEXT : NO_GRAPH_TEXT}
        </div>
      )}
      {!noWebgl && (
        <OrbitToolbar
          colorBy={colorBy}
          paused={paused || reduced}
          rotationDisabled={reduced}
          onZoomIn={() => viewRef.current?.zoomIn()}
          onZoomOut={() => viewRef.current?.zoomOut()}
          onReset={() => viewRef.current?.resetView()}
          onTogglePause={() => viewRef.current?.toggleRotation()}
          onColorByChange={(mode) => onColorByChange?.(mode)}
        />
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
        {pick?.type === "viz" && pick.drill ? <span style={{ opacity: 0.7 }}>Click to open</span> : null}
      </div>
    </div>
  );
}
