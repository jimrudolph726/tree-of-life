import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DeckGL } from '@deck.gl/react';
import { LinearInterpolator, OrthographicView } from '@deck.gl/core';
import { LineLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { MapTreeNode } from './tree/layoutTreeV3';
import { fitBounds, focusBounds, labelOffset, labelSize, labelText, mapInsets, visibleLabels } from './tree/navigation';
import type { Camera, Size } from './tree/navigation';
import { TreeClient } from './stream/client';
import type { Details, Manifest, StreamNode, Summary } from './stream/format';
import { cacheBudget } from './stream/format';
import { useScene } from './stream/useScene';
import { useBrowserMetrics } from './stream/useBrowserMetrics';
import './App.css';

const VIEW = new OrthographicView({ id: 'tree', flipY: true });
const TRANSITION = new LinearInterpolator(['target', 'zoom']);
const PALETTE: [number, number, number, number][] = [[84, 143, 121, 24], [87, 125, 162, 24], [185, 141, 82, 24], [140, 117, 163, 24]];
const DOMAIN_COLORS: [number, number, number, number][] = [[84, 143, 121, 18], [99, 140, 172, 32], [94, 153, 126, 32], [192, 137, 97, 32]];
type CameraState = Camera & { transitionDuration?: number; transitionInterpolator?: LinearInterpolator };
type Visit = { camera: CameraState; anchor: number; details: Details | null; home: boolean };
const getSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight });
const animate = (camera: Camera): CameraState => ({ ...camera,
  transitionDuration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650, transitionInterpolator: TRANSITION });
const EMPTY_NODES: StreamNode[] = [];
const benchmarkMode = new URLSearchParams(window.location.search).has('bench');

function rootNode(manifest: Manifest): StreamNode {
  return { ...manifest.root, position: [0, 0], radius: 1000, heading: -Math.PI / 2, region: [],
    bounds: manifest.rootBounds.map(value => value * 1000) as MapTreeNode['bounds'] };
}

function openingCamera(root: StreamNode, size: Size, manifest: Manifest) {
  if (manifest.presentation !== 'life') return fitBounds(focusBounds(root), size, mapInsets(size));
  return fitBounds(root.bounds, size, size.width < 700
    ? { top: 145, left: 50, right: 14, bottom: 100 }
    : { top: 90, left: 90, right: 90, bottom: 55 });
}

