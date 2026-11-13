import { OrthographicController } from '@deck.gl/core';
import type { MjolnirWheelEvent } from 'mjolnir.js';
import type { Camera } from '../tree/navigation.ts';
import type { Scene, ViewRequest } from './format.ts';

/** deck.gl's stock wheel curve asymptotically caps each event at one zoom
 * level. A physical mouse detent should cover enough hierarchy to make this
 * million-tip map practical, while trackpads retain fine-grained control.
 */
export const MOUSE_WHEEL_ZOOM_LEVELS = 2.25;

export class TreeOrthographicController extends OrthographicController {
  protected override _onWheel(event: MjolnirWheelEvent): boolean {
    if (!this.scrollZoom || (this.trackpadGesture && event.device !== 'mouse')) return false;
    const position = this.getCenter(event);
    if (!this.isPointInBounds(position, event)) return false;
    event.srcEvent.preventDefault();
    if (!event.delta) return true;
    const levels = event.device === 'mouse'
      ? MOUSE_WHEEL_ZOOM_LEVELS
      : Math.max(0.02, Math.min(0.5, Math.abs(event.delta) * 0.01));
    const zoomPosition = this.getZoomPosition(position);
    const next = this.controllerState.zoom({ pos: zoomPosition,
      scale: 2 ** (Math.sign(event.delta) * levels) });
    this.updateViewport(next, { ...this._getTransitionProps({ around: zoomPosition }),
      transitionDuration: event.device === 'mouse' ? 180 : 100 }, { isZooming: true, isPanning: true });
    return true;
  }
}

// Orthographic wheel transitions emit two-coordinate targets. Sending a third
// coordinate back makes deck.gl treat its own animation frame as a new camera
// request and cancel the transition. Keep this boundary consistently 2D, and
// derive both zoom axes so a rebase cannot retain an old axis-specific scale.
export function deckView<T extends Camera>(camera: T) {
  return { ...camera, target: camera.target.slice(0, 2), zoomX: camera.zoom, zoomY: camera.zoom };
}

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
