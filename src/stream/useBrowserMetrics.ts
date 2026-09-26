import { useCallback, useEffect, useRef, useState } from 'react';
import type { Camera } from '../tree/navigation.ts';
export interface BrowserMetrics {
  firstMapMs: number | null;
  frameP95Ms: number | null;
  frameP50Ms: number | null;
  longTasks: number;
  longestTaskMs: number;
  sampledFrames: number;
  mainHeapMB: number | null;
  motionDurationMs: number;
  searchMs: number | null;
  selectionPaintMs: number | null;
}
export function useBrowserMetrics(enabled: boolean, camera: Camera, setCamera: (camera: Camera) => void) {
  const [metrics, setMetrics] = useState<BrowserMetrics>({ firstMapMs: null, frameP95Ms: null, frameP50Ms: null,
    longTasks: 0, longestTaskMs: 0, sampledFrames: 0, mainHeapMB: null, motionDurationMs: 0, searchMs: null, selectionPaintMs: null });
  const [running, setRunning] = useState(false);
  const painted = useRef(false);
  const tasks = useRef<number[]>([]);
  const raf = useRef(0);
  const focus = useRef<{ index: number; started: number } | null>(null);
  useEffect(() => {
    if (!enabled || !PerformanceObserver.supportedEntryTypes.includes('longtask')) return;
    const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) tasks.current.push(entry.duration); });
    observer.observe({ type: 'longtask', buffered: true });
    return () => observer.disconnect();
  }, [enabled]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const onPaint = useCallback((selectedIndex?: number) => {
    if (!enabled) return;
    if (!painted.current) { painted.current = true; setMetrics(old => ({ ...old, firstMapMs: performance.now() })); }
    if (focus.current && focus.current.index === selectedIndex) {
      const duration = performance.now() - focus.current.started; focus.current = null;
      setMetrics(old => ({ ...old, selectionPaintMs: duration }));
    }
  }, [enabled]);
  const startFocus = useCallback((index: number) => { if (enabled) focus.current = { index, started: performance.now() }; }, [enabled]);
  const recordSearch = useCallback((duration: number) => { if (enabled) setMetrics(old => ({ ...old, searchMs: duration })); }, [enabled]);
  const run = () => {
    if (running) return;
    setRunning(true);
    const original = { ...camera, target: [...camera.target] as Camera['target'] };
    const frames: number[] = [];
    const start = performance.now(); let previous = start;
    const duration = Math.max(5, Math.min(60, Number(new URLSearchParams(window.location.search).get('duration')) || 5)) * 1000;
    tasks.current = [];
    const frame = (now: number) => {
      frames.push(now - previous); previous = now;
      const t = Math.min(1, (now - start) / duration);
      const phase = t * duration / 5000;
      const wave = Math.abs(Math.sin(phase * Math.PI));
      setCamera({ ...original, zoom: original.zoom + wave * 2,
        target: [original.target[0] + Math.sin(phase * Math.PI * 4) * 80 / 2 ** original.zoom,
          original.target[1] + wave * 40 / 2 ** original.zoom, 0] });
      if (t < 1) raf.current = requestAnimationFrame(frame);
      else {
        frames.sort((a, b) => a - b);
        const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
        setMetrics(old => ({ ...old, frameP95Ms: frames[Math.floor(frames.length * 0.95)] ?? null,
          frameP50Ms: frames[Math.floor(frames.length * 0.5)] ?? null, sampledFrames: frames.length,
          longTasks: tasks.current.length, longestTaskMs: Math.max(0, ...tasks.current),
          mainHeapMB: memory ? memory.usedJSHeapSize / 1024 / 1024 : null, motionDurationMs: now - start }));
        setCamera(original);
        setRunning(false);
      }
    };
    raf.current = requestAnimationFrame(frame);
  };
  return { metrics, onPaint, run, running, startFocus, recordSearch };
}
