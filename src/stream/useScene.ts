import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { Camera, Size } from '../tree/navigation.ts';
import type { Scene, ViewRequest } from './format.ts';
import type { TreeClient } from './client.ts';
import { reframe, sameView } from './reframe.ts';

export function useScene(client: TreeClient, anchor: number, camera: Camera, size: Size,
  onRebase: (anchor: number, camera: Camera) => void, canRebase: () => boolean = () => true) {
  const [scene, setScene] = useState<Scene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<ViewRequest>({ anchor, camera, size });
  useEffect(() => { latest.current = { anchor, camera, size }; }, [anchor, camera, size]);
  const receive = useEffectEvent((result: Scene, request: ViewRequest) => {
    if (result.anchor !== anchor) return;
    // Do not replace a newer view with geometry requested before a fast pan.
    if (!sameView(request, { anchor, camera, size }, 100, 0.3)) return;
    if (result.rebase && canRebase() && sameView(request, { anchor, camera, size })) {
      const next = reframe(result, camera);
      setScene(next.scene); // Keep every visible point in place while new pages arrive.
      onRebase(next.scene.anchor, next.camera);
    } else setScene(result);
    setError(null);
  });
  useEffect(() => {
    let last: ViewRequest | null = null;
    let active: AbortController | null = null;
    let activeAnchor = -1;
    let disposed = false;
    let retryAfter = 0;
    const tick = () => {
      const request = latest.current;
      if (active && activeAnchor !== request.anchor) { active.abort(); active = null; }
      if (active || performance.now() < retryAfter) return;
      if (last && last.anchor === request.anchor && last.size.width === request.size.width && last.size.height === request.size.height &&
          Math.abs(last.camera.zoom - request.camera.zoom) < 0.2 &&
          Math.hypot(last.camera.target[0] - request.camera.target[0], last.camera.target[1] - request.camera.target[1]) * 2 ** request.camera.zoom < 70) return;
      const controller = new AbortController(); active = controller; activeAnchor = request.anchor;
      void client.view(request, controller.signal).then(result => {
        if (!disposed && !controller.signal.aborted) {
          // A moving camera can defer a rebase. Retry once it settles even if it
          // moved less than the ordinary scene refresh threshold.
          last = result.rebase ? null : request;
          receive(result, request);
        }
      }).catch(cause => {
        if (!disposed && !controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'Could not load this part of the tree.');
          retryAfter = performance.now() + 1500;
        }
      }).finally(() => { if (active === controller) active = null; });
    };
    tick();
    const timer = window.setInterval(tick, 80);
    return () => { disposed = true; clearInterval(timer); active?.abort(); };
  }, [client]);
  return { scene: scene?.anchor === anchor ? scene : null, error, prime: setScene };
}
