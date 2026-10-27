// Framework-free three.js view of the orbit "brain": a slowly rotating point
// cloud of the project graph (coloured by category) with a ring of recent
// activity. Hover and click are resolved with a Raycaster; drag rotates. If
// WebGL is unavailable the view shows a text fallback and every method no-ops.
//
// The canvas is absolutely positioned inside the container, so its backing
// buffer never feeds back into the container's auto height (the host must
// give the container a definite height, see OrbitPanel).

import * as THREE from "three";
import type {
  CoreCategory,
  OrbitLayout,
  SystemGraph,
  SystemRingItem,
  Vec3,
} from "../../../typescript/src/system/index.js";
import {
  buildEdgeBuffer,
  buildPointBuffers,
  DEFAULT_CATEGORY_COLORS,
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
  /** Core rotation speed in rad/s. Default 0.05. The ring orbits faster. */
  rotationSpeed?: number;
  /** When true the view does not rotate on its own (drag still works). */
  reducedMotion?: boolean;
  /** Default "dark". "light" uses normal blending and darker lines. */
  theme?: OrbitTheme;
  colors?: Partial<Record<CoreCategory, string>>;
  onHover?: (item: OrbitPick | null) => void;
  onSelect?: (item: OrbitPick) => void;
  /** Called once when WebGL is unavailable and the view shows its text fallback. */
  onFallback?: () => void;
  /** Builds the renderer on the canvas the view created. Default: WebGLRenderer. */
  createRenderer?: (canvas: HTMLCanvasElement) => RendererLike;
  /** Default: window.requestAnimationFrame. */
  requestFrame?: (cb: FrameRequestCallback) => number;
  /** Default: window.cancelAnimationFrame. */
  cancelFrame?: (id: number) => void;
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
const DRAG_RAD_PER_PX = 0.005;
const CLICK_SLOP_PX = 4;
const MAX_FRAME_DT = 0.1;
/** Hover is re-resolved at most this often while the view rotates under the pointer. */
const REPICK_INTERVAL_MS = 150;
/** Framing: sphere fit with a 25% margin, camera looking slightly down. */
const FRAME_MARGIN = 1.25;
const FRAME_ELEVATION = 0.35;
/** The camera is re-framed when the core's node count moves by more than this fraction. */
const REFRAME_CHANGE_RATIO = 0.2;

const VERTEX_SHADER = `
attribute float aSize;
attribute vec3 aColor;
uniform float uScale;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / -mv.z, 1.0, 48.0);
}
`;

const FRAGMENT_SHADER = `
uniform float uOpacity;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  if (d > 0.5) discard;
  float a = 1.0 - smoothstep(0.15, 0.5, d);
  gl_FragColor = vec4(vColor, a * uOpacity);
}
`;

interface CoreItem {
  id: string;
  label: string;
  category: CoreCategory;
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

export class OrbitView {
  private readonly container: HTMLElement;
  private readonly speed: number;
  private reducedMotion: boolean;
  private theme: OrbitTheme;
  private readonly colors: Record<CoreCategory, string>;
  private readonly onHover?: (item: OrbitPick | null) => void;
  private readonly onSelect?: (item: OrbitPick) => void;
  private readonly onFallback?: () => void;
  private readonly createRenderer: (canvas: HTMLCanvasElement) => RendererLike;
  private readonly requestFrame: (cb: FrameRequestCallback) => number;
  private readonly cancelFrame: (id: number) => void;

  private renderer: RendererLike | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 1, 1000);
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
  private ringItems: RingLabel[] = [];
  private ringSig: string | null = null;
  private ringRadius = 0;
  private corePoints: THREE.Points | null = null;
  private ringPoints: THREE.Points | null = null;
  private ringColorAttr: THREE.BufferAttribute | null = null;
  private radius = 1;
  /** Core node count at the last framing, or null before the first framing. */
  private framedCoreCount: number | null = null;
  private ringCount = 0;

  private coreAngle = 0;
  private ringAngle = 0;
  private spin = false;
  private frameId: number | null = null;
  private lastTime: number | null = null;
  private disposed = false;

  private hovered: OrbitPick | null = null;
  /** True while the pointer is over the canvas (not dragging); drives hover re-picks. */
  private hovering = false;
  private hoverX = 0;
  private hoverY = 0;
  private lastPickAt = 0;
  private dragging = false;
  private dragMoved = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragLastX = 0;
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
    this.colors = resolveColors(opts.colors);
    this.onHover = opts.onHover;
    this.onSelect = opts.onSelect;
    this.onFallback = opts.onFallback;
    this.createRenderer = opts.createRenderer ?? defaultCreateRenderer;
    this.requestFrame = opts.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = opts.cancelFrame ?? ((id) => cancelAnimationFrame(id));

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
    document.addEventListener("visibilitychange", this.onVisibility);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
    this.resize();
    this.updateSpin();
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

    this.coreItems = uniqueCoreNodes(graph).map((n) => ({ id: n.id, label: n.label, category: n.category }));
    const pts = buildPointBuffers(graph, layout, this.colors);
    if (pts.ids.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pts.positions, 3));
      geo.setAttribute("aColor", new THREE.BufferAttribute(pts.colors, 3));
      geo.setAttribute("aSize", new THREE.BufferAttribute(pts.sizes, 1));
      this.corePoints = new THREE.Points(geo, this.makePointMaterial(CORE_OPACITY));
      this.coreGroup.add(this.corePoints);
    }

    const edges = buildEdgeBuffer(graph, layout);
    if (edges.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(edges, 3));
      this.coreGroup.add(new THREE.LineSegments(geo, this.makeLineMaterial("edge")));
    }

    this.radius = Math.max(layout.bounds.radius, this.ringRadius, 1);
    this.setHover(null);
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

    let ringRadius = 0;
    if (this.ringItems.length > 0) {
      const positions = new Float32Array(this.ringItems.length * 3);
      const rgb = new Float32Array(this.ringItems.length * 3);
      const sizes = new Float32Array(this.ringItems.length).fill(RING_POINT_SIZE);
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
      const colorAttr = new THREE.BufferAttribute(rgb, 3);
      geo.setAttribute("aColor", colorAttr);
      this.ringColorAttr = colorAttr;
      geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
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

  /** Re-measure the container and re-frame the camera. */
  resize(): void {
    if (!this.renderer || this.disposed) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    const pr = this.renderer.getPixelRatio();
    this.camera.aspect = w / h;
    this.scaleUniform.value = ((h * pr) / (2 * Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2))) * POINT_SCALE;
    this.fitCamera();
    this.requestRender();
  }

  /** Enable or disable the automatic rotation (drag still works). */
  setReducedMotion(reduced: boolean): void {
    const next = !!reduced;
    if (next === this.reducedMotion) return;
    this.reducedMotion = next;
    this.updateSpin();
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
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameId !== null) this.cancelFrame(this.frameId);
    this.frameId = null;
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
    }
    this.hovering = false;
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
    const mat = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false });
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

  private fitCamera(): void {
    // Bounding-sphere fit: the narrower of the vertical and horizontal half-angles governs.
    const vHalf = THREE.MathUtils.degToRad(FOV_DEG) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const half = Math.min(vHalf, hHalf);
    const dist = (FRAME_MARGIN * this.radius) / Math.sin(half);
    const n = Math.hypot(FRAME_ELEVATION, 1);
    this.camera.position.set(0, (dist * FRAME_ELEVATION) / n, dist / n);
    this.camera.lookAt(0, 0, 0);
    this.camera.near = Math.max(0.1, dist * 0.02);
    this.camera.far = dist * 5;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
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
    this.coreItems = [];
    this.graph = null;
    this.layout = null;
  }

  private clearRing(): void {
    this.clearGroup(this.ringGroup);
    this.ringPoints = null;
    this.ringColorAttr = null;
    this.ringItems = [];
    this.ringCount = 0;
    this.ringRadius = 0;
  }

  private applyRotation(): void {
    this.coreGroup.rotation.y = this.coreAngle;
    this.ringGroup.rotation.y = this.ringAngle;
  }

  private schedule(): void {
    if (this.disposed || this.frameId !== null || !this.renderer) return;
    this.frameId = this.requestFrame(this.frame);
  }

  private requestRender(): void {
    this.schedule();
  }

  private readonly frame = (now: number): void => {
    this.frameId = null;
    if (this.disposed || !this.renderer) return;
    const dt = this.lastTime === null ? 0 : Math.min((now - this.lastTime) / 1000, MAX_FRAME_DT);
    this.lastTime = now;
    if (this.spin) {
      this.coreAngle += this.speed * dt;
      this.ringAngle += this.speed * RING_SPIN_FACTOR * dt;
      this.applyRotation();
      if (this.hovering && !this.dragging && now - this.lastPickAt >= REPICK_INTERVAL_MS) {
        this.lastPickAt = now;
        this.repickHover();
      }
    }
    this.renderer.render(this.scene, this.camera);
    if (this.spin) this.schedule();
  };

  private updateSpin(): void {
    const hidden = typeof document !== "undefined" && document.hidden;
    this.spin = !this.reducedMotion && this.speed > 0 && !hidden;
    if (this.spin) this.schedule();
    else this.lastTime = null;
  }

  private readonly onVisibility = (): void => {
    this.updateSpin();
  };

  private pickAt(clientX: number, clientY: number): OrbitPick | null {
    const canvas = this.canvas;
    if (!canvas || !this.renderer) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.params.Points.threshold = Math.max(this.radius * 0.02, 0.5);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.scene.updateMatrixWorld();

    const targets = this.pickTargets;
    targets.length = 0;
    if (this.corePoints) targets.push(this.corePoints);
    if (this.ringPoints) targets.push(this.ringPoints);
    if (targets.length === 0) return null;
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit || hit.index === undefined) return null;

    if (hit.object === this.ringPoints) {
      const item = this.ringItems[hit.index];
      return item ? { type: "ring", id: item.id, label: item.label, detail: item.kind } : null;
    }
    const item = this.coreItems[hit.index];
    return item ? { type: "core", id: item.id, label: item.label, detail: item.category } : null;
  }

  /** Resolve the item under the remembered pointer position (used while rotating). */
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
    if (e.button !== 0 || !this.canvas) return;
    this.dragging = true;
    this.dragMoved = false;
    this.hovering = false;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.dragLastX = e.clientX;
    this.canvas.setPointerCapture?.(e.pointerId);
    this.canvas.style.cursor = "grabbing";
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.dragging) {
      const dx = e.clientX - this.dragLastX;
      this.dragLastX = e.clientX;
      if (Math.hypot(e.clientX - this.dragStartX, e.clientY - this.dragStartY) > CLICK_SLOP_PX) {
        this.dragMoved = true;
      }
      if (dx !== 0) {
        this.coreAngle += dx * DRAG_RAD_PER_PX;
        this.ringAngle += dx * DRAG_RAD_PER_PX;
        this.applyRotation();
        this.requestRender();
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
    if (this.canvas) {
      this.canvas.style.cursor = "grab";
      this.canvas.releasePointerCapture?.(e.pointerId);
    }
    if (!this.dragMoved && e.type === "pointerup") {
      const pick = this.pickAt(e.clientX, e.clientY);
      if (pick) this.onSelect?.(pick);
    }
  };

  private readonly onPointerLeave = (): void => {
    this.hovering = false;
    if (!this.dragging) this.setHover(null);
  };
}
