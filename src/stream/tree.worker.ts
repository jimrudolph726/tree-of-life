/// <reference lib="webworker" />
import { TreeStore } from './store.ts';
import { validateManifest } from './format.ts';
import type { ViewRequest } from './format.ts';

let store: TreeStore | undefined;
const controllers = new Map<number, AbortController>();
self.onmessage = async ({ data }) => {
  const { id, type, payload } = data;
  if (type === 'cancel') { controllers.get(id)?.abort(); return; }
  const controller = new AbortController(); controllers.set(id, controller);
  try {
    let value: unknown;
    const transfers: Transferable[] = [];
    if (type === 'init') {
      const url = new URL(payload.url, self.location.href);
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Tree manifest unavailable (HTTP ${response.status}). Run the data build first.`);
      const manifest = validateManifest(await response.json());
      const base = new URL('.', url);
      store = new TreeStore(manifest, async (path, signal) => {
        const result = await fetch(new URL(path, base), { signal, cache: 'force-cache' });
        if (!result.ok) throw new Error(`Tree page unavailable (HTTP ${result.status}).`);
        return result.arrayBuffer();
      });
      value = manifest;
    } else {
      if (!store) throw new Error('Tree worker is not initialized.');
      if (type === 'view') {
        const scene = await store.view(payload as ViewRequest, controller.signal);
        value = scene; transfers.push(scene.lines.buffer as ArrayBuffer, scene.lineTargets.buffer as ArrayBuffer);
      } else if (type === 'search') value = await store.search(payload.query, controller.signal);
      else if (type === 'details') value = await store.details(payload.index, controller.signal);
      else throw new Error(`Unknown worker operation: ${type}`);
    }
    if (!controller.signal.aborted) self.postMessage({ id, value }, transfers);
  } catch (error) {
    if (!controller.signal.aborted) self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  } finally { controllers.delete(id); }
};
