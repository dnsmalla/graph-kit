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
  buildEdgeShades,
  buildPointBuffers,
  buildVizEdgeColors,
  buildVizKindColors,
  categoryColorVar,
  clusterColorVar,
  colorToHex,
  coreFramingRadius,
  DEFAULT_CATEGORY_COLORS,
  DEFAULT_CLUSTER_COLORS,
  extraLabelIndices,
  fitDistance,
  HUB_LABEL_HEIGHT_PX,
  hexToRgb01,
  isHexColor,
  LABEL_HEIGHT_PX,
  LABEL_STYLE,
  labelWidth,
  MEMBER_EDGE_ALPHA,
  pickLabels,
  ringLabels,
  type RingLabel,
  statusRing,
  uniqueCoreNodes,
  vizEdgeAlphas,
  vizFramingRadius,
  vizLevelSignature,
  vizNodeAlpha,
  vizNodePx,
  VIZ_PULSE_MIN,
  VIZ_PULSE_MS,
  type LabelCandidate,
} from "./scene";
import type { CameraPose, VizEdge, VizGraph, VizNode } from "../viz";

/**
 * A picked item. `core` is a project node, `ring` an activity item, `viz` a node of the OS
 * graph (with its `drill` hub, or null), and `edge` a labelled edge of the OS graph (hover only:
 * the page does not select an edge).
 */
