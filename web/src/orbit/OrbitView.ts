// Framework-free three.js view of the orbit "brain": a point cloud of the project
// graph (coloured by category or by cluster) with a ring of recent activity.
// Camera work is three's own OrbitControls (orbit, zoom to cursor, pan, damping);
// the view adds gesture pinch (WebKit), keyboard keys, focus flights, selection
// highlighting and an idle-aware render loop. Hover and click are resolved with a
// Raycaster from the current camera. If WebGL is unavailable the view shows a text
// fallback and every method no-ops.
//
// The canvas is absolutely positioned inside the container, so its backing
// buffer never feeds back into the container's auto height (the host must
// give the container a definite height, see OrbitPanel).

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type {
  CoreCategory,
  OrbitLayout,
  SystemGraph,
  SystemRingItem,
  Vec3,
} from "../../../typescript/src/system/index.js";
import {
  buildCategoryColors,
  buildClusterColors,
  buildEdgeData,
  buildPointBuffers,
  categoryColorVar,
  clusterColorVar,
  colorToHex,
  DEFAULT_CATEGORY_COLORS,
  DEFAULT_CLUSTER_COLORS,
  isHexColor,
  ringLabels,
  type RingLabel,
  uniqueCoreNodes,
} from "./scene";

export interface OrbitPick {
  type: "core" | "ring";
  id: string;
  label: string;
  /** Category for core nodes, activity kind for ring items. */
  detail: string;
}

export type OrbitTheme = "dark" | "light";
/** What the core points are coloured by: the category ("kind") or the detected community ("cluster"). */
export type OrbitColorMode = "kind" | "cluster";

/** The subset of WebGLRenderer the view uses; tests inject a fake. */
export interface RendererLike {
  readonly domElement: HTMLCanvasElement;
  setPixelRatio(ratio: number): void;
  getPixelRatio(): number;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  dispose(): void;
  forceContextLoss(): void;
}

export interface OrbitViewOptions {
  /** Core rotation speed in rad/s for the core and the ring. Default 0.05; 0 turns auto-rotation off. */
  rotationSpeed?: number;
  /** When true the view does not rotate on its own (drag, zoom and pan still work). */
  reducedMotion?: boolean;
  /** Default "dark". "light" uses normal blending, darker lines and the light palette. */
  theme?: OrbitTheme;
  /** Category colours. Default: the --os-cat-* CSS properties, with DEFAULT_CATEGORY_COLORS as fallback. */
  colors?: Partial<Record<CoreCategory, string>>;
  /** Initial colour mode of the core points. Default "kind". */
  colorBy?: OrbitColorMode;
  onHover?: (item: OrbitPick | null) => void;
  onSelect?: (item: OrbitPick) => void;
  /** Called when the user pauses or resumes the rotation (the view's toggle, Space). */
  onPausedChange?: (paused: boolean) => void;
  /** Called once when WebGL is unavailable and the view shows its text fallback. */
  onFallback?: () => void;
  /** Builds the renderer on the canvas the view created. Default: WebGLRenderer. */
  createRenderer?: (canvas: HTMLCanvasElement) => RendererLike;
  /** Default: window.requestAnimationFrame. */
  requestFrame?: (cb: FrameRequestCallback) => number;
  /** Default: window.cancelAnimationFrame. */
  cancelFrame?: (id: number) => void;
  /** Default: setTimeout. Used for the resume-after-interaction delay. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Default: clearTimeout. */
  clearTimer?: (handle: unknown) => void;
}

/** Keyboard actions of the focused canvas. */
export type OrbitKeyAction = "zoomIn" | "zoomOut" | "reset" | "togglePause";

/** Maps a KeyboardEvent.key to the view action it triggers, or null. */
export function orbitKeyAction(key: string): OrbitKeyAction | null {
  switch (key) {
    case "+":
    case "=":
      return "zoomIn";
    case "-":
    case "_":
      return "zoomOut";
    case "0":
      return "reset";
    case " ":
    case "Spacebar":
      return "togglePause";
    default:
      return null;
  }
}

const FOV_DEG = 45;
/** Converts a world-space point size to pixels (tuned by eye, see scene units). */
const POINT_SCALE = 0.5;
const CORE_OPACITY = 0.9;
/** Light theme: normal blending needs a little more alpha to read on white. */
const LIGHT_POINT_BOOST = 1.25;
const RING_POINT_SIZE = 6;
const RING_RGB: Record<OrbitTheme, [number, number, number]> = {
  dark: [0.96, 0.97, 1],
  light: [0.2, 0.24, 0.32],
};
const LINE_STYLE = {
  edge: {
    dark: { color: 0x8a93a6, opacity: 0.08 },
    light: { color: 0x3d4454, opacity: 0.22 },
  },
  ring: {
    dark: { color: 0xffffff, opacity: 0.25 },
    light: { color: 0x3d4454, opacity: 0.35 },
  },
} as const;
const RING_SPIN_FACTOR = 1.6;
const CLICK_SLOP_PX = 4;
const MAX_FRAME_DT = 0.1;
/** Hover is re-resolved at most this often while the view moves under the pointer. */
const REPICK_INTERVAL_MS = 150;
/** Framing: sphere fit with a 25% margin, camera looking slightly down. */
const FRAME_MARGIN = 1.25;
const FRAME_ELEVATION = 0.35;
/** The camera is re-framed when the core's node count moves by more than this fraction. */
const REFRAME_CHANGE_RATIO = 0.2;
/** Zoom limits as multiples of the layout radius. */
const MIN_DISTANCE_RATIO = 0.3;
const MAX_DISTANCE_RATIO = 6;
/** Distance of the camera from a focused node, in layout radii. */
const FOCUS_DISTANCE_RATIO = 1;
const FOCUS_MS = 400;
/** One turn of the camera auto-rotation, in seconds. */
const AUTO_ROTATE_TURN_S = 40;
/** Auto-rotation resumes this long after the user stops interacting. */
const RESUME_MS = 4000;
const ZOOM_STEP = 1.25;
/** Selection look: the selected node and its neighbours are larger, everything else dims. */
const DIM_ALPHA = 0.15;
const HIGHLIGHT_SIZE = 1.8;
const NEIGHBOUR_SIZE = 1.35;
/** Edge alpha multipliers (the material's opacity still applies): touching the selection, and the rest. */
const EDGE_HOT = 4;
const EDGE_DIM = 0.25;

