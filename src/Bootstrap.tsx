import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { JourneyClient } from './journeys/client';
import { ProfileClient } from './profiles/client';
import { TreeClient } from './stream/client';
import type { Manifest } from './stream/format';
import { treeDataUrl } from './data/urls';
import './App.css';

let visualization: ReturnType<typeof importVisualization> | undefined;
function importVisualization() { return import('./App.tsx').then(module => ({ default: module.TreeMap })); }
function loadVisualization() { return visualization ??= importVisualization(); }
const TreeMap = lazy(loadVisualization);

export default function Bootstrap() {
  const profileClient = useMemo(() => new ProfileClient(new URL(`${import.meta.env.BASE_URL}data/profiles/manifest.json`, window.location.href).href), []);
  const journeyClient = useMemo(() => new JourneyClient(new URL(`${import.meta.env.BASE_URL}data/journeys/manifest.json`, window.location.href).href), []);
  const [loaded, setLoaded] = useState<{ client: TreeClient; manifest: Manifest } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const client = new TreeClient(), controller = new AbortController();
    // Begin renderer download while the already-preloaded manifest is decoded.
    void loadVisualization();
    const fixture = new URLSearchParams(window.location.search).get('dataset');
    const path = fixture && /^(balanced|unbalanced)-(10000|100000|1000000)$/.test(fixture)
      ? `${import.meta.env.BASE_URL}benchmarks/${fixture}/manifest.json`
      : treeDataUrl(`data/${fixture === 'primates' ? 'primates' : fixture === 'aves' ? 'aves' : 'life'}/manifest.json`);
    void client.init(new URL(path, window.location.href).href, controller.signal)
      .then(manifest => setLoaded({ client, manifest }))
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => { controller.abort(); client.close(); };
  }, [attempt]);
  if (error) return <main className="app loading-message" role="alert"><div><h1>Unable to open the tree</h1><p>{error}</p><button onClick={() => { setError(null); setAttempt(value => value + 1); }}>Try again</button></div></main>;
  if (!loaded) return <main className="app loading-message" role="status"><div className="loading-indicator" /><p>Opening the tree map…</p></main>;
  return <Suspense fallback={<main className="app loading-message" role="status"><div className="loading-indicator" /><p>Preparing the tree canvas…</p></main>}>
    <TreeMap client={loaded.client} profileClient={profileClient} journeyClient={journeyClient} manifest={loaded.manifest} />
  </Suspense>;
}
