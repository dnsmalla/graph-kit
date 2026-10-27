// Framework-free three.js view of the orbit "brain": a slowly rotating point
// cloud of the project graph (coloured by category) with a ring of recent
// activity. Hover and click are resolved with a Raycaster; drag rotates. If
// WebGL is unavailable the view shows a text fallback and every method no-ops.

import * as THREE from "three";
import type {
  CoreCategory,
  OrbitLayout,
  SystemGraph,
} from "../../../typescript/src/system/index.js";
import {
  buildEdgeBuffer,
  buildPointBuffers,
  DEFAULT_CATEGORY_COLORS,
  isHexColor,
  ringLabelPositions,
  uniqueCoreNodes,
} from "./scene";

export interface OrbitPick {
  type: "core" | "ring";
  id: string;
  label: string;
  /** Category for core nodes, activity kind for ring items. */
  detail: string;
}

export interface OrbitViewOptions {
  /** Core rotation speed in rad/s. Default 0.05. The ring orbits faster. */
  rotationSpeed?: number;
  /** When true the view does not rotate on its own (drag still works). */
  reducedMotion?: boolean;
  colors?: Partial<Record<CoreCategory, string>>;
  onHover?: (item: OrbitPick | null) => void;
  onSelect?: (item: OrbitPick) => void;
}

const FOV_DEG = 45;
/** Converts a world-space point size to pixels (tuned by eye, see scene units). */
const POINT_SCALE = 0.5;
const CORE_OPACITY = 0.9;
const EDGE_OPACITY = 0.08;
const EDGE_COLOR = 0x8a93a6;
const RING_POINT_SIZE = 6;
const RING_COLOR: [number, number, number] = [0.96, 0.97, 1];
const RING_SPIN_FACTOR = 1.6;
const DRAG_RAD_PER_PX = 0.005;
const CLICK_SLOP_PX = 4;
const MAX_FRAME_DT = 0.1;

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

interface RingItem {
  id: string;
  label: string;
  kind: string;
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

export class OrbitView {
  private readonly container: HTMLElement;
  private readonly speed: number;
  private readonly reducedMotion: boolean;
  private readonly colors: Record<CoreCategory, string>;
  private readonly onHover?: (item: OrbitPick | null) => void;
  private readonly onSelect?: (item: OrbitPick) => void;

  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 1, 1000);
  private readonly coreGroup = new THREE.Group();
  private readonly ringGroup = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  /** Shared by every point material; updated on resize. */
  private readonly scaleUniform = { value: 1 };

  private coreItems: CoreItem[] = [];
  private ringItems: RingItem[] = [];
  private corePoints: THREE.Points | null = null;
  private ringPoints: THREE.Points | null = null;
  private radius = 1;

  private coreAngle = 0;
  private ringAngle = 0;
  private spin = false;
  private frameId: number | null = null;
  private lastTime: number | null = null;
  private disposed = false;

  private hovered: OrbitPick | null = null;
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
    this.colors = resolveColors(opts.colors);
    this.onHover = opts.onHover;
    this.onSelect = opts.onSelect;

    this.scene.add(this.coreGroup, this.ringGroup);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      this.showFallback();
      return;
    }
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const canvas = renderer.domElement;
    this.canvas = canvas;
    canvas.className = "orbit-canvas";
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.touchAction = "none";
    canvas.style.cursor = "grab";
    container.appendChild(canvas);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    document.addEventListener("visibilitychange", this.onVisibility);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
    this.resize();
    this.updateSpin();
  }

  /** Replace the scene with a graph and its layout. */
  setGraph(graph: SystemGraph, layout: OrbitLayout): void {
    if (!this.renderer || this.disposed) return;
    this.clearContent();

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
      const mat = new THREE.LineBasicMaterial({
        color: EDGE_COLOR,
        transparent: true,
        opacity: EDGE_OPACITY,
        depthWrite: false,
      });
      this.coreGroup.add(new THREE.LineSegments(geo, mat));
    }

    const ring = ringLabelPositions(graph, layout);
    this.ringItems = ring.map((r) => ({ id: r.id, label: r.label, kind: r.kind }));
    let ringRadius = 0;
    if (ring.length > 0) {
      const positions = new Float32Array(ring.length * 3);
      const rgb = new Float32Array(ring.length * 3);
      const sizes = new Float32Array(ring.length).fill(RING_POINT_SIZE);
      ring.forEach((r, i) => {
        positions[i * 3] = r.x;
        positions[i * 3 + 1] = r.y;
        positions[i * 3 + 2] = r.z;
        rgb.set(RING_COLOR, i * 3);
        ringRadius = Math.max(ringRadius, Math.hypot(r.x, r.z));
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("aColor", new THREE.BufferAttribute(rgb, 3));
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
      const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false });
      this.ringGroup.add(new THREE.LineLoop(geo, mat));
    }

    this.radius = Math.max(layout.bounds.radius, 1);
    this.setHover(null);
    this.fitCamera();
    this.requestRender();
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
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
      canvas.removeEventListener("pointerleave", this.onPointerLeave);
    }
    this.clearContent();
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
    return new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: { uScale: this.scaleUniform, uOpacity: { value: opacity } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }

  private fitCamera(): void {
    const vfov = THREE.MathUtils.degToRad(FOV_DEG);
    const tanV = Math.tan(vfov / 2);
    const tanH = tanV * this.camera.aspect;
    const tan = Math.min(tanV, tanH) || tanV;
    const dist = (this.radius * 1.1) / tan;
    this.camera.position.set(0, this.radius * 0.35, dist);
    this.camera.lookAt(0, 0, 0);
    this.camera.near = Math.max(0.1, dist * 0.02);
    this.camera.far = dist * 5;
    this.camera.updateProjectionMatrix();
  }

  private clearGroup(group: THREE.Group): void {
    for (const obj of [...group.children]) {
      group.remove(obj);
      const o = obj as { geometry?: THREE.BufferGeometry; material?: THREE.Material };
      o.geometry?.dispose();
      o.material?.dispose();
    }
  }

  private clearContent(): void {
    this.clearGroup(this.coreGroup);
    this.clearGroup(this.ringGroup);
    this.corePoints = null;
    this.ringPoints = null;
    this.coreItems = [];
    this.ringItems = [];
  }

  private applyRotation(): void {
    this.coreGroup.rotation.y = this.coreAngle;
    this.ringGroup.rotation.y = this.ringAngle;
  }

  private schedule(): void {
    if (this.disposed || this.frameId !== null || !this.renderer) return;
    this.frameId = requestAnimationFrame(this.frame);
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

    const targets: THREE.Object3D[] = [];
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

  private setHover(pick: OrbitPick | null): void {
    if (sameItem(this.hovered, pick)) return;
    this.hovered = pick;
    this.onHover?.(pick);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.canvas) return;
    this.dragging = true;
    this.dragMoved = false;
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
    const pick = this.pickAt(e.clientX, e.clientY);
    if (this.canvas) this.canvas.style.cursor = pick ? "pointer" : "grab";
    this.setHover(pick);
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
    if (!this.dragging) this.setHover(null);
  };
}