const VERTEX_SHADER = `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / -mv.z, 1.0, 48.0);
}
`;

const FRAGMENT_SHADER = `
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  if (d > 0.5) discard;
  float a = 1.0 - smoothstep(0.15, 0.5, d);
  gl_FragColor = vec4(vColor, a * uOpacity * vAlpha);
}
`;

interface CoreItem {
  id: string;
  label: string;
  category: CoreCategory;
  community: number;
}

interface SelectionRef {
  kind: "core" | "ring";
  index: number;
}

interface Tween {
  start: number | null;
  fromPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toPos: THREE.Vector3;
  toTarget: THREE.Vector3;
}

/** Identity of one ring item as the view draws it. A change of any field rebuilds the ring. */
function ringSignature(items: SystemRingItem[]): string {
  return items.map((i) => [i.id, i.at, i.label, i.kind].join("\u0001")).join("\u0002");
}

function resolveColors(
  partial: Partial<Record<CoreCategory, string>> | undefined,
): Record<CoreCategory, string> {
  const out = { ...DEFAULT_CATEGORY_COLORS };
  for (const cat of Object.keys(out) as CoreCategory[]) {
    const v = partial?.[cat];
    if (isHexColor(v)) out[cat] = v;
  }
  return out;
}

/** Reads one CSS custom property of the page as hex, or null when it is unset or not a colour. */
function readCssColor(name: string): string | null {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function" || !document.documentElement) {
    return null;
  }
  return colorToHex(getComputedStyle(document.documentElement).getPropertyValue(name) ?? "");
}

function readCategoryColors(): Record<CoreCategory, string> {
  const out = { ...DEFAULT_CATEGORY_COLORS };
  for (const cat of Object.keys(out) as CoreCategory[]) {
    out[cat] = readCssColor(categoryColorVar(cat)) ?? out[cat];
  }
  return out;
}

function readClusterPalette(): string[] {
  return DEFAULT_CLUSTER_COLORS.map((fallback, i) => readCssColor(clusterColorVar(i + 1)) ?? fallback);
}

function sameItem(a: OrbitPick | null, b: OrbitPick | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.id === b.id;
}

