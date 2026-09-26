import type { Camera } from '../tree/navigation.ts';
import type { Scene, ViewRequest } from './format.ts';

// deck.gl returns axis-specific zoom and constraint fields. Never store those
// alongside our scalar zoom: they override it after a coordinate-frame change.
export function cameraFromView(view: { target?: number[]; zoom?: number | number[] }, previous: Camera): Camera {
  const zoom = Array.isArray(view.zoom) ? view.zoom[0] : view.zoom ?? previous.zoom;
  const target = view.target ?? previous.target;
  if (![zoom, ...target].every(Number.isFinite)) return previous;
  return { target: [target[0], target[1], target[2] ?? 0], zoom,
    minZoom: previous.minZoom, maxZoom: previous.maxZoom };
}

export function sameView(a: ViewRequest, b: ViewRequest, pixels = 1, zoom = 0.01) {
  return a.anchor === b.anchor && a.size.width === b.size.width && a.size.height === b.size.height &&
    Math.abs(a.camera.zoom - b.camera.zoom) < zoom &&
    Math.hypot(a.camera.target[0] - b.camera.target[0], a.camera.target[1] - b.camera.target[1]) * 2 ** b.camera.zoom < pixels;
}

export function reframe(scene: Scene, camera: Camera) {
  const r = scene.rebase!;
  const factor = 1000 / r.radius;
  const point = ([x, y]: number[]): [number, number] => [(x - r.x) * factor, (y - r.y) * factor];
  const zoom = camera.zoom - Math.log2(factor);
  const nextCamera: Camera = { target: [...point(camera.target), 0], zoom,
    minZoom: Math.min(camera.minZoom, zoom - 2), maxZoom: Math.max(camera.maxZoom, zoom + 2) };
  const lines = scene.lines.map((value, i) => (value - (i % 2 ? r.y : r.x)) * factor);
  const nextScene: Scene = { ...scene, anchor: r.anchor, rebase: undefined, lines,
    nodes: scene.nodes.map(n => ({ ...n, position: point(n.position), radius: n.radius * factor,
      bounds: [...point(n.bounds.slice(0, 2)), ...point(n.bounds.slice(2))], region: n.region.map(point) })) };
  return { camera: nextCamera, scene: nextScene };
}
