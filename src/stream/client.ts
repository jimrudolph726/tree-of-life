import type { Details, Manifest, Scene, Summary, ViewRequest } from './format.ts';

export class TreeClient {
  private worker: Worker;
  private serial = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  constructor() {
    this.worker = new Worker(new URL('./tree.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data.value);
    };
    this.worker.onerror = event => {
      for (const pending of this.pending.values()) pending.reject(new Error(event.message || 'Tree worker failed.'));
      this.pending.clear();
    };
  }
  private request<T>(type: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const id = ++this.serial;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id); this.worker.postMessage({ id, type: 'cancel' });
        reject(new DOMException('Request cancelled', 'AbortError'));
      };
      this.pending.set(id, {
        resolve: value => { signal?.removeEventListener('abort', abort); resolve(value as T); },
        reject: error => { signal?.removeEventListener('abort', abort); reject(error); },
      });
      signal?.addEventListener('abort', abort, { once: true });
      this.worker.postMessage({ id, type, payload });
    });
  }
  init(url: string, signal?: AbortSignal) { return this.request<Manifest>('init', { url }, signal); }
  view(request: ViewRequest, signal?: AbortSignal) { return this.request<Scene>('view', request, signal); }
  search(query: string, signal?: AbortSignal) { return this.request<Summary[]>('search', { query }, signal); }
  details(index: number, signal?: AbortSignal) { return this.request<Details>('details', { index }, signal); }
  close() {
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new DOMException('Worker closed', 'AbortError'));
    this.pending.clear();
  }
}