function devicePixelRatioOrOne(): number {
  return typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

function defaultCreateRenderer(canvas: HTMLCanvasElement): RendererLike {
  return new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
}

function isStaticPosition(el: HTMLElement): boolean {
  const pos = typeof getComputedStyle === "function" ? getComputedStyle(el).position : "";
  return pos === "" || pos === "static";
}

function easeInOutCubic(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

export class OrbitView {
  private readonly container: HTMLElement;
  private readonly speed: number;
  private reducedMotion: boolean;
  private theme: OrbitTheme;
  private readonly fixedCategoryColors: boolean;
  private categoryColors: Record<CoreCategory, string>;
  private clusterPalette: string[] = [...DEFAULT_CLUSTER_COLORS];
  private colorMode: OrbitColorMode;
  private readonly onHover?: (item: OrbitPick | null) => void;
  private readonly onSelect?: (item: OrbitPick) => void;
  private readonly onPausedChange?: (paused: boolean) => void;
  private readonly onFallback?: () => void;
  private readonly createRenderer: (canvas: HTMLCanvasElement) => RendererLike;
  private readonly requestFrame: (cb: FrameRequestCallback) => number;
  private readonly cancelFrame: (id: number) => void;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private renderer: RendererLike | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 1, 1000);
  private controls!: OrbitControls;
  private home = { position: new THREE.Vector3(0, 0, 1), target: new THREE.Vector3() };
  private tween: Tween | null = null;
  /** True once the user has moved the camera; a resize then keeps the pose instead of re-framing. */
  private userMoved = false;
  private readonly scratch = new THREE.Vector3();
  private readonly coreGroup = new THREE.Group();
  private readonly ringGroup = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly pickTargets: THREE.Object3D[] = [];
  /** Shared by every point material; updated on resize. */
  private readonly scaleUniform = { value: 1 };
  private readonly pointMaterials = new Set<THREE.ShaderMaterial>();
  private readonly lineMaterials = new Set<THREE.LineBasicMaterial>();

  private graph: SystemGraph | null = null;
  private layout: OrbitLayout | null = null;
  private coreItems: CoreItem[] = [];
  private coreIndex = new Map<string, number>();
  private ringItems: RingLabel[] = [];
  private ringIndex = new Map<string, number>();
  /** Core neighbours per core index, from every core edge (not only the drawn ones). */
  private adjacency: number[][] = [];
  /** Two core indexes per drawn edge. */
  private edgeEnds: Uint32Array = new Uint32Array(0);
  private kindRgb: Float32Array = new Float32Array(0);
  private clusterRgb: Float32Array = new Float32Array(0);
  private baseSizes: Float32Array = new Float32Array(0);
  private ringSig: string | null = null;
  private ringRadius = 0;
  private corePoints: THREE.Points | null = null;
  private coreColorAttr: THREE.BufferAttribute | null = null;
  private coreSizeAttr: THREE.BufferAttribute | null = null;
  private coreAlphaAttr: THREE.BufferAttribute | null = null;
  private edgeColorAttr: THREE.BufferAttribute | null = null;
  private ringPoints: THREE.Points | null = null;
  private ringColorAttr: THREE.BufferAttribute | null = null;
  private ringSizeAttr: THREE.BufferAttribute | null = null;
  private ringAlphaAttr: THREE.BufferAttribute | null = null;
  private radius = 1;
  /** Core node count at the last framing, or null before the first framing. */
  private framedCoreCount: number | null = null;
  private ringCount = 0;

  private selectedId: string | null = null;
  private selection: SelectionRef | null = null;

  private coreAngle = 0;
  private ringAngle = 0;
  private frameId: number | null = null;
  private lastTime: number | null = null;
  private disposed = false;
  private inFrame = false;
  private userPaused = false;
  private interacting = false;
  private resumeTimer: unknown = null;
  private gestureBase: number | null = null;

  private hovered: OrbitPick | null = null;
  /** True while the pointer is over the canvas (not dragging); drives hover re-picks. */
  private hovering = false;
  private hoverX = 0;
  private hoverY = 0;
  private lastPickAt = 0;
  private dragging = false;
  private dragMoved = false;
  private dragButton = 0;
  private dragStartX = 0;
  private dragStartY = 0;
  private resizeObserver: ResizeObserver | null = null;
  private fallbackEl: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;

  constructor(container: HTMLElement, opts: OrbitViewOptions = {}) {
    this.container = container;
    this.speed =
      typeof opts.rotationSpeed === "number" && Number.isFinite(opts.rotationSpeed) && opts.rotationSpeed >= 0
        ? opts.rotationSpeed
        : 0.05;
    this.reducedMotion = !!opts.reducedMotion;
    this.theme = opts.theme === "light" ? "light" : "dark";
    this.fixedCategoryColors = !!opts.colors;
    this.categoryColors = opts.colors ? resolveColors(opts.colors) : readCategoryColors();
    this.colorMode = opts.colorBy === "cluster" ? "cluster" : "kind";
    this.onHover = opts.onHover;
    this.onSelect = opts.onSelect;
    this.onPausedChange = opts.onPausedChange;
    this.onFallback = opts.onFallback;
    this.createRenderer = opts.createRenderer ?? defaultCreateRenderer;
    this.requestFrame = opts.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = opts.cancelFrame ?? ((id) => cancelAnimationFrame(id));
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

    this.scene.add(this.coreGroup, this.ringGroup);

    let renderer: RendererLike;
    try {
      renderer = this.createRenderer(document.createElement("canvas"));
    } catch {
      this.showFallback();
      this.onFallback?.();
      return;
    }
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(devicePixelRatioOrOne(), 2));

    const canvas = renderer.domElement;
    this.canvas = canvas;
    canvas.className = "orbit-canvas";
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      "Project brain. Drag to orbit, scroll or pinch to zoom, double-click a node to focus it. Keys: plus and minus zoom, 0 resets the view, space pauses the rotation.",
    );
    Object.assign(canvas.style, {
      position: "absolute",
      top: "0",
      right: "0",
      bottom: "0",
      left: "0",
      width: "100%",
      height: "100%",
      display: "block",
      touchAction: "none",
      cursor: "grab",
    });
    // The canvas is positioned against the container, so the container must be positioned too.
    if (isStaticPosition(container)) container.style.position = "relative";
    container.appendChild(canvas);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("lostpointercapture", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("dblclick", this.onDblClick);
    canvas.addEventListener("keydown", this.onKeyDown);
    canvas.addEventListener("gesturestart", this.onGestureStart as EventListener);
    canvas.addEventListener("gesturechange", this.onGestureChange as EventListener);
    canvas.addEventListener("gestureend", this.onGestureEnd as EventListener);
    document.addEventListener("visibilitychange", this.onVisibility);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.autoRotateSpeed = 60 / AUTO_ROTATE_TURN_S;
    this.controls.addEventListener("change", this.onControlsChange);
    this.controls.addEventListener("start", this.onControlsStart);
    this.controls.addEventListener("end", this.onControlsEnd);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
    this.clusterPalette = readClusterPalette();
    this.resize();
    this.updateAutoRotate();
  }

  /**
   * Replace the core (the project's nodes and edges) with a graph and its layout.
   * Calling again with the same objects is a no-op; a new object rebuilds the core
   * buffers. The camera keeps its pose: it is framed on the first content and again
   * only when the core's node count changes by more than 20% (or on refit()).
   * The ring is not part of the core: it comes from setRing().
   */
  setGraph(graph: SystemGraph, layout: OrbitLayout): void {
    if (!this.renderer || this.disposed) return;
    if (graph === this.graph && layout === this.layout) return;
    this.clearCore();
    this.graph = graph;
    this.layout = layout;

    const nodes = uniqueCoreNodes(graph);
    this.coreItems = nodes.map((n) => ({
      id: n.id,
      label: n.label ?? n.id,
      category: n.category,
      community: n.community,
    }));
    this.coreIndex = new Map(this.coreItems.map((c, i) => [c.id, i]));
    this.adjacency = this.coreItems.map(() => []);
    for (const edge of graph.edges) {
      const a = this.coreIndex.get(edge.source);
      const b = this.coreIndex.get(edge.target);
      if (a === undefined || b === undefined || a === b) continue;
      this.adjacency[a]!.push(b);
      this.adjacency[b]!.push(a);
    }

    const pts = buildPointBuffers(graph, layout, this.categoryColors);
    this.baseSizes = pts.sizes;
    this.kindRgb = buildCategoryColors(this.coreItems, this.categoryColors);
    this.clusterRgb = buildClusterColors(this.coreItems, this.clusterPalette);
    if (pts.ids.length > 0) {
      const n = pts.ids.length;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pts.positions, 3));
      this.coreColorAttr = new THREE.BufferAttribute(new Float32Array(this.activeCoreColors()), 3);
      geo.setAttribute("aColor", this.coreColorAttr);
      this.coreSizeAttr = new THREE.BufferAttribute(new Float32Array(pts.sizes), 1);
      geo.setAttribute("aSize", this.coreSizeAttr);
      this.coreAlphaAttr = new THREE.BufferAttribute(new Float32Array(n).fill(1), 1);
      geo.setAttribute("aAlpha", this.coreAlphaAttr);
      this.corePoints = new THREE.Points(geo, this.makePointMaterial(CORE_OPACITY));
      this.coreGroup.add(this.corePoints);
    }

    const edges = buildEdgeData(graph, layout, this.coreIndex);
    this.edgeEnds = edges.ends;
    if (edges.positions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(edges.positions, 3));
      // One rgba per vertex: rgb stays white (the material colour is the theme's), alpha is the highlight multiplier.
      this.edgeColorAttr = new THREE.BufferAttribute(new Float32Array(edges.ends.length * 4).fill(1), 4);
      geo.setAttribute("color", this.edgeColorAttr);
      this.coreGroup.add(new THREE.LineSegments(geo, this.makeLineMaterial("edge")));
    }

    this.radius = Math.max(layout.bounds.radius, this.ringRadius, 1);
    this.setHover(null);
    this.applySelection();
    this.frameCore();
    this.requestRender();
  }

  /**
   * Replace the recent-activity ring. Only the ring's points and circle are rebuilt:
   * the core and the camera are untouched, and a ring with the same ids and times
   * (in the same order) is a no-op.
   */
  setRing(ring: SystemRingItem[], ringPositions: Map<string, Vec3>): void {
    if (!this.renderer || this.disposed) return;
    const sig = ringSignature(ring);
    if (sig === this.ringSig) return;
    this.ringSig = sig;
    this.clearRing();
    this.ringItems = ringLabels(ring, ringPositions);
    this.ringCount = this.ringItems.length;
    this.ringIndex = new Map(this.ringItems.map((r, i) => [r.id, i]));

    let ringRadius = 0;
    if (this.ringItems.length > 0) {
      const count = this.ringItems.length;
      const positions = new Float32Array(count * 3);
      const rgb = new Float32Array(count * 3);
      const sizes = new Float32Array(count).fill(RING_POINT_SIZE);
      const ringRgb = RING_RGB[this.theme];
      this.ringItems.forEach((r, i) => {
        positions[i * 3] = r.x;
        positions[i * 3 + 1] = r.y;
        positions[i * 3 + 2] = r.z;
        rgb.set(ringRgb, i * 3);
        ringRadius = Math.max(ringRadius, Math.hypot(r.x, r.z));
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      this.ringColorAttr = new THREE.BufferAttribute(rgb, 3);
      geo.setAttribute("aColor", this.ringColorAttr);
      this.ringSizeAttr = new THREE.BufferAttribute(sizes, 1);
      geo.setAttribute("aSize", this.ringSizeAttr);
      this.ringAlphaAttr = new THREE.BufferAttribute(new Float32Array(count).fill(1), 1);
      geo.setAttribute("aAlpha", this.ringAlphaAttr);
      this.ringPoints = new THREE.Points(geo, this.makePointMaterial(1));
      this.ringGroup.add(this.ringPoints);
    }
    if (ringRadius > 0) {
      const seg = 128;
      const circle = new Float32Array((seg + 1) * 3);
      for (let i = 0; i <= seg; i++) {
        const a = (Math.PI * 2 * i) / seg;
        circle[i * 3] = ringRadius * Math.cos(a);
        circle[i * 3 + 2] = ringRadius * Math.sin(a);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(circle, 3));
      this.ringGroup.add(new THREE.LineLoop(geo, this.makeLineMaterial("ring")));
    }

    this.ringRadius = ringRadius;
    this.radius = Math.max(this.layout?.bounds.radius ?? 0, this.ringRadius, 1);
    this.applySelection();
    this.frameCore();
    this.requestRender();
  }

  /** Re-frame the camera on the current scene (for example after a project switch the view should follow). */
  refit(): void {
    if (!this.renderer || this.disposed) return;
    this.framedCoreCount = this.coreItems.length;
    this.fitCamera();
    this.requestRender();
  }

  /**
   * Highlights the core node or ring item with this id: it and its direct core
   * neighbours grow, everything else dims, and the edges touching the node are drawn
   * brighter. An id that is not drawn clears the highlight. Done in place: no buffer is rebuilt.
   */
  setSelection(id: string | null): void {
    this.selectedId = id;
    if (!this.renderer || this.disposed) return;
    this.applySelection();
    this.requestRender();
  }

  /**
   * Flies the camera to a core node or ring item (about 400 ms, eased) and aims the
   * orbit centre at it. Returns false when the id is not drawn or there is no WebGL.
   * Selecting the node is the caller's job (see setSelection and onSelect).
   */
  focusNode(id: string): boolean {
    if (!this.renderer || this.disposed) return false;
    this.scene.updateMatrixWorld(true);
    const world = this.worldPosition(id);
    if (!world) return false;
    const c = this.controls;
    const dir = this.scratch.subVectors(this.camera.position, c.target);
    if (dir.lengthSq() === 0) dir.set(0, 0, 1);
    dir.normalize();
    const dist = THREE.MathUtils.clamp(this.radius * FOCUS_DISTANCE_RATIO, c.minDistance, c.maxDistance);
    this.userMoved = true;
    this.tween = {
      start: null,
      fromPos: this.camera.position.clone(),
      fromTarget: c.target.clone(),
      toPos: world.clone().addScaledVector(dir, dist),
      toTarget: world,
    };
    this.requestRender();
    return true;
  }

  /** Zoom in by one step (the toolbar button and the + key). Limited by the zoom bounds. */
  zoomIn(): void {
    this.stepZoom(true);
  }

  /** Zoom out by one step (the toolbar button and the - key). */
  zoomOut(): void {
    this.stepZoom(false);
  }

  /** Back to the framed view of the current scene (the toolbar button and the 0 key). */
  resetView(): void {
    if (!this.renderer || this.disposed) return;
    this.tween = null;
    this.userMoved = false;
    // Flush the damping residue first (a leftover rotation or pan would otherwise land on the home pose).
    const c = this.controls;
    c.enableDamping = false;
    c.update(0);
    c.enableDamping = true;
    this.camera.position.copy(this.home.position);
    c.target.copy(this.home.target);
    c.update(0); // dt 0: the update must not add an auto-rotation step
    this.requestRender();
  }

  /** Pauses or resumes the automatic rotation (the toolbar button and Space). Returns true while paused. */
  toggleRotation(): boolean {
    if (!this.renderer || this.disposed) return this.userPaused;
    this.userPaused = !this.userPaused;
    this.updateAutoRotate();
    this.requestRender();
    this.onPausedChange?.(this.userPaused);
    return this.userPaused;
  }

  /** True while the user has paused the rotation. */
  isRotationPaused(): boolean {
    return this.userPaused;
  }

  /** Colour the core points by category ("kind") or by detected cluster ("cluster"). Recolours in place. */
  setColorMode(mode: OrbitColorMode): void {
    const next: OrbitColorMode = mode === "cluster" ? "cluster" : "kind";
    if (next === this.colorMode) return;
    this.colorMode = next;
    this.writeCoreColors();
    this.requestRender();
  }

  /** Enable or disable the automatic rotation (drag still works). */
  setReducedMotion(reduced: boolean): void {
    const next = !!reduced;
    if (next === this.reducedMotion) return;
    this.reducedMotion = next;
    this.updateAutoRotate();
  }

  /** Switch between the dark (additive) and light (normal blending) looks. */
  setTheme(theme: OrbitTheme): void {
    const next: OrbitTheme = theme === "light" ? "light" : "dark";
    if (next === this.theme) return;
    this.theme = next;
    if (!this.renderer || this.disposed) return;
    for (const mat of this.pointMaterials) this.stylePointMaterial(mat);
    for (const mat of this.lineMaterials) this.styleLineMaterial(mat);
    if (this.ringColorAttr) {
      const [r, g, b] = RING_RGB[next];
      const arr = this.ringColorAttr.array as Float32Array;
      for (let i = 0; i + 2 < arr.length; i += 3) {
        arr[i] = r;
        arr[i + 1] = g;
        arr[i + 2] = b;
      }
      this.ringColorAttr.needsUpdate = true;
    }
    this.refreshPalettes();
    this.requestRender();
  }

  /** Re-measure the container. Re-frames the camera unless the user has moved it. */
  resize(): void {
    if (!this.renderer || this.disposed) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    const pr = this.renderer.getPixelRatio();
    this.camera.aspect = w / h;
    this.scaleUniform.value = ((h * pr) / (2 * Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2))) * POINT_SCALE;
    if (this.userMoved) this.camera.updateProjectionMatrix();
    else this.fitCamera();
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameId !== null) this.cancelFrame(this.frameId);
    this.frameId = null;
    this.clearResume();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    const canvas = this.canvas;
    if (canvas) {
      canvas.removeEventListener("pointerdown", this.onPointerDown);
      canvas.removeEventListener("pointermove", this.onPointerMove);
      canvas.removeEventListener("pointerup", this.onPointerUp);
      canvas.removeEventListener("pointercancel", this.onPointerUp);
      canvas.removeEventListener("lostpointercapture", this.onPointerUp);
      canvas.removeEventListener("pointerleave", this.onPointerLeave);
      canvas.removeEventListener("dblclick", this.onDblClick);
      canvas.removeEventListener("keydown", this.onKeyDown);
      canvas.removeEventListener("gesturestart", this.onGestureStart as EventListener);
      canvas.removeEventListener("gesturechange", this.onGestureChange as EventListener);
      canvas.removeEventListener("gestureend", this.onGestureEnd as EventListener);
    }
    this.controls?.dispose();
    this.hovering = false;
    this.tween = null;
    this.clearCore();
    this.clearRing();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
    }
    canvas?.remove();
    this.canvas = null;
    this.fallbackEl?.remove();
    this.fallbackEl = null;
  }

  // ---- internals ----------------------------------------------------------

  private showFallback(): void {
    const p = document.createElement("p");
    p.className = "orbit-fallback";
    p.textContent = "3D view unavailable";
    this.container.appendChild(p);
    this.fallbackEl = p;
  }

  private makePointMaterial(opacity: number): THREE.ShaderMaterial {
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: { uScale: this.scaleUniform, uOpacity: { value: opacity } },
      transparent: true,
      depthWrite: false,
    });
    mat.userData.baseOpacity = opacity;
    this.pointMaterials.add(mat);
    this.stylePointMaterial(mat);
    return mat;
  }

  private stylePointMaterial(mat: THREE.ShaderMaterial): void {
    const light = this.theme === "light";
    const base = mat.userData.baseOpacity as number;
    mat.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
    mat.uniforms.uOpacity.value = light ? Math.min(1, base * LIGHT_POINT_BOOST) : base;
    mat.needsUpdate = true;
  }

  private makeLineMaterial(kind: "edge" | "ring"): THREE.LineBasicMaterial {
    const mat = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false, vertexColors: kind === "edge" });
    mat.userData.lineKind = kind;
    this.lineMaterials.add(mat);
    this.styleLineMaterial(mat);
    return mat;
  }

  private styleLineMaterial(mat: THREE.LineBasicMaterial): void {
    const kind = mat.userData.lineKind as "edge" | "ring";
    const style = LINE_STYLE[kind][this.theme];
    mat.color.setHex(style.color);
    mat.opacity = style.opacity;
  }

  /** Frames the camera on the scene: the home pose, the orbit centre at the origin and the zoom limits. */
  private fitCamera(): void {
    // Bounding-sphere fit: the narrower of the vertical and horizontal half-angles governs.
    const vHalf = THREE.MathUtils.degToRad(FOV_DEG) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const half = Math.min(vHalf, hHalf);
    const dist = (FRAME_MARGIN * this.radius) / Math.sin(half);
    const n = Math.hypot(FRAME_ELEVATION, 1);
    this.home = {
      position: new THREE.Vector3(0, (dist * FRAME_ELEVATION) / n, dist / n),
      target: new THREE.Vector3(0, 0, 0),
    };
    this.camera.position.copy(this.home.position);
    this.controls.target.copy(this.home.target);
    this.camera.lookAt(0, 0, 0);
    this.controls.minDistance = Math.max(this.radius * MIN_DISTANCE_RATIO, 1e-3);
    this.controls.maxDistance = Math.max(this.radius * MAX_DISTANCE_RATIO, this.controls.minDistance * 2);
    this.camera.near = Math.max(1e-3, this.radius * 0.01);
    this.camera.far = Math.max(dist * 5, this.radius * 20);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.userMoved = false;
    this.tween = null;
  }

  /**
   * Frames the camera on the first content, and again when the core's node count
   * changed by more than REFRAME_CHANGE_RATIO since the last framing.
   */
  private frameCore(): void {
    const count = this.coreItems.length;
    const hasContent = count > 0 || this.ringCount > 0;
    if (!hasContent) return;
    const previous = this.framedCoreCount;
    const changed =
      previous === null || Math.abs(count - previous) > REFRAME_CHANGE_RATIO * Math.max(previous, 1);
    if (!changed) return;
    this.framedCoreCount = count;
    this.fitCamera();
  }

  /** Removes a group's objects, disposing their buffers and dropping their materials from the restyle sets. */
  private clearGroup(group: THREE.Group): void {
    for (const obj of [...group.children]) {
      group.remove(obj);
      const o = obj as { geometry?: THREE.BufferGeometry; material?: THREE.ShaderMaterial | THREE.LineBasicMaterial };
      o.geometry?.dispose();
      if (o.material) {
        this.pointMaterials.delete(o.material as THREE.ShaderMaterial);
        this.lineMaterials.delete(o.material as THREE.LineBasicMaterial);
        o.material.dispose();
      }
    }
  }

  private clearCore(): void {
    this.clearGroup(this.coreGroup);
    this.corePoints = null;
    this.coreColorAttr = null;
    this.coreSizeAttr = null;
    this.coreAlphaAttr = null;
    this.edgeColorAttr = null;
    this.coreItems = [];
    this.coreIndex = new Map();
    this.adjacency = [];
    this.edgeEnds = new Uint32Array(0);
    this.kindRgb = new Float32Array(0);
    this.clusterRgb = new Float32Array(0);
    this.baseSizes = new Float32Array(0);
    this.graph = null;
    this.layout = null;
  }

  private clearRing(): void {
    this.clearGroup(this.ringGroup);
    this.ringPoints = null;
    this.ringColorAttr = null;
    this.ringSizeAttr = null;
    this.ringAlphaAttr = null;
    this.ringItems = [];
    this.ringIndex = new Map();
    this.ringCount = 0;
    this.ringRadius = 0;
  }

  private activeCoreColors(): Float32Array {
    return this.colorMode === "cluster" ? this.clusterRgb : this.kindRgb;
  }

  private writeCoreColors(): void {
    const attr = this.coreColorAttr;
    if (!attr) return;
    const arr = attr.array as Float32Array;
    const src = this.activeCoreColors();
    if (src.length !== arr.length) return;
    arr.set(src);
    attr.needsUpdate = true;
  }

  /** Re-reads the category and cluster palettes (CSS custom properties) and recolours the core in place. */
  private refreshPalettes(): void {
    if (!this.fixedCategoryColors) this.categoryColors = readCategoryColors();
    this.clusterPalette = readClusterPalette();
    if (this.coreItems.length === 0) return;
    this.kindRgb = buildCategoryColors(this.coreItems, this.categoryColors);
    this.clusterRgb = buildClusterColors(this.coreItems, this.clusterPalette);
    this.writeCoreColors();
  }

  private resolveSelection(): SelectionRef | null {
    const id = this.selectedId;
    if (id === null) return null;
    const core = this.coreIndex.get(id);
    if (core !== undefined) return { kind: "core", index: core };
    const ring = this.ringIndex.get(id);
    if (ring !== undefined) return { kind: "ring", index: ring };
    return null;
  }

  /** Writes the selection's size and alpha into the existing attributes (and the edge alphas). */
  private applySelection(): void {
    const sel = this.resolveSelection();
    this.selection = sel;
    const n = this.coreItems.length;
    const mark = new Uint8Array(n); // 2 = selected core node, 1 = its direct neighbour
    if (sel?.kind === "core") {
      mark[sel.index] = 2;
      for (const nb of this.adjacency[sel.index] ?? []) if (mark[nb] === 0) mark[nb] = 1;
    }

    if (this.coreAlphaAttr && this.coreSizeAttr) {
      const alpha = this.coreAlphaAttr.array as Float32Array;
      const size = this.coreSizeAttr.array as Float32Array;
      for (let i = 0; i < n; i++) {
        let a = 1;
        let s = this.baseSizes[i] ?? 1.5;
        if (sel?.kind === "core") {
          if (mark[i] === 2) s *= HIGHLIGHT_SIZE;
          else if (mark[i] === 1) s *= NEIGHBOUR_SIZE;
          else a = DIM_ALPHA;
        } else if (sel) {
          a = DIM_ALPHA;
        }
        alpha[i] = a;
        size[i] = s;
      }
      this.coreAlphaAttr.needsUpdate = true;
      this.coreSizeAttr.needsUpdate = true;
    }

    if (this.edgeColorAttr) {
      const rgba = this.edgeColorAttr.array as Float32Array;
      const ends = this.edgeEnds;
      for (let k = 0; k < ends.length / 2; k++) {
        let a = 1;
        if (sel?.kind === "core") {
          const touching = ends[k * 2] === sel.index || ends[k * 2 + 1] === sel.index;
          a = touching ? EDGE_HOT : EDGE_DIM;
        } else if (sel) {
          a = EDGE_DIM;
        }
        rgba[(k * 2) * 4 + 3] = a;
        rgba[(k * 2 + 1) * 4 + 3] = a;
      }
      this.edgeColorAttr.needsUpdate = true;
    }

    if (this.ringAlphaAttr && this.ringSizeAttr) {
      const alpha = this.ringAlphaAttr.array as Float32Array;
      const size = this.ringSizeAttr.array as Float32Array;
      for (let i = 0; i < alpha.length; i++) {
        const picked = sel?.kind === "ring" && sel.index === i;
        alpha[i] = sel ? (picked ? 1 : DIM_ALPHA) : 1;
        size[i] = RING_POINT_SIZE * (picked ? HIGHLIGHT_SIZE : 1);
      }
      this.ringAlphaAttr.needsUpdate = true;
      this.ringSizeAttr.needsUpdate = true;
    }
  }

  private applyRotation(): void {
    this.coreGroup.rotation.y = this.coreAngle;
    this.ringGroup.rotation.y = this.ringAngle;
  }

  private autoRotateWanted(): boolean {
    const hidden = typeof document !== "undefined" && !!document.hidden;
    return !this.reducedMotion && this.speed > 0 && !this.userPaused && !this.interacting && !hidden;
  }

  /** Syncs the controls' auto-rotation with the user's pause, the reduced-motion setting and the interaction state. */
  private updateAutoRotate(): void {
    if (!this.renderer || this.disposed) return;
    this.controls.autoRotate = this.autoRotateWanted();
    if (this.controls.autoRotate) this.requestRender();
  }

  private schedule(): void {
    if (this.disposed || this.frameId !== null || !this.renderer) return;
    // Armed from idle: the next frame must not integrate the time the view slept.
    if (!this.inFrame) this.lastTime = null;
    this.frameId = this.requestFrame(this.frame);
  }

  private requestRender(): void {
    this.schedule();
  }

  /**
   * One frame. The loop runs only while something moves (auto-rotation, damping,
   * a focus flight); when none of those is active the frame ends without re-arming.
   */
  private readonly frame = (now: number): void => {
    this.frameId = null;
    if (this.disposed || !this.renderer) return;
    const dt = this.lastTime === null ? 0 : Math.min((now - this.lastTime) / 1000, MAX_FRAME_DT);
    this.lastTime = now;
    this.inFrame = true;
    try {
      const spinning = this.autoRotateWanted();
      this.controls.autoRotate = spinning;
      const tweening = this.stepTween(now);
      if (spinning) {
        this.coreAngle += this.speed * dt;
        this.ringAngle += this.speed * RING_SPIN_FACTOR * dt;
        this.applyRotation();
      }
      const moved = this.controls.update(dt);
      if (
        this.hovering &&
        !this.dragging &&
        (moved || spinning || tweening) &&
        now - this.lastPickAt >= REPICK_INTERVAL_MS
      ) {
        this.lastPickAt = now;
        this.repickHover();
      }
      this.renderer.render(this.scene, this.camera);
      if (spinning || tweening || moved) this.schedule();
    } finally {
      this.inFrame = false;
    }
  };

  /** Advances the focus flight; returns true while it runs. */
  private stepTween(now: number): boolean {
    const t = this.tween;
    if (!t) return false;
    if (t.start === null) t.start = now;
    const p = Math.min(1, Math.max(0, (now - t.start) / FOCUS_MS));
    const e = easeInOutCubic(p);
    this.camera.position.lerpVectors(t.fromPos, t.toPos, e);
    this.controls.target.lerpVectors(t.fromTarget, t.toTarget, e);
    if (p >= 1) this.tween = null;
    return true;
  }

  private readonly onVisibility = (): void => {
    this.updateAutoRotate();
  };

  private readonly onControlsChange = (): void => {
    if (!this.inFrame) this.requestRender();
  };

  private readonly onControlsStart = (): void => {
    this.beginInteraction();
  };

  private readonly onControlsEnd = (): void => {
    this.endInteraction();
  };

  private beginInteraction(): void {
    if (this.disposed) return;
    this.userMoved = true;
    this.interacting = true;
    this.tween = null;
    this.clearResume();
    this.updateAutoRotate();
    this.requestRender();
  }

  private endInteraction(): void {
    if (this.disposed) return;
    this.clearResume();
    this.resumeTimer = this.setTimer(() => {
      this.resumeTimer = null;
      this.interacting = false;
      this.updateAutoRotate();
      this.requestRender();
    }, RESUME_MS);
  }

  private clearResume(): void {
    if (this.resumeTimer === null) return;
    this.clearTimer(this.resumeTimer);
    this.resumeTimer = null;
  }

  private distance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  /** Moves the camera along its view direction to distance `d` (clamped to the zoom bounds). */
  private setDistance(d: number): void {
    const c = this.controls;
    const offset = this.scratch.subVectors(this.camera.position, c.target);
    if (offset.lengthSq() === 0) offset.set(0, 0, 1);
    offset.setLength(THREE.MathUtils.clamp(d, c.minDistance, c.maxDistance));
    this.camera.position.copy(c.target).add(offset);
    this.userMoved = true;
    c.update(0);
    this.requestRender();
  }

  /**
   * One zoom step. The controls' dolly takes a scale below 1 for both directions (the wheel
   * passes 0.95): dollyIn(s) brings the camera closer, dollyOut(s) moves it away.
   */
  private stepZoom(inward: boolean): void {
    if (!this.renderer || this.disposed) return;
    this.userMoved = true;
    this.tween = null;
    // dolly*() calls update() without a delta, which would add an auto-rotation step: switch it off around the call.
    const c = this.controls;
    const spinning = c.autoRotate;
    c.autoRotate = false;
    if (inward) c.dollyIn(1 / ZOOM_STEP);
    else c.dollyOut(1 / ZOOM_STEP);
    c.autoRotate = spinning;
    this.requestRender();
  }

  /** The point's world position, or null when the id is not drawn. */
  private worldPosition(id: string): THREE.Vector3 | null {
    const core = this.coreIndex.get(id);
    if (core !== undefined && this.corePoints) return this.pointWorld(this.corePoints, core, this.coreGroup);
    const ring = this.ringIndex.get(id);
    if (ring !== undefined && this.ringPoints) return this.pointWorld(this.ringPoints, ring, this.ringGroup);
    return null;
  }

  private pointWorld(points: THREE.Points, index: number, group: THREE.Group): THREE.Vector3 | null {
    const attr = points.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!attr || index >= attr.count) return null;
    return new THREE.Vector3().fromBufferAttribute(attr, index).applyMatrix4(group.matrixWorld);
  }

  private pickAlpha(hit: THREE.Intersection): number {
    const attr = hit.object === this.ringPoints ? this.ringAlphaAttr : this.coreAlphaAttr;
    if (!attr || hit.index === undefined) return 1;
    return (attr.array as Float32Array)[hit.index] ?? 1;
  }

  private pickAt(clientX: number, clientY: number): OrbitPick | null {
    const canvas = this.canvas;
    if (!canvas || !this.renderer) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.params.Points.threshold = Math.max(this.radius * 0.02, 0.5);
    // The controls move the camera between renders, so the ray is built from its current matrices.
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.scene.updateMatrixWorld();

    const targets = this.pickTargets;
    targets.length = 0;
    if (this.corePoints) targets.push(this.corePoints);
    if (this.ringPoints) targets.push(this.ringPoints);
    if (targets.length === 0) return null;
    const hits = this.raycaster.intersectObjects(targets, false);
    // Prefer the nearest node that is not dimmed by the selection; fall back to the nearest one.
    const hit = hits.find((h) => this.pickAlpha(h) >= 0.5) ?? hits[0];
    if (!hit || hit.index === undefined) return null;

    if (hit.object === this.ringPoints) {
      const item = this.ringItems[hit.index];
      return item ? { type: "ring", id: item.id, label: item.label, detail: item.kind } : null;
    }
    const item = this.coreItems[hit.index];
    return item ? { type: "core", id: item.id, label: item.label, detail: item.category } : null;
  }

  /** Resolve the item under the remembered pointer position (used while the view moves). */
  private repickHover(): void {
    const pick = this.pickAt(this.hoverX, this.hoverY);
    if (this.canvas) this.canvas.style.cursor = pick ? "pointer" : "grab";
    this.setHover(pick);
  }

  private setHover(pick: OrbitPick | null): void {
    if (sameItem(this.hovered, pick)) return;
    this.hovered = pick;
    this.onHover?.(pick);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.canvas) return;
    this.dragging = true;
    this.dragMoved = false;
    this.dragButton = e.button;
    this.hovering = false;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.canvas.style.cursor = "grabbing";
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.dragging) {
      // The controls turn the drag into orbit or pan; this only tells a click from a drag.
      if (Math.hypot(e.clientX - this.dragStartX, e.clientY - this.dragStartY) > CLICK_SLOP_PX) {
        this.dragMoved = true;
      }
      this.setHover(null);
      return;
    }
    this.hovering = true;
    this.hoverX = e.clientX;
    this.hoverY = e.clientY;
    this.lastPickAt = this.lastTime ?? 0;
    this.repickHover();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.canvas) this.canvas.style.cursor = "grab";
    if (!this.dragMoved && e.type === "pointerup" && this.dragButton === 0) {
      const pick = this.pickAt(e.clientX, e.clientY);
      if (pick) this.onSelect?.(pick);
    }
  };

  private readonly onPointerLeave = (): void => {
    this.hovering = false;
    if (!this.dragging) this.setHover(null);
  };

  private readonly onDblClick = (e: MouseEvent): void => {
    const pick = this.pickAt(e.clientX, e.clientY);
    if (!pick) return;
    this.focusNode(pick.id);
    this.onSelect?.(pick);
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const action = orbitKeyAction(e.key);
    if (!action) return;
    e.preventDefault();
    if (action === "zoomIn") this.zoomIn();
    else if (action === "zoomOut") this.zoomOut();
    else if (action === "reset") this.resetView();
    else this.toggleRotation();
  };

  /** WebKit (macOS trackpad) pinch: scale dollies the camera; the page must not zoom. */
  private readonly onGestureStart = (e: Event): void => {
    e.preventDefault();
    this.gestureBase = this.distance();
    this.beginInteraction();
  };

  private readonly onGestureChange = (e: Event): void => {
    e.preventDefault();
    const scale = Number((e as Event & { scale?: number }).scale);
    if (!Number.isFinite(scale) || scale <= 0) return;
    if (this.gestureBase === null) this.gestureBase = this.distance();
    this.setDistance(this.gestureBase / scale);
  };

  private readonly onGestureEnd = (e: Event): void => {
    e.preventDefault();
    this.gestureBase = null;
    this.endInteraction();
  };
}