export interface OrbitPick {
  type: "core" | "ring" | "viz" | "edge";
  id: string;
  label: string;
  /** Category for core nodes, activity kind for ring items and viz nodes, kind for edges. */
  detail: string;
  /** The hub a viz node opens (null when it opens none). */
  drill?: string | null;
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
  /**
   * Called on a double-click with the picked node. The page opens a hub here; without it the
   * double-click reports through onSelect like a click, as before.
   */
  onActivate?: (item: OrbitPick) => void;
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
/** Core points are alpha-blended (never additive, which saturates to white). */
const CORE_OPACITY = 0.92;
/** Points on the far side of the scene fade towards this fraction of their alpha (gentle: far points stay readable). */
const DEPTH_FADE_MIN = 0.7;
/**
 * The point sprite is HALO disc diameters wide: the disc is drawn inside it, and a hub's soft glow
 * (and a status ring) fill the margin. The fragment shader works in the same units.
 */
const HALO = 1.8;
/** Pick radius in CSS pixels: the ray's threshold grows with the camera distance, so a node is hit at any zoom. */
const PICK_RADIUS_PX = 8;
/** The code brain's core fills this fraction of the stage's shorter side on framing; the ring may extend past the edges. */
const CORE_FRAME_FRACTION = 0.7;
/**
 * The OS graph's parts fill this fraction of the stage's shorter side (the screen extent of the
 * hubs, measured on screen: see fitDistance). 0.82 leaves room for the hub discs and labels at the edge.
 */
const VIZ_FILL = 0.82;
/** Light theme: normal blending needs a little more alpha to read on white. */
const LIGHT_POINT_BOOST = 1.25;
/** Ring points (the code brain's activity ring), in CSS pixels. */
const RING_POINT_SIZE = 7;
const RING_RGB: Record<OrbitTheme, [number, number, number]> = {
  dark: [0.96, 0.97, 1],
  light: [0.2, 0.24, 0.32],
};
const LINE_STYLE = {
  edge: {
    dark: { color: 0x8a93a6, opacity: 0.11 },
    light: { color: 0x3d4454, opacity: 0.22 },
  },
  /** The OS graph's edges: the colour is per vertex (the hub-hue mix), so the material is white. */
  vizEdge: {
    dark: { color: 0xffffff, opacity: 1 },
    light: { color: 0xffffff, opacity: 1 },
  },
  ring: {
    dark: { color: 0xffffff, opacity: 0.25 },
    light: { color: 0x3d4454, opacity: 0.35 },
  },
} as const;
const CLICK_SLOP_PX = 4;
const MAX_FRAME_DT = 0.1;
/** Hover is re-resolved at most this often while the view moves under the pointer. */
const REPICK_INTERVAL_MS = 150;
/** Framing: camera looking slightly down. */
const FRAME_ELEVATION = 0.35;
/**
 * The OS level looks down more steeply: the hub ring is a circle in the XZ plane, so at the code
 * brain's elevation it would read as a thin band, and neighbouring hubs would fall on each other.
 */
const VIZ_FRAME_ELEVATION = 0.9;
/** The camera is re-framed when the core's node count moves by more than this fraction. */
const REFRAME_CHANGE_RATIO = 0.2;
/** Zoom limits as multiples of the layout radius. The near limit reaches one part's members. */
const MIN_DISTANCE_RATIO = 0.12;
const MAX_DISTANCE_RATIO = 6;
/** Distance of the camera from a focused node, in layout radii. */
const FOCUS_DISTANCE_RATIO = 1;
const FOCUS_MS = 400;
/** One turn of the camera auto-rotation, in seconds. */
const AUTO_ROTATE_TURN_S = 40;
/** Auto-rotation resumes this long after the user stops interacting. */
const RESUME_MS = 4000;
const ZOOM_STEP = 1.25;
/** Selection look: the selected node is larger and the neighbours a little larger; everything else dims to DIM_ALPHA. */
const DIM_ALPHA = 0.15;
const HIGHLIGHT_SIZE = 1.4;
const NEIGHBOUR_SIZE = 1.2;
/** Edge alphas on selection/hover: the edges touching the node go to EDGE_HOT (absolute); the rest of a selection's edges are multiplied by EDGE_DIM. */
const EDGE_HOT = 0.9;
const EDGE_DIM = 0.25;

const VERTEX_SHADER = `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
attribute vec3 aEdge;
attribute vec4 aRing;
attribute float aGlow;
uniform float uPixelRatio;
uniform float uHalo;
uniform vec2 uDepth;
varying vec3 vColor;
varying vec3 vEdge;
varying vec4 vRing;
varying float vGlow;
varying float vAlpha;
varying float vFade;
varying float vRingIn;
varying float vRingW;
void main() {
  vColor = aColor;
  vEdge = aEdge;
  vRing = aRing;
  vGlow = aGlow;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // Sizes are CSS pixels (the disc's diameter); the sprite is HALO times wider for the glow and ring.
  gl_PointSize = clamp(aSize * uHalo * uPixelRatio, 1.0, 256.0);
  // The status ring sits 1.5 px outside the disc and is 1.8 px wide, whatever the disc's size (in disc radii).
  float radius = max(aSize * uPixelRatio * 0.5, 1.0);
  vRingIn = 1.0 + 1.5 * uPixelRatio / radius;
  vRingW = 1.8 * uPixelRatio / radius;
  // Depth fade: the far side of the scene is dimmer, so the near side reads as the front of the cluster.
  float t = clamp((-mv.z - uDepth.x) / max(uDepth.y - uDepth.x, 1e-6), 0.0, 1.0);
  vFade = 1.0 - (1.0 - ${DEPTH_FADE_MIN.toFixed(2)}) * t;
}
`;

const FRAGMENT_SHADER = `
uniform float uOpacity;
uniform float uHalo;
varying vec3 vColor;
varying vec3 vEdge;
varying vec4 vRing;
varying float vGlow;
varying float vAlpha;
varying float vFade;
varying float vRingIn;
varying float vRingW;
void main() {
  // 1 at the disc's edge, uHalo at the sprite's edge.
  float t = length(gl_PointCoord - vec2(0.5)) * 2.0 * uHalo;
  if (t > uHalo) discard;
  float disc = 1.0 - smoothstep(0.96, 1.0, t);
  // The outline: the disc's outer band takes the outline shade (lighter for a hub, darker otherwise).
  float rim = smoothstep(0.82, 0.92, t) * disc;
  vec3 fill = mix(vColor, vEdge, rim);
  // The status ring: a band just outside the disc.
  float ring = vRing.a * smoothstep(vRingIn - 0.04, vRingIn, t) * (1.0 - smoothstep(vRingIn + vRingW - 0.04, vRingIn + vRingW, t));
  // A hub's soft glow: outside the disc, fading to nothing at the sprite's edge.
  float glow = vGlow * 0.4 * step(1.0, t) * (1.0 - smoothstep(1.0, uHalo, t));
  float a = max(disc, max(ring, glow));
  vec3 rgb = (fill * disc + vRing.rgb * ring + vColor * glow) / max(a, 1e-4);
  gl_FragColor = vec4(rgb, a * uOpacity * vAlpha * vFade);
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

/** The OS graph's node label: a text element pinned to a point of the scene. */
interface VizLabel {
  el: HTMLElement;
  pos: THREE.Vector3;
  /** Index of the node in the drawn graph, and its text, size and kind (for the placement). */
  index: number;
  text: string;
  size: number;
  kind: string;
  labelled: boolean;
}

/** Extra labels a close camera adds: this many of the largest members per group, faded in by distance. */
const EXTRA_LABELS_PER_GROUP = 3;
/** Camera distance, as a multiple of the scene radius, at which the extra labels are full (near) or gone (far). */
const EXTRA_NEAR_RATIO = 0.6;
const EXTRA_FAR_RATIO = 1.5;
/** Below this opacity the extra labels are not candidates. */
const EXTRA_MIN_OPACITY = 0.05;

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
  private readonly onActivate?: (item: OrbitPick) => void;
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
  /** The halo factor of every point material (HALO in the shaders). */
  private readonly haloUniform = { value: HALO };
  /** Depth range (near, far) of the scene from the camera, shared by every point material. */
  private readonly depthUniform = { value: new THREE.Vector2(1, 2) };
  private readonly pointMaterials = new Set<THREE.ShaderMaterial>();
  private readonly lineMaterials = new Set<THREE.LineBasicMaterial>();
  /** Which graph the core group holds: the project's code graph, or the OS graph (VizGraph). */
  private mode: "code" | "viz" = "code";
  private vizGraph: VizGraph | null = null;
  /** The OS graph's nodes in core index order (first occurrence per id). */
  private vizNodes: VizNode[] | null = null;
  /** Per core node: its base alpha (off nodes are quiet) and its selection factor. */
  private baseAlpha: Float32Array = new Float32Array(0);
  private selAlpha: Float32Array = new Float32Array(0);
  /** Per drawn edge: its alpha by weight (the selection multiplies it). */
  private edgeBase: Float32Array = new Float32Array(0);
  /** Core indexes of the running nodes of the OS graph: their alpha pulses. */
  private pulsing: number[] = [];
  /** The OS graph's labelled nodes, drawn as HTML text over the canvas. */
  private labelLayer: HTMLElement | null = null;
  private labels: VizLabel[] = [];
  private labelByIndex = new Map<number, VizLabel>();
  /** Node indices that may get a label when the camera is close (see EXTRA_LABELS_PER_GROUP). */
  private extraIndices: number[] = [];
  /** The node under the pointer, as a drawn index (viz mode), or null. Its edges light up. */
  private hoverIndex: number | null = null;
  /** How far the extra labels are faded in, 0 (far) to 1 (close). */
  private extraFade = 0;
  /** The label set changed (hover, selection, graph): the next updateLabels places them again. */
  private labelVersion = 0;
  private lastLabelVersion = -1;
  private readonly lastMatrix = new Float64Array(16);
  private lastStageW = -1;
  private lastStageH = -1;
  /** The stage size, measured in resize(): updateLabels does not read the DOM per frame. */
  private stageW = 1;
  private stageH = 1;
  /** The level and node ids of the drawn viz (see vizLevelSignature): the same signature keeps the camera. */
  private vizSignature: string | null = null;
  private readonly pixelRatioUniform = { value: 1 };
  /** Labelled edges of the OS graph: hover-only, found by a line raycast. */
  private labelledEdges: VizEdge[] = [];
  private labelEdgeObj: THREE.LineSegments | null = null;
  private readonly labelScratch = new THREE.Vector3();
  /** Time of the last frame (ms). The pulse of running nodes reads it. */
  private lastNow = 0;

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
  /** Per node: 1 for a hub (a lighter outline and a glow), 0 otherwise. */
  private hubMask: Uint8Array = new Uint8Array(0);
  /** Per node: 1 when it has a status ring (the ring's alpha pulses for a running node). */
  private baseRing: Float32Array = new Float32Array(0);
  /** Per node: the status ring colour (rgb, 0..1). */
  private ringRgb: Float32Array = new Float32Array(0);
  private coreRingAttr: THREE.BufferAttribute | null = null;
  private coreEdgeAttr: THREE.BufferAttribute | null = null;
  /** Per drawn OS edge: whether it is a hub-member edge (its colour is the member's). */
  private edgeMember: boolean[] = [];
  /** The node positions the OS framing fits on screen. */
  private fitPoints: Vec3[] = [];
  /** The level of the drawn OS graph: it colours a hub node that has no drill key. */
  private vizLevel: string | null = null;
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
  /** Zoom and clip scale: the core and the ring together. */
  private radius = 1;
  /** Radius of the core's own nodes (no ring): what framing fits. */
  private coreRadius = 0;
  /** Core node count at the last framing, or null before the first framing. */
  private framedCoreCount: number | null = null;
  private ringCount = 0;

  private selectedId: string | null = null;
  private selection: SelectionRef | null = null;

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
    this.onActivate = opts.onActivate;
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
      "Project brain. Drag to orbit, scroll or pinch to zoom. Click a node to select it; double-click a hub to open its part. Keys: plus and minus zoom, 0 resets the view, space pauses the rotation.",
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
    // The OS graph's labels sit over the canvas and take no pointer events (the canvas keeps them).
    const layer = document.createElement("div");
    layer.className = "orbit-labels";
    Object.assign(layer.style, { position: "absolute", top: "0", right: "0", bottom: "0", left: "0", overflow: "hidden", pointerEvents: "none" });
    container.appendChild(layer);
    this.labelLayer = layer;
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
    // Arm the first frame now: without it the canvas stays blank until something else asks for a render.
    this.requestRender();
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
    if (graph === this.graph && layout === this.layout && this.mode === "code") return;
    this.clearCore();
    this.enterMode("code");
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
    this.hubMask = new Uint8Array(pts.ids.length);
    this.baseRing = new Float32Array(pts.ids.length);
    this.ringRgb = new Float32Array(pts.ids.length * 3);
    this.coreRadius = coreFramingRadius(
      nodes.map((n) => n.id),
      layout,
    );
    this.kindRgb = buildCategoryColors(this.coreItems, this.categoryColors);
    this.clusterRgb = buildClusterColors(this.coreItems, this.clusterPalette);
    if (pts.ids.length > 0) this.addCorePoints(pts.positions);

    this.baseAlpha = new Float32Array(this.coreItems.length).fill(1);
    this.selAlpha = new Float32Array(this.coreItems.length).fill(1);
    const edges = buildEdgeData(graph, layout, this.coreIndex);
    this.edgeEnds = edges.ends;
    this.edgeBase = new Float32Array(edges.ends.length / 2).fill(1);
    if (edges.positions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(edges.positions, 3));
      // One rgba per vertex: rgb stays white (the material colour is the theme's), alpha is the highlight multiplier.
      this.edgeColorAttr = new THREE.BufferAttribute(new Float32Array(edges.ends.length * 4).fill(1), 4);
      geo.setAttribute("color", this.edgeColorAttr);
      this.coreGroup.add(new THREE.LineSegments(geo, this.makeLineMaterial("edge")));
    }

    this.recomputeRadius();
    this.applyZoomLimits();
    this.setHover(null);
    this.applySelection();
    this.frameCore();
    this.updateLabels();
    this.requestRender();
  }

  /**
   * Replace the core with the OS graph (a VizGraph) and its layout: one point per node (coloured
   * by kind with its status, or by group), the edges by weight, and HTML labels for the labelled
   * nodes. Running nodes pulse. The ring is hidden. Calling again with the same objects is a
   * no-op. The camera is re-framed on the graph; a caller restores a remembered pose after.
   */
  setViz(viz: VizGraph, layout: OrbitLayout): void {
    if (!this.renderer || this.disposed) return;
    if (viz === this.vizGraph && layout === this.layout && this.mode === "viz") return;
    // The same level with the same nodes is a live refresh: the camera stays where the user left it.
    const signature = vizLevelSignature(viz);
    const sameView = this.mode === "viz" && signature === this.vizSignature;
    this.clearCore();
    this.enterMode("viz");
    this.vizGraph = viz;
    this.vizLevel = viz.level;
    this.layout = layout;
    this.vizSignature = signature;

    // Nodes in order, first occurrence per id; the core index of a node is its place here.
    const seen = new Set<string>();
    const nodes: VizNode[] = [];
    for (const node of viz.nodes) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      nodes.push(node);
    }
    this.vizNodes = nodes;
    this.coreItems = nodes.map((n) => ({ id: n.id, label: n.label || n.id, category: "other", community: n.group }));
    this.coreIndex = new Map(this.coreItems.map((c, i) => [c.id, i]));
    const n = nodes.length;
    this.adjacency = this.coreItems.map(() => []);

    const stageMin = Math.min(this.stageW, this.stageH);
    const positions = new Float32Array(n * 3);
    this.baseSizes = new Float32Array(n);
    this.baseAlpha = new Float32Array(n);
    this.selAlpha = new Float32Array(n).fill(1);
    this.hubMask = new Uint8Array(n);
    this.baseRing = new Float32Array(n);
    const pulsing: number[] = [];
    nodes.forEach((node, i) => {
      const p = layout.core.get(node.id) ?? { x: 0, y: 0, z: 0 };
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      this.baseSizes[i] = vizNodePx(node, stageMin);
      this.baseAlpha[i] = vizNodeAlpha(node);
      this.hubMask[i] = node.kind === "hub" ? 1 : 0;
      this.baseRing[i] = statusRing(node.status, this.theme) ? 1 : 0;
      if (node.status === "running") pulsing.push(i);
    });
    this.pulsing = pulsing;
    this.fitPoints = nodes.map((node) => layout.core.get(node.id) ?? { x: 0, y: 0, z: 0 });
    this.kindRgb = buildVizKindColors(nodes, this.theme, viz.level);
    this.clusterRgb = buildClusterColors(this.coreItems, this.clusterPalette);
    this.ringRgb = this.buildRingRgb();
    this.coreRadius = vizFramingRadius(nodes, layout);

    if (n > 0) this.addCorePoints(positions);

    // Edges: both ends must be drawn nodes. Kept in graph order so each drawn edge maps to its VizEdge.
    const drawn: VizEdge[] = [];
    for (const edge of viz.edges) {
      const a = this.coreIndex.get(edge.source);
      const b = this.coreIndex.get(edge.target);
      if (a === undefined || b === undefined || a === b) continue;
      if (!layout.core.has(edge.source) || !layout.core.has(edge.target)) continue;
      this.adjacency[a]!.push(b);
      this.adjacency[b]!.push(a);
      drawn.push(edge);
    }
    const ends = new Uint32Array(drawn.length * 2);
    const edgePositions = new Float32Array(drawn.length * 6);
    const alphas = vizEdgeAlphas(drawn.map((e) => e.weight));
    this.edgeMember = drawn.map((e) => e.kind === "member");
    drawn.forEach((edge, k) => {
      const a = this.coreIndex.get(edge.source)!;
      const b = this.coreIndex.get(edge.target)!;
      const pa = layout.core.get(edge.source)!;
      const pb = layout.core.get(edge.target)!;
      edgePositions.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], k * 6);
      ends[k * 2] = a;
      ends[k * 2 + 1] = b;
      if (edge.kind === "member") alphas[k] = MEMBER_EDGE_ALPHA;
    });
    this.edgeEnds = ends;
    this.edgeBase = alphas;
    if (drawn.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
      // One rgba per vertex: the rgb is the hub-hue colour of the edge (writeVizEdgeRgb), the alpha the highlight and weight.
      this.edgeColorAttr = new THREE.BufferAttribute(new Float32Array(drawn.length * 2 * 4).fill(1), 4);
      geo.setAttribute("color", this.edgeColorAttr);
      this.coreGroup.add(new THREE.LineSegments(geo, this.makeLineMaterial("vizEdge")));
      this.writeVizEdgeRgb();
    }

    // Labelled edges: a transparent line set for the hover raycast only (their label shows in the tooltip).
    const labelled = drawn.filter((e) => typeof e.label === "string" && e.label !== "");
    this.labelledEdges = labelled;
    if (labelled.length > 0) {
      const pos = new Float32Array(labelled.length * 6);
      labelled.forEach((edge, k) => {
        const pa = layout.core.get(edge.source)!;
        const pb = layout.core.get(edge.target)!;
        pos.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], k * 6);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
      this.labelEdgeObj = new THREE.LineSegments(geo, mat);
      this.coreGroup.add(this.labelEdgeObj);
    }

    this.buildVizLabels(nodes, layout);
    this.ringGroup.visible = false;
    this.recomputeRadius();
    this.applyZoomLimits();
    this.setHover(null);
    this.applySelection();
    this.framedCoreCount = n;
    // A new level frames its own content; the caller restores a remembered pose afterwards. A refresh of the same level keeps the camera.
    if (!sameView) this.fitCamera();
    this.updateLabels();
    this.requestRender();
  }

  /** The camera as plain numbers (what a level remembers), or null without WebGL. */
  getCamera(): CameraPose | null {
    if (!this.renderer || this.disposed) return null;
    this.settleTween();
    const p = this.camera.position;
    const t = this.controls.target;
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
  }

  /** Puts the camera at a remembered pose. Finite values only; anything else is ignored. */
  setCamera(pose: CameraPose): void {
    if (!this.renderer || this.disposed) return;
    const vals = [...pose.position, ...pose.target];
    if (vals.length !== 6 || !vals.every((v) => Number.isFinite(v))) return;
    this.cancelTween();
    const c = this.controls;
    // Flush the damping residue first, as resetView does, so a leftover move does not land on the pose.
    c.enableDamping = false;
    c.update(0);
    c.enableDamping = true;
    this.camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
    c.target.set(pose.target[0], pose.target[1], pose.target[2]);
    this.userMoved = true;
    c.update(0);
    this.updateLabels();
    this.requestRender();
  }

  /** Switches the core between the code graph and the OS graph: the ring shows only in the code graph. */
  private enterMode(mode: "code" | "viz"): void {
    // A switch of graph kind frames the camera again: the code graph's framing count starts over.
    if (this.mode !== mode) this.framedCoreCount = null;
    this.mode = mode;
    this.ringGroup.visible = mode === "code";
  }

  /** The radius framing and zoom use: the core, and in the code graph also the ring. */
  private recomputeRadius(): void {
    this.radius = Math.max(this.coreRadius, this.mode === "code" ? this.ringRadius : 0, 1);
  }

  /**
   * The OS graph's labels: one HTML element per labelled node, created now and placed by
   * updateLabels(). Other nodes get an element on demand (hover, selection, a close camera).
   */
  private buildVizLabels(nodes: VizNode[], layout: OrbitLayout): void {
    this.removeVizLabels();
    this.extraIndices = extraLabelIndices(nodes, EXTRA_LABELS_PER_GROUP);
    nodes.forEach((node, i) => {
      if (node.labelled) this.labelFor(i, nodes, layout);
    });
    this.labelVersion++;
  }

  /** The label element of a drawn node, created on first use. Null without a label layer. */
  private labelFor(index: number, nodes: VizNode[], layout: OrbitLayout): VizLabel | null {
    const have = this.labelByIndex.get(index);
    if (have) return have;
    const layer = this.labelLayer;
    const node = nodes[index];
    if (!layer || !node) return null;
    const el = document.createElement("div");
    el.className = "orbit-label";
    el.textContent = node.label || node.id;
    this.styleLabel(el, node.kind === "hub");
    Object.assign(el.style, {
      position: "absolute",
      left: "0",
      top: "0",
      whiteSpace: "nowrap",
      pointerEvents: "none",
      display: "none",
    });
    layer.appendChild(el);
    const p = layout.core.get(node.id) ?? { x: 0, y: 0, z: 0 };
    const label: VizLabel = {
      el,
      pos: new THREE.Vector3(p.x, p.y, p.z),
      index,
      text: node.label || node.id,
      size: node.size,
      kind: node.kind,
      labelled: node.labelled,
    };
    this.labels.push(label);
    this.labelByIndex.set(index, label);
    return label;
  }

  private removeVizLabels(): void {
    for (const label of this.labels) label.el.remove();
    this.labels = [];
    this.labelByIndex = new Map();
  }

  /**
   * Places the labels. Candidates: the labelled nodes (hubs first), the hovered and selected
   * nodes, and, when the camera is close, the largest members of each group (faded in by
   * distance). The candidates are chosen by pickLabels so no two drawn labels overlap; the rest
   * stay in the DOM with visibility hidden. Runs only when the camera, the stage size or the
   * label set changed since the last placement.
   */
  private updateLabels(): void {
    if (this.mode !== "viz" || !this.renderer || this.disposed || !this.vizNodes) return;
    if (this.labels.length === 0 && this.extraIndices.length === 0 && this.hoverIndex === null && this.selection === null) return;
    this.camera.updateMatrixWorld();
    const m = this.camera.matrixWorld.elements;
    let same = this.lastLabelVersion === this.labelVersion && this.lastStageW === this.stageW && this.lastStageH === this.stageH;
    if (same) {
      for (let i = 0; i < 16; i++) {
        if (m[i] !== this.lastMatrix[i]) {
          same = false;
          break;
        }
      }
    }
    if (same) return;
    this.lastLabelVersion = this.labelVersion;
    this.lastStageW = this.stageW;
    this.lastStageH = this.stageH;
    for (let i = 0; i < 16; i++) this.lastMatrix[i] = m[i] ?? 0;

    const nodes = this.vizNodes;
    const layout = this.layout;
    if (layout) {
      // Close camera: the extra labels fade in. Zoomed out, they are not candidates at all.
      const near = this.radius * EXTRA_NEAR_RATIO;
      const far = this.radius * EXTRA_FAR_RATIO;
      const d = this.distance();
      const fade = THREE.MathUtils.clamp((far - d) / Math.max(far - near, 1e-6), 0, 1);
      if (fade > EXTRA_MIN_OPACITY) {
        for (const i of this.extraIndices) this.labelFor(i, nodes, layout);
      }
      this.extraFade = fade;
    }

    const focus = new Set<number>();
    if (this.hoverIndex !== null) focus.add(this.hoverIndex);
    if (this.selection?.kind === "core") focus.add(this.selection.index);
    for (const i of focus) if (layout) this.labelFor(i, nodes, layout);

    const cands: LabelCandidate[] = [];
    const placed = new Map<VizLabel, { x: number; y: number; opacity: number }>();
    for (const label of this.labels) {
      const isExtra = !label.labelled && !focus.has(label.index);
      let priority: number;
      let opacity = 1;
      if (isExtra) {
        if (!this.extraIndices.includes(label.index) || this.extraFade <= EXTRA_MIN_OPACITY) continue;
        priority = 0.5;
        opacity = this.extraFade;
      } else if (focus.has(label.index)) priority = 2;
      else priority = label.kind === "hub" ? 3 : 1;
      const s = this.labelScratch.copy(label.pos);
      if (!(s.applyMatrix4(this.camera.matrixWorldInverse).z < 0)) continue;
      this.labelScratch.copy(label.pos).project(this.camera);
      const x = ((this.labelScratch.x + 1) / 2) * this.stageW;
      const y = ((1 - this.labelScratch.y) / 2) * this.stageH;
      if (x < -this.stageW || x > 2 * this.stageW || y < -this.stageH || y > 2 * this.stageH) continue;
      // The label sits above its disc: its anchor is the disc's top edge, plus a gap.
      const hub = label.kind === "hub";
      const radius = (this.baseSizes[label.index] ?? 12) / 2;
      const ly = y - radius - 6;
      const w = labelWidth(label.text, hub);
      const h = hub ? HUB_LABEL_HEIGHT_PX : LABEL_HEIGHT_PX;
      cands.push({ id: String(label.index), x, y: ly, w, h, priority, size: label.size });
      placed.set(label, { x, y: ly, opacity });
    }
    const kept = pickLabels(cands);

    for (const label of this.labels) {
      const p = placed.get(label);
      const el = label.el;
      if (!p) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "";
      el.style.visibility = kept.has(String(label.index)) ? "visible" : "hidden";
      el.style.opacity = p.opacity.toFixed(2);
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
    }
  }

  /** Quiets or lights the hub-member and other edges for the selection (dims the rest) or the hover. */
  private applyEdgeAlphas(): void {
    const attr = this.edgeColorAttr;
    if (!attr) return;
    const rgba = attr.array as Float32Array;
    const ends = this.edgeEnds;
    const sel = this.selection;
    const dimming = sel?.kind === "core";
    const focus = dimming ? sel.index : this.mode === "viz" ? this.hoverIndex : null;
    for (let k = 0; k < ends.length / 2; k++) {
      const base = this.edgeBase[k] ?? 1;
      let alpha = base;
      if (focus !== null) {
        const touching = ends[k * 2] === focus || ends[k * 2 + 1] === focus;
        alpha = touching ? EDGE_HOT : dimming ? base * EDGE_DIM : base;
      }
      rgba[(k * 2) * 4 + 3] = alpha;
      rgba[(k * 2 + 1) * 4 + 3] = alpha;
    }
    attr.needsUpdate = true;
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
      geo.setAttribute("aEdge", new THREE.BufferAttribute(rgb.slice(), 3));
      geo.setAttribute("aRing", new THREE.BufferAttribute(new Float32Array(count * 4), 4));
      geo.setAttribute("aGlow", new THREE.BufferAttribute(new Float32Array(count), 1));
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
    this.recomputeRadius();
    this.applyZoomLimits();
    this.applySelection();
    this.frameCore();
    this.updateLabels();
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
    // The flight owns the camera: no auto-rotation during it, and for RESUME_MS after it ends (see stepTween).
    this.interacting = true;
    this.clearResume();
    this.updateAutoRotate();
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
    this.cancelTween();
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
    for (const label of this.labels) this.styleLabel(label.el, label.kind === "hub");
    if (this.ringColorAttr) {
      const [r, g, b] = RING_RGB[next];
      const arr = this.ringColorAttr.array as Float32Array;
      for (let i = 0; i + 2 < arr.length; i += 3) {
        arr[i] = r;
        arr[i + 1] = g;
        arr[i + 2] = b;
      }
      this.ringColorAttr.needsUpdate = true;
      const edgeAttr = this.ringPoints?.geometry.getAttribute("aEdge") as THREE.BufferAttribute | undefined;
      if (edgeAttr) {
        (edgeAttr.array as Float32Array).set(arr);
        edgeAttr.needsUpdate = true;
      }
    }
    this.refreshPalettes();
    this.requestRender();
  }

  /** Re-measure the container. Re-frames the camera unless the user has moved it. */
  resize(): void {
    if (!this.renderer || this.disposed) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.stageW = w;
    this.stageH = h;
    this.renderer.setSize(w, h, false);
    const pr = this.renderer.getPixelRatio();
    this.pixelRatioUniform.value = pr;
    this.camera.aspect = w / h;
    if (this.mode === "viz") this.applyVizSizes();
    if (this.userMoved) this.camera.updateProjectionMatrix();
    else this.fitCamera();
    this.updateLabels();
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
    this.labelLayer?.remove();
    this.labelLayer = null;
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
      uniforms: {
        uHalo: this.haloUniform,
        uPixelRatio: this.pixelRatioUniform,
        uDepth: this.depthUniform,
        uOpacity: { value: opacity },
      },
      transparent: true,
      depthWrite: false,
    });
    mat.userData.baseOpacity = opacity;
    this.pointMaterials.add(mat);
    this.stylePointMaterial(mat);
    return mat;
  }

  private stylePointMaterial(mat: THREE.ShaderMaterial): void {
    // Normal blending on both themes: additive points saturate to white where they overlap and hide the colours.
    const light = this.theme === "light";
    const base = mat.userData.baseOpacity as number;
    mat.blending = THREE.NormalBlending;
    mat.uniforms.uOpacity.value = light ? Math.min(1, base * LIGHT_POINT_BOOST) : base;
    mat.needsUpdate = true;
  }

  private makeLineMaterial(kind: "edge" | "vizEdge" | "ring"): THREE.LineBasicMaterial {
    const mat = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false, vertexColors: kind !== "ring" });
    mat.userData.lineKind = kind;
    this.lineMaterials.add(mat);
    this.styleLineMaterial(mat);
    return mat;
  }

  private styleLineMaterial(mat: THREE.LineBasicMaterial): void {
    const kind = mat.userData.lineKind as "edge" | "vizEdge" | "ring";
    const style = LINE_STYLE[kind][this.theme];
    mat.color.setHex(style.color);
    mat.opacity = style.opacity;
  }

  /**
   * Frames the camera on the scene: the core fills CORE_FRAME_FRACTION of the shorter
   * side of the stage (the ring may run past the edges), the orbit centre is the origin.
   */
  private fitCamera(): void {
    const vHalf = THREE.MathUtils.degToRad(FOV_DEG) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const half = Math.min(vHalf, hHalf);
    const framed = this.coreItems.length > 0 ? Math.max(this.coreRadius, 1) : Math.max(this.ringRadius, 1);
    const viz = this.mode === "viz";
    const elevation = viz ? VIZ_FRAME_ELEVATION : FRAME_ELEVATION;
    const n = Math.hypot(elevation, 1);
    const dir = { x: 0, y: elevation / n, z: 1 / n };
    let dist = framed / (CORE_FRAME_FRACTION * Math.tan(half));
    // The OS graph is framed on what it draws: its parts, measured on screen, fill VIZ_FILL of the stage.
    if (viz && this.fitPoints.length > 0) {
      dist = fitDistance(this.fitPoints, dir, { x: 0, y: 0, z: 0 }, Math.tan(vHalf), this.camera.aspect, VIZ_FILL, dist);
    }
    this.home = {
      position: new THREE.Vector3(0, dir.y * dist, dir.z * dist),
      target: new THREE.Vector3(0, 0, 0),
    };
    this.camera.position.copy(this.home.position);
    this.controls.target.copy(this.home.target);
    this.camera.lookAt(0, 0, 0);
    this.applyZoomLimits();
    this.camera.near = Math.max(1e-3, this.radius * 0.01);
    this.camera.far = Math.max(dist * 5, this.radius * 20);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.userMoved = false;
    this.cancelTween();
  }

  /** Zoom bounds as multiples of the scene radius (core and ring). Recomputed whenever the radius changes. */
  private applyZoomLimits(): void {
    this.controls.minDistance = Math.max(this.radius * MIN_DISTANCE_RATIO, 1e-3);
    this.controls.maxDistance = Math.max(this.radius * MAX_DISTANCE_RATIO, this.controls.minDistance * 2);
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
    this.removeVizLabels();
    this.vizSignature = null;
    this.extraIndices = [];
    this.hoverIndex = null;
    this.labelEdgeObj = null;
    this.labelledEdges = [];
    this.vizGraph = null;
    this.vizNodes = null;
    this.pulsing = [];
    this.baseAlpha = new Float32Array(0);
    this.selAlpha = new Float32Array(0);
    this.edgeBase = new Float32Array(0);
    this.corePoints = null;
    this.coreColorAttr = null;
    this.coreSizeAttr = null;
    this.coreAlphaAttr = null;
    this.edgeColorAttr = null;
    this.coreRingAttr = null;
    this.coreEdgeAttr = null;
    this.hubMask = new Uint8Array(0);
    this.baseRing = new Float32Array(0);
    this.ringRgb = new Float32Array(0);
    this.edgeMember = [];
    this.fitPoints = [];
    this.vizLevel = null;
    this.coreItems = [];
    this.coreIndex = new Map();
    this.adjacency = [];
    this.edgeEnds = new Uint32Array(0);
    this.kindRgb = new Float32Array(0);
    this.clusterRgb = new Float32Array(0);
    this.baseSizes = new Float32Array(0);
    this.coreRadius = 0;
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
    // The OS graph is always coloured by its parts; only the code brain takes the cluster colours.
    return this.mode === "code" && this.colorMode === "cluster" ? this.clusterRgb : this.kindRgb;
  }

  private writeCoreColors(): void {
    const attr = this.coreColorAttr;
    if (!attr) return;
    const arr = attr.array as Float32Array;
    const src = this.activeCoreColors();
    if (src.length !== arr.length) return;
    arr.set(src);
    attr.needsUpdate = true;
    this.writeEdgeShades();
  }

  /** Re-reads the category and cluster palettes (CSS custom properties) and recolours the core in place. */
  private refreshPalettes(): void {
    if (!this.fixedCategoryColors) this.categoryColors = readCategoryColors();
    this.clusterPalette = readClusterPalette();
    if (this.coreItems.length === 0) return;
    if (this.mode === "viz" && this.vizNodes) {
      this.kindRgb = buildVizKindColors(this.vizNodes, this.theme, this.vizLevel);
      this.ringRgb = this.buildRingRgb();
      for (const label of this.labels) this.styleLabel(label.el, label.kind === "hub");
    } else {
      this.kindRgb = buildCategoryColors(this.coreItems, this.categoryColors);
    }
    this.clusterRgb = buildClusterColors(this.coreItems, this.clusterPalette);
    this.writeCoreColors();
    this.writeVizEdgeRgb();
    this.writeRingRgb();
  }

  /**
   * The core's point buffers from `positions` and the current per-node state (sizes, colours,
   * hub mask, status rings): one Points object, drawn over the edges.
   */
  private addCorePoints(positions: Float32Array): void {
    const n = positions.length / 3;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const colours = this.activeCoreColors();
    this.coreColorAttr = new THREE.BufferAttribute(new Float32Array(colours), 3);
    geo.setAttribute("aColor", this.coreColorAttr);
    this.coreEdgeAttr = new THREE.BufferAttribute(buildEdgeShades(colours, this.hubMask), 3);
    geo.setAttribute("aEdge", this.coreEdgeAttr);
    this.coreSizeAttr = new THREE.BufferAttribute(new Float32Array(this.baseSizes), 1);
    geo.setAttribute("aSize", this.coreSizeAttr);
    this.coreAlphaAttr = new THREE.BufferAttribute(new Float32Array(n).fill(1), 1);
    geo.setAttribute("aAlpha", this.coreAlphaAttr);
    const ring = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      ring[i * 4] = this.ringRgb[i * 3] ?? 0;
      ring[i * 4 + 1] = this.ringRgb[i * 3 + 1] ?? 0;
      ring[i * 4 + 2] = this.ringRgb[i * 3 + 2] ?? 0;
      ring[i * 4 + 3] = this.baseRing[i] ?? 0;
    }
    this.coreRingAttr = new THREE.BufferAttribute(ring, 4);
    geo.setAttribute("aRing", this.coreRingAttr);
    geo.setAttribute("aGlow", new THREE.BufferAttribute(Float32Array.from(this.hubMask), 1));
    this.corePoints = new THREE.Points(geo, this.makePointMaterial(CORE_OPACITY));
    this.coreGroup.add(this.corePoints);
  }

  /** Each OS node's status ring colour (rgb, 0..1) in the current theme; a node without a ring keeps black. */
  private buildRingRgb(): Float32Array {
    const nodes = this.vizNodes ?? [];
    const out = new Float32Array(nodes.length * 3);
    nodes.forEach((node, i) => {
      const ring = statusRing(node.status, this.theme);
      if (ring) out.set(hexToRgb01(ring.hex), i * 3);
    });
    return out;
  }

  /** Writes the status ring colours into the core's ring attribute (rgb only; alpha is set per frame). */
  private writeRingRgb(): void {
    const attr = this.coreRingAttr;
    if (!attr) return;
    const arr = attr.array as Float32Array;
    for (let i = 0; i * 4 + 2 < arr.length && i * 3 + 2 < this.ringRgb.length; i++) {
      arr[i * 4] = this.ringRgb[i * 3]!;
      arr[i * 4 + 1] = this.ringRgb[i * 3 + 1]!;
      arr[i * 4 + 2] = this.ringRgb[i * 3 + 2]!;
    }
    attr.needsUpdate = true;
  }

  /** Writes the outline shade of every core point from its fill (a hub's is lighter, the rest darker). */
  private writeEdgeShades(): void {
    const attr = this.coreEdgeAttr;
    if (!attr) return;
    const shades = buildEdgeShades(this.activeCoreColors(), this.hubMask);
    if (shades.length !== (attr.array as Float32Array).length) return;
    (attr.array as Float32Array).set(shades);
    attr.needsUpdate = true;
  }

  /** Writes each drawn OS edge's rgb: a member edge takes its member's colour, a cross-part edge the mix of its ends. */
  private writeVizEdgeRgb(): void {
    const attr = this.edgeColorAttr;
    if (!attr || this.mode !== "viz") return;
    const arr = attr.array as Float32Array;
    const edges = this.edgeEnds.length / 2;
    if (this.kindRgb.length === 0 || arr.length !== edges * 8) return;
    const colours = buildVizEdgeColors(this.edgeEnds, this.kindRgb, this.hubMask, this.edgeMember);
    for (let k = 0; k < edges; k++) {
      for (let v = 0; v < 2; v++) {
        const o = (k * 2 + v) * 4;
        arr[o] = colours[k * 6 + v * 3]!;
        arr[o + 1] = colours[k * 6 + v * 3 + 1]!;
        arr[o + 2] = colours[k * 6 + v * 3 + 2]!;
      }
    }
    attr.needsUpdate = true;
  }

  /**
   * The OS graph's point sizes for the stage: hubs and members in CSS pixels, scaled to the stage's
   * shorter side (see vizNodePx). Written in place, so a resize does not rebuild the points.
   */
  private applyVizSizes(): void {
    const nodes = this.vizNodes;
    if (this.mode !== "viz" || !nodes || nodes.length !== this.baseSizes.length) return;
    const stageMin = Math.min(this.stageW, this.stageH);
    nodes.forEach((node, i) => {
      this.baseSizes[i] = vizNodePx(node, stageMin);
    });
    if (this.coreSizeAttr) {
      (this.coreSizeAttr.array as Float32Array).set(this.baseSizes);
      this.coreSizeAttr.needsUpdate = true;
    }
    this.labelVersion++;
  }

  /** Label look for the theme: 16 px semibold for a hub, 14 px for a member, on a translucent pill. */
  private styleLabel(el: HTMLElement, hub: boolean): void {
    const style = LABEL_STYLE[this.theme];
    Object.assign(el.style, {
      color: style.color,
      background: style.background,
      borderRadius: "8px",
      padding: "2px 8px",
      boxSizing: "border-box",
      fontSize: hub ? "16px" : "14px",
      fontWeight: hub ? "600" : "400",
      lineHeight: hub ? "20px" : "18px",
    });
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
    if (this.selAlpha.length !== n) this.selAlpha = new Float32Array(n).fill(1);

    if (this.coreAlphaAttr && this.coreSizeAttr) {
      const size = this.coreSizeAttr.array as Float32Array;
      for (let i = 0; i < n; i++) {
        let a = 1;
        let s = this.baseSizes[i] ?? 1.5;
        if (sel?.kind === "core") {
          if (mark[i] === 2) s *= HIGHLIGHT_SIZE;
          else if (mark[i] === 1) s *= NEIGHBOUR_SIZE;
          else a = DIM_ALPHA;
        }
        // A ring selection highlights its ring point only: the core keeps full alpha.
        this.selAlpha[i] = a;
        size[i] = s;
      }
      this.coreSizeAttr.needsUpdate = true;
      this.writeCoreAlpha(this.lastNow);
    }

    this.applyEdgeAlphas();
    this.labelVersion++;

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

  /** Whether the running nodes pulse: the OS graph has running nodes and the motion setting allows it. */
  private pulseOn(): boolean {
    return this.pulsing.length > 0 && !this.reducedMotion;
  }

  /**
   * Writes every core node's alpha: its base (off nodes are quiet) times its selection factor,
   * and for a running node the pulse at time `now`. Done in place on the existing attribute.
   */
  private writeCoreAlpha(now: number): void {
    const attr = this.coreAlphaAttr;
    if (!attr) return;
    const alpha = attr.array as Float32Array;
    for (let i = 0; i < alpha.length; i++) {
      alpha[i] = (this.selAlpha[i] ?? 1) * (this.baseAlpha[i] ?? 1);
    }
    attr.needsUpdate = true;
    // The status ring of a running node pulses; the other rings hold their alpha.
    const ringAttr = this.coreRingAttr;
    if (!ringAttr) return;
    const ring = ringAttr.array as Float32Array;
    const pulse = this.pulseOn() ? VIZ_PULSE_MIN + (1 - VIZ_PULSE_MIN) * (0.5 + 0.5 * Math.sin((2 * Math.PI * now) / VIZ_PULSE_MS)) : 1;
    for (let i = 0; i < this.baseRing.length; i++) ring[i * 4 + 3] = this.baseRing[i] ?? 0;
    if (this.pulseOn()) for (const i of this.pulsing) if (i * 4 + 3 < ring.length) ring[i * 4 + 3] = (this.baseRing[i] ?? 0) * pulse;
    ringAttr.needsUpdate = true;
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
    this.lastNow = now;
    this.inFrame = true;
    try {
      // One rotation only: the camera orbits (controls.autoRotate); the scene groups stay put.
      const spinning = this.autoRotateWanted();
      this.controls.autoRotate = spinning;
      const tweening = this.stepTween(now);
      const moved = this.controls.update(dt);
      const pulsing = this.pulseOn();
      if (pulsing) this.writeCoreAlpha(now);
      if (
        this.hovering &&
        !this.dragging &&
        (moved || spinning || tweening) &&
        now - this.lastPickAt >= REPICK_INTERVAL_MS
      ) {
        this.lastPickAt = now;
        this.repickHover();
      }
      const d = this.distance();
      this.depthUniform.value.set(Math.max(1e-3, d - this.radius), d + this.radius);
      this.renderer.render(this.scene, this.camera);
      this.updateLabels();
      if (spinning || tweening || moved || pulsing) this.schedule();
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
    if (p >= 1) {
      this.tween = null;
      this.endInteraction();
    }
    return true;
  }

  private readonly onVisibility = (): void => {
    this.updateAutoRotate();
  };

  private readonly onControlsChange = (): void => {
    // Only a change the user makes counts as a camera move (auto-rotation and damping do not), and a click
    // that has not yet moved past the drag slop is not one either.
    const clickPending = this.dragging && !this.dragMoved;
    if (this.interacting && !clickPending) this.userMoved = true;
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

  /** Ends a focus flight at its target pose (what a level remembers when it is left mid-flight). */
  private settleTween(): void {
    const t = this.tween;
    if (!t) return;
    this.camera.position.copy(t.toPos);
    this.controls.target.copy(t.toTarget);
    this.cancelTween();
  }

  /** Stops a focus flight in progress; the auto-rotation resumes after RESUME_MS like after any interaction. */
  private cancelTween(): void {
    if (!this.tween) return;
    this.tween = null;
    this.endInteraction();
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
    this.cancelTween();
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
    // PICK_RADIUS_PX on screen, as a world distance at the current camera distance.
    const worldPerPx = (this.distance() * 2 * Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2)) / rect.height;
    this.raycaster.params.Points.threshold = worldPerPx * PICK_RADIUS_PX;
    // The controls move the camera between renders, so the ray is built from its current matrices.
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.scene.updateMatrixWorld();

    const targets = this.pickTargets;
    targets.length = 0;
    if (this.corePoints) targets.push(this.corePoints);
    // The ring is drawn in the code graph only; in the OS graph its points are not pickable.
    if (this.ringPoints && this.ringGroup.visible) targets.push(this.ringPoints);
    if (this.labelEdgeObj) {
      this.raycaster.params.Line.threshold = worldPerPx * PICK_RADIUS_PX;
      targets.push(this.labelEdgeObj);
    }
    if (targets.length === 0) return null;
    const hits = this.raycaster.intersectObjects(targets, false);
    const points = hits.filter((h) => h.object !== this.labelEdgeObj);
    // Prefer the nearest node that is not dimmed by the selection; fall back to the nearest one.
    const hit = points.find((h) => this.pickAlpha(h) >= 0.5) ?? points[0];
    if (!hit) {
      const edge = hits.find((h) => h.object === this.labelEdgeObj);
      return edge && edge.index !== undefined ? this.edgePick(Math.floor(edge.index / 2)) : null;
    }
    if (hit.index === undefined) return null;

    if (hit.object === this.ringPoints) {
      const item = this.ringItems[hit.index];
      return item ? { type: "ring", id: item.id, label: item.label, detail: item.kind } : null;
    }
    if (this.mode === "viz" && this.vizNodes) {
      const node = this.vizNodes[hit.index];
      return node
        ? { type: "viz", id: node.id, label: node.label || node.id, detail: node.kind, drill: node.drill }
        : null;
    }
    const item = this.coreItems[hit.index];
    return item ? { type: "core", id: item.id, label: item.label, detail: item.category } : null;
  }

  /** The hover pick of a labelled OS-graph edge (index into the labelled edges). */
  private edgePick(k: number): OrbitPick | null {
    const edge = this.labelledEdges[k];
    if (!edge) return null;
    return { type: "edge", id: `${edge.source}>${edge.target}`, label: edge.label ?? edge.kind, detail: edge.kind };
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
    const index = pick && pick.type === "viz" && this.mode === "viz" ? (this.coreIndex.get(pick.id) ?? null) : null;
    if (index !== this.hoverIndex) {
      this.hoverIndex = index;
      this.labelVersion++;
      this.applyEdgeAlphas();
      this.requestRender();
    }
    this.onHover?.(pick);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.canvas) return;
    this.dragging = true;
    this.dragMoved = false;
    this.gestureBase = null;
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
      // An edge is a hover-only pick: clicks select nodes and ring items.
      if (pick && pick.type !== "edge") this.onSelect?.(pick);
    }
  };

  private readonly onPointerLeave = (): void => {
    this.hovering = false;
    if (!this.dragging) this.setHover(null);
  };

  private readonly onDblClick = (e: MouseEvent): void => {
    const pick = this.pickAt(e.clientX, e.clientY);
    if (!pick || pick.type === "edge") return;
    // A hub opens its part (the page flies nothing there: the level changes); other nodes fly to.
    if (!pick.drill) this.focusNode(pick.id);
    if (this.onActivate) this.onActivate(pick);
    else this.onSelect?.(pick);
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