function TreeMap({ client, manifest }: { client: TreeClient; manifest: Manifest }) {
  const root = useMemo(() => rootNode(manifest), [manifest]);
  const container = useRef<HTMLElement>(null);
  const atHome = useRef(true);
  const focusRequest = useRef<AbortController | null>(null);
  const [size, setSize] = useState(getSize);
  const [camera, setCamera] = useState<CameraState>(() => openingCamera(root, getSize(), manifest));
  const [anchor, setAnchor] = useState(0);
  const [details, setDetails] = useState<Details | null>(null);
  const [pendingTaxon, setPendingTaxon] = useState<string | null>(null);
  const [past, setPast] = useState<Visit[]>([]);
  const [future, setFuture] = useState<Visit[]>([]);
  const selected = details?.node ?? null;
  const [query, setQuery] = useState('');
  const [searchState, setSearchState] = useState<{ query: string; results: Summary[] }>({ query: '', results: [] });
  const searching = query.trim() !== searchState.query;
  const results = searching ? [] : searchState.results;
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeResult, setActiveResult] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [showRegions, setShowRegions] = useState(true);
  const homeCamera = useMemo(() => openingCamera(root, size, manifest), [root, size, manifest]);
  const { scene, error: streamError, prime } = useScene(client, anchor, camera, size, (nextAnchor, nextCamera) => {
    setAnchor(nextAnchor); setCamera({ ...nextCamera, transitionDuration: 0 });
  });
  const telemetry = useBrowserMetrics(benchmarkMode, camera, value => { atHome.current = false; setCamera({ ...value, transitionDuration: 0 }); });
  const { startFocus, recordSearch } = telemetry;
  const namedNodes = scene?.nodes ?? EMPTY_NODES;
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = { width: entry.contentRect.width, height: entry.contentRect.height };
      if (!next.width || !next.height) return;
      setSize(next);
      if (atHome.current) setCamera(openingCamera(root, next, manifest));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root, manifest]);
  useEffect(() => () => focusRequest.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    const started = performance.now();
    const timer = setTimeout(() => {
      void client.search(query, controller.signal).then(results => {
        setSearchState({ query: query.trim(), results });
        if (query.trim()) recordSearch(performance.now() - started);
      })
        .catch(error => { if (!controller.signal.aborted) setNavigationError(error.message); });
    }, 160);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [client, query, recordSearch]);
  const focusNode = useCallback((node: Summary) => {
    startFocus(node.index);
    focusRequest.current?.abort();
    const controller = new AbortController(); focusRequest.current = controller;
    const previous = { camera, anchor, details, home: atHome.current };
    setPendingTaxon(node.scientificName);
    setNavigationError(null); setSearchOpen(false); setQuery('');
    void client.details(node.index, controller.signal).then(async result => {
      const nextCamera = fitBounds(focusBounds(result.focus), size, mapInsets(size, true));
      const ready = await client.view({ anchor: result.anchor, camera: nextCamera, size }, controller.signal);
      if (controller.signal.aborted) return;
      setPast(history => [...history.slice(-49), previous]); setFuture([]);
      atHome.current = false; setPendingTaxon(null); prime(ready);
      setDetails(result); setAnchor(result.anchor);
      setCamera(result.anchor === anchor ? animate(nextCamera) : { ...nextCamera, transitionDuration: 0 });
    }).catch(error => { if (!controller.signal.aborted) { setNavigationError(error.message); setPendingTaxon(null); } });
  }, [client, size, anchor, camera, details, startFocus, prime]);
  const goHome = () => {
    if (!atHome.current || details) { setPast(history => [...history.slice(-49), { camera, anchor, details, home: atHome.current }]); setFuture([]); }
    focusRequest.current?.abort(); atHome.current = true;
    setPendingTaxon(null);
    setDetails(null); setQuery(''); setSearchOpen(false); setNavigationError(null); setAnchor(0);
    setCamera(anchor === 0 ? animate(homeCamera) : { ...homeCamera, transitionDuration: 0 });
  };
  const revisit = (direction: 'back' | 'forward') => {
    const history = direction === 'back' ? past : future, visit = history.at(-1);
    if (!visit) return;
    focusRequest.current?.abort(); setPendingTaxon(null); setNavigationError(null);
    const current = { camera, anchor, details, home: atHome.current };
    if (direction === 'back') { setPast(history.slice(0, -1)); setFuture(values => [...values, current]); }
    else { setFuture(history.slice(0, -1)); setPast(values => [...values, current]); }
    atHome.current = visit.home; setDetails(visit.details); setAnchor(visit.anchor);
    setCamera({ ...visit.camera, transitionDuration: 0 }); setQuery(''); setSearchOpen(false);
  };
  const zoomBy = (amount: number) => {
    atHome.current = false;
    setCamera(current => animate({ ...current, zoom: Math.max(current.minZoom, Math.min(current.maxZoom, current.zoom + amount)) }));
  };
  const lineage = useMemo(() => details?.lineage ?? [], [details]);
  const lineageIds = useMemo(() => new Set(lineage.map(node => node.id)), [lineage]);
  const namedLineage = lineage.filter(node => !node.isSyntheticNode);
  const breadcrumbs = namedLineage.length > 8 ? [namedLineage[0], ...namedLineage.slice(-6)] : namedLineage;
  const descendants = details?.children ?? [];
  const labelNodes = useMemo(() => visibleLabels(manifest.presentation === 'life' ? namedNodes.filter(n => n.index !== 0) : namedNodes, camera, size, selected?.id), [namedNodes, camera, size, selected, manifest.presentation]);
  const regions = useMemo(() => namedNodes.filter(node => node.region.length > 0 && (node.index !== 0 || node.collapsedCount)).sort((a, b) => a.depth - b.depth), [namedNodes]);
  const lineData = useMemo(() => {
    const lines = scene?.lines ?? new Float64Array();
    return { length: lines.length / 4, attributes: {
      getSourcePosition: { value: lines, size: 2, stride: 32, offset: 0 },
      getTargetPosition: { value: lines, size: 2, stride: 32, offset: 16 },
    } };
  }, [scene]);
  const highlightedLines = useMemo(() => {
    const indices = new Set(lineage.map(node => node.index));
    const values: number[] = [];
    scene?.lineTargets.forEach((index, i) => { if (indices.has(index)) values.push(...scene.lines.subarray(i * 4, i * 4 + 4)); });
    const lines = new Float64Array(values);
    return { length: lines.length / 4, attributes: {
      getSourcePosition: { value: lines, size: 2, stride: 32, offset: 0 },
      getTargetPosition: { value: lines, size: 2, stride: 32, offset: 16 },
    } };
  }, [scene, lineage]);
  const layers = useMemo(() => {
    const parameters = { depthCompare: 'always' as const, depthWriteEnabled: false };
    return [
      new PolygonLayer<StreamNode>({ id: 'clade-regions', data: regions, visible: showRegions, parameters, pickable: true,
        getPolygon: node => node.region, getFillColor: node => node.group ? DOMAIN_COLORS[node.group] : PALETTE[node.depth % PALETTE.length],
        stroked: true, getLineColor: [96, 128, 116, 40], getLineWidth: 1, lineWidthUnits: 'pixels' }),
      new LineLayer({ id: 'branches', data: lineData, parameters, getColor: [107, 124, 116, 150], getWidth: 1.1, widthUnits: 'pixels' }),
      new LineLayer({ id: 'lineage', data: highlightedLines, parameters, getColor: [37, 118, 99, 255], getWidth: 2.5, widthUnits: 'pixels' }),
      new ScatterplotLayer<MapTreeNode>({ id: 'nodes', data: namedNodes, pickable: true, parameters,
        getPosition: node => node.position, radiusUnits: 'pixels',
        getRadius: node => node.id === selected?.id ? 7 : node.isTerminal ? 3 : 4.5,
        getFillColor: node => node.id === selected?.id ? [30, 119, 99] : lineageIds.has(node.id) ? [79, 144, 126] : [75, 94, 83],
        stroked: true, getLineColor: [255, 255, 255], getLineWidth: 1.5, lineWidthUnits: 'pixels',
        updateTriggers: { getRadius: [selected?.id], getFillColor: [selected?.id, lineageIds] } }),
      new TextLayer<MapTreeNode>({ id: 'labels', data: labelNodes, pickable: true, parameters,
        getPosition: node => node.position, getText: node => labelText(node, size), getSize: labelSize,
        sizeUnits: 'pixels', fontFamily: 'Arial, sans-serif', fontWeight: 500,
        getColor: node => node.id === selected?.id ? [24, 105, 84] : [43, 61, 50],
        getPixelOffset: node => labelOffset(node, camera, size), getTextAnchor: 'middle', getAlignmentBaseline: 'bottom',
        background: true, getBackgroundColor: [248, 249, 244, 230], backgroundPadding: [4, 2],
        updateTriggers: { getColor: [selected?.id], getText: [size.width], getPixelOffset: [camera, size] } }),
    ];
  }, [regions, showRegions, lineData, highlightedLines, lineageIds, namedNodes, selected, labelNodes, camera, size]);
  return (
    <main className="app" ref={container}>
      <DeckGL views={VIEW} viewState={camera} layers={layers}
        controller={{ dragPan: true, scrollZoom: { speed: 0.03, smooth: true }, doubleClickZoom: true, touchZoom: true, touchRotate: false, keyboard: true }}
        onViewStateChange={({ viewState, interactionState }) => {
          if (interactionState.isDragging || interactionState.isZooming) atHome.current = false;
          setCamera(viewState as CameraState);
        }}
        getCursor={({ isDragging, isHovering }) => isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'}
        getTooltip={({ object }) => object && 'scientificName' in object ? { text: object.scientificName } : null}
        onClick={info => {
          if (info.object) focusNode(info.object as StreamNode);
          else { focusRequest.current?.abort(); setPendingTaxon(null); setDetails(null); setSearchOpen(false); }
        }}
        onError={error => setRenderError(error.message)}
        onAfterRender={() => { if (scene) telemetry.onPaint(scene.nodes.some(n => n.index === selected?.index) ? selected?.index : undefined); }}
      />
      <header className="top-bar">
        <div className="brand"><span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M16 27V17M16 17L7 10V5M16 17L25 10V5M16 17V6M7 10L3 7M25 10L29 7" /><circle cx="16" cy="5" r="2" /></svg></span><div>Tree of Life{manifest.synthetic ? <span className="brand-subtitle">GENERATED SCALE TEST</span> : <select className="brand-subtitle dataset-select" aria-label="Tree dataset" value={manifest.presentation === 'life' ? 'life' : manifest.root.ottId === 81461 ? 'aves' : 'primates'} onChange={event => {
          const url = new URL(window.location.href); url.searchParams.set('dataset', event.target.value); window.location.assign(url);
        }}><option value="life">CELLULAR LIFE</option><option value="aves">BIRDS · AVES</option><option value="primates">PRIMATES</option></select>}</div></div>
        <div className="search-box" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setSearchOpen(false); }}>
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input aria-label="Search taxa" placeholder="Search a taxon or OpenTree ID…" value={query}
            role="combobox" aria-autocomplete="list" aria-expanded={searchOpen && !!query.trim()} aria-controls="taxon-results"
            aria-activedescendant={searchOpen && results[activeResult] ? `result-${results[activeResult].id}` : undefined}
            onFocus={() => setSearchOpen(true)}
            onChange={event => { setQuery(event.target.value); setActiveResult(0); setSearchOpen(true); }}
            onKeyDown={event => {
              if (event.key === 'Escape') { setSearchOpen(false); return; }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault(); setSearchOpen(true);
                setActiveResult(index => results.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length : 0);
              }
              if (event.key === 'Enter' && results[activeResult]) { event.preventDefault(); focusNode(results[activeResult]); }
            }} />
          {query && <button className="search-clear" aria-label="Clear search" onClick={() => { setQuery(''); setActiveResult(0); }}>×</button>}
          {searchOpen && query.trim() && <div className="search-results" id="taxon-results" role="listbox" aria-label="Matching taxa">
            {results.length ? results.map((node, index) => <button type="button" role="option" aria-selected={index === activeResult}
              id={`result-${node.id}`} key={node.id} onClick={() => focusNode(node)}>
              <span>{node.scientificName}</span><small>{node.isTerminal ? 'Terminal taxon' : `${node.leafCount} terminal taxa`}</small>
            </button>) : <p role="status">{searching ? 'Searching…' : 'No matching taxa in this dataset.'}</p>}
          </div>}
        </div>
      </header>
      <nav className="map-controls" aria-label="Map controls">
        <button onClick={() => revisit('back')} disabled={!past.length} aria-label="Back to previous view" title="Back">←</button>
        <button onClick={() => revisit('forward')} disabled={!future.length} aria-label="Forward to next view" title="Forward">→</button>
        <button onClick={() => zoomBy(1)} aria-label="Zoom in" title="Zoom in">+</button>
        <button onClick={() => zoomBy(-1)} aria-label="Zoom out" title="Zoom out">−</button>
        <button onClick={goHome} aria-label="Home — fit entire tree" title="Fit entire tree">⌂</button>
        <button className="region-toggle" onClick={() => setShowRegions(value => !value)} aria-label="Show clade regions" aria-pressed={showRegions} title="Toggle clade regions">◒</button>
      </nav>
      {selected && <nav className="breadcrumbs" aria-label="Taxon lineage">
        {breadcrumbs.map((node, index) => <span key={node.id}>{index > 0 && <span className="separator">{index === 1 && namedLineage.length > 8 ? '…' : '›'}</span>}
          <button onClick={() => focusNode(node)} aria-current={node.id === selected.id ? 'location' : undefined}>{node.scientificName}</button>
        </span>)}
      </nav>}
      <footer className="map-footer"><span><strong>{manifest.namedCount.toLocaleString()}</strong> named taxa · {root.leafCount} tips<span className="desktop-hint"> · Drag to pan · Scroll to zoom</span></span>
        <span className="attribution">{manifest.synthetic ? 'Generated benchmark data · ' : 'Data: Open Tree of Life · '}{manifest.provenance && <><a href={`${import.meta.env.BASE_URL}data/${manifest.presentation === 'life' ? 'life' : 'aves'}/${manifest.version}/manifest.json`} target="_blank" rel="noreferrer">{manifest.provenance.synthId}</a> · </>}<a href="https://lifemap.cnrs.fr/" target="_blank" rel="noreferrer">Inspired by Lifemap</a></span>
      </footer>
      {selected && <aside className="detail-panel" aria-label="Taxon details">
        <button className="close-button" onClick={() => { focusRequest.current?.abort(); setPendingTaxon(null); setDetails(null); }} aria-label="Close details">×</button>
        <div className="rank">{selected.rank ?? (selected.isTerminal ? 'Terminal taxon' : 'Clade')}</div>
        <h1>{selected.scientificName}</h1>
        {selected.commonName && <p className="common-name">{selected.commonName}</p>}
        <div className="taxon-stat"><strong>{selected.leafCount.toLocaleString()}</strong><span>terminal {selected.leafCount === 1 ? 'taxon' : 'taxa'} in this subtree</span></div>
        <p className="data-note">{manifest.synthetic ? 'Generated data for performance testing. These are not biological taxa.' : 'Relationships follow the OpenTree synthesis. Tips represent terminal taxa, not necessarily species. Distances on this map do not represent evolutionary time.'}</p>
        {manifest.provenance && <p className="data-note">Synthesis {manifest.provenance.synthId} · Taxonomy {manifest.provenance.taxonomyVersion}<br />Retrieved {manifest.provenance.fetchedAt.slice(0, 10)}</p>}
        {selected.ottId && <a className="source-link" href={`https://tree.opentreeoflife.org/taxonomy/browse?id=${selected.ottId}`} target="_blank" rel="noreferrer">OpenTree · OTT {selected.ottId} ↗</a>}
        {descendants.length > 0 && <section><h2>Explore this clade</h2><div className="descendant-list">{descendants.map(node =>
          <button key={node.id} onClick={() => focusNode(node)}><span>{node.scientificName}</span><small>{node.leafCount} ›</small></button>)}</div></section>}
        <section><h2>Lineage</h2><div className="lineage">{namedLineage.map(node =>
          <button key={node.id} onClick={() => focusNode(node)} aria-current={node.id === selected.id ? 'location' : undefined}>{node.scientificName}</button>)}</div></section>
      </aside>}
      {(streamError || navigationError) && <div className="stream-notice" role="alert">{streamError || navigationError}</div>}
      {pendingTaxon && <div className="stream-notice" role="status">Opening {pendingTaxon}…</div>}
      {!scene && <div className="stream-notice" role="status">Loading this part of the tree…</div>}
      {scene?.stats.limited && <div className="stream-notice" role="status">Showing an overview. Zoom in for more detail.</div>}
      {details?.childrenTruncated && selected && <div className="children-note">Showing {descendants.length} named descendants. Search to find more.</div>}
      {manifest.presentation === 'life' && !selected && anchor === 0 && camera.zoom <= homeCamera.zoom + 0.15 && <div className="explore-hint"><span>Explore a branch.</span>Choose a group or zoom in to explore.</div>}
      {benchmarkMode && <aside className="benchmark-panel" aria-label="Performance diagnostics">
        <strong>{manifest.title}</strong>
        <div>{manifest.nodeCount.toLocaleString()} total nodes · {scene?.nodes.length ?? 0} loaded for display</div>
        <div>First map: {telemetry.metrics.firstMapMs?.toFixed(0) ?? '…'} ms · Scene query: {scene?.stats.queryMs.toFixed(1) ?? '…'} ms</div>
        <div>Decoded payload: {((scene?.stats.transferredBytes ?? 0) / 1024).toFixed(0)} KiB · Cache charge: {((scene?.stats.cacheBytes ?? 0) / 1048576).toFixed(1)} / {cacheBudget(manifest) / 1048576} MiB</div>
        <div>Requests: {scene?.stats.requests ?? 0} · Visited: {scene?.stats.visited ?? 0} · Frame: {anchor}</div>
        <button onClick={telemetry.run} disabled={telemetry.running || !scene}>{telemetry.running ? 'Measuring…' : 'Run motion benchmark'}</button>
        <output aria-label="Browser benchmark result">{JSON.stringify(telemetry.metrics)}</output>
      </aside>}
      {renderError && <div className="error-card" role="alert"><h1>The map could not be rendered</h1><p>{renderError}</p><p>Check that WebGL is enabled, then reload the page.</p><button onClick={() => window.location.reload()}>Reload</button></div>}
    </main>
  );
}

function App() {
  const [loaded, setLoaded] = useState<{ client: TreeClient; manifest: Manifest } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const client = new TreeClient();
    const controller = new AbortController();
    const fixture = new URLSearchParams(window.location.search).get('dataset');
    const path = fixture && /^(balanced|unbalanced)-(10000|100000|1000000)$/.test(fixture)
      ? `${import.meta.env.BASE_URL}benchmarks/${fixture}/manifest.json`
      : `${import.meta.env.BASE_URL}data/${fixture === 'primates' ? 'primates' : fixture === 'aves' ? 'aves' : 'life'}/manifest.json`;
    void client.init(new URL(path, window.location.href).href, controller.signal)
      .then(manifest => setLoaded({ client, manifest }))
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => { controller.abort(); client.close(); };
  }, [attempt]);
  if (error) return <main className="app loading-message" role="alert"><div><h1>Unable to open the tree</h1><p>{error}</p><button onClick={() => { setError(null); setAttempt(value => value + 1); }}>Try again</button></div></main>;
  if (!loaded) return <main className="app loading-message" role="status"><div className="loading-indicator" /><p>Opening the tree map…</p></main>;
  return <TreeMap client={loaded.client} manifest={loaded.manifest} />;
}
export default App;
