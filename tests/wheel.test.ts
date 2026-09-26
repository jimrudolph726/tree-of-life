import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinearInterpolator, OrthographicController, OrthographicViewport } from '@deck.gl/core';
import type { TransitionInterpolator } from '@deck.gl/core';
import { Timeline } from '@luma.gl/engine';
import { cameraFromView, deckView } from '../src/stream/reframe.ts';
import type { Camera } from '../src/tree/navigation.ts';

type State = Camera & { transitionDuration?: number | 'auto'; transitionInterpolator?: TransitionInterpolator };

// Exercise the actual deck.gl event/animation loop, including controlled React
// feedback. Projection-only tests cannot detect a canceled wheel transition.
function controlledCamera(initial: Camera) {
  const timeline = new Timeline();
  let camera: State = initial;
  let pending: State | undefined = camera;
  const viewport = () => new OrthographicViewport({ width: 1000, height: 700, ...deckView(camera), flipY: true });
  const controller = new OrthographicController({
    timeline,
    eventManager: null!,
    makeViewport: props => new OrthographicViewport({ ...props, flipY: true }),
    onStateChange: () => {},
    onViewStateChange: ({ viewState }) => {
      pending = { ...cameraFromView(viewState, camera), transitionDuration: viewState.transitionDuration,
        transitionInterpolator: viewState.transitionInterpolator };
    },
  });
  function flush() {
    for (let count = 0; pending; count++) {
      assert.ok(count < 20, 'camera feedback settles');
      camera = pending;
      pending = undefined;
      controller.setProps({ id: 'tree', x: 0, y: 0, width: 1000, height: 700,
        ...deckView(camera), scrollZoom: { speed: 0.03, smooth: true } });
    }
  }
  flush();
  return {
    get camera() { return camera; },
    viewport,
    wheel(delta: number, point: [number, number]) {
      const event = { type: 'wheel', delta, device: 'mouse', offsetCenter: { x: point[0], y: point[1] },
        srcEvent: { preventDefault() {} }, handled: false, stopPropagation() {} };
      assert.equal(controller.handleEvent(event as Parameters<typeof controller.handleEvent>[0]), true);
      flush();
    },
    advance(ms: number) {
      const end = timeline.getTime() + ms;
      while (timeline.getTime() < end) {
        timeline.setTime(Math.min(end, timeline.getTime() + 16));
        controller.updateTransition();
        flush();
      }
    },
    animate(zoom: number) {
      pending = { ...camera, zoom, transitionDuration: 650,
        transitionInterpolator: new LinearInterpolator(['target', 'zoomX', 'zoomY']) };
      flush();
    },
    dispose: () => controller.finalize(),
  };
}

for (const zoom of [-2, 18]) test(`wheel zoom animates in both directions at zoom ${zoom}`, () => {
  const app = controlledCamera({ target: [34, -56, 0], zoom, minZoom: -20, maxZoom: 30 });
  try {
    const pointer: [number, number] = [700, 400];
    const worldPoint = app.viewport().unproject(pointer);
    app.wheel(100, pointer);
    app.advance(125);
    assert.ok(app.camera.zoom > zoom + 0.2, 'wheel animation advances beyond its first frame');
    assert.ok(app.camera.zoom < zoom + 0.9, 'wheel animates instead of jumping to its endpoint');
    app.advance(150);
    assert.ok(app.camera.zoom > zoom + 0.9);
    const projected = app.viewport().project(worldPoint);
    assert.ok(Math.hypot(projected[0] - pointer[0], projected[1] - pointer[1]) < 1e-5, 'pointer stays anchored');
    app.wheel(-100, pointer);
    app.advance(275);
    assert.ok(Math.abs(app.camera.zoom - zoom) < 1e-8, 'reverse wheel returns to original scale');
    app.animate(zoom + 2);
    app.advance(325);
    assert.ok(Math.abs(app.camera.zoom - (zoom + 1)) < 0.1, 'button zoom also interpolates both axes');
    app.advance(350);
    assert.ok(Math.abs(app.camera.zoom - (zoom + 2)) < 1e-8);
  } finally { app.dispose(); }
});
