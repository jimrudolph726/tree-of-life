import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DeckGL } from '@deck.gl/react';
import { LinearInterpolator, OrthographicView, type TransitionInterpolator } from '@deck.gl/core';
import { LineLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { MapTreeNode } from './tree/layoutTreeV3';
import { centeredFocusCamera, fitBounds, focusBounds, labelOffset, labelSize, labelText, mapInsets, visibleLabels, zoomOutCamera } from './tree/navigation';
import type { Camera, Size } from './tree/navigation';
import { TreeClient } from './stream/client';
import type { Details, Manifest, Scene, StreamNode, Summary } from './stream/format';
import { cacheBudget } from './stream/format';
import { useScene } from './stream/useScene';
import { cameraFromView, deckView, reframe } from './stream/reframe';
import { useBrowserMetrics } from './stream/useBrowserMetrics';
import { ProfileClient } from './profiles/client';
import type { ScientificProfile } from './profiles/types';
import type { ProfileSearchHit } from './profiles/types';
import { JourneyClient } from './journeys/client';
import type { Journey, JourneySummary } from './journeys/types';
import './App.css';

const JourneyPanel = lazy(() => import('./journeys/JourneyPanel.tsx'));

const TRANSITION = new LinearInterpolator(['target', 'zoomX', 'zoomY']);
const JOURNEY_CONTEXT_ZOOM_OUT = 1;
const JOURNEY_CONTEXT_MAX_ZOOM = 11;
const PALETTE: [number, number, number, number][] = [[84, 143, 121, 24], [87, 125, 162, 24], [185, 141, 82, 24], [140, 117, 163, 24]];
const DOMAIN_COLORS: [number, number, number, number][] = [[84, 143, 121, 18], [99, 140, 172, 32], [94, 153, 126, 32], [192, 137, 97, 32]];
type CameraState = Camera & { transitionDuration?: number | 'auto'; transitionInterpolator?: TransitionInterpolator };
type Visit = { camera: CameraState; anchor: number; details: Details | null; home: boolean };
type FocusTarget = { details: Details; camera: Camera };
type PreparedFocus = { target: Promise<FocusTarget>; ready: Promise<FocusTarget & { scene: Scene }> };
type ProfileState = { ottId: number; status: 'ready' | 'missing' | 'error'; profile?: ScientificProfile; error?: string };
type SearchResult = { node: Summary; commonName?: string; rank?: string; matchedName?: string;
  matchKind?: ProfileSearchHit['matchKind'] | 'OpenTree ID' };
type JourneyState = { view: 'closed' | 'library' | 'playing' | 'paused' | 'complete'; journeyId: string; step: number };
const getSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight });
const animate = (camera: Camera): CameraState => ({ ...camera,
  transitionDuration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650, transitionInterpolator: TRANSITION });
const EMPTY_NODES: StreamNode[] = [];
const benchmarkMode = new URLSearchParams(window.location.search).has('bench');

function initialJourneyState(): JourneyState {
  const params = new URLSearchParams(window.location.search);
  const journeyId = params.get('journey');
  if (!journeyId || !/^[a-z0-9-]+$/.test(journeyId)) return { view: 'closed', journeyId: 'birds-flight', step: 0 };
  return { view: 'playing', journeyId, step: Math.max(0, Number(params.get('step')) || 0) };
}

function updateJourneyUrl(view: JourneyState['view'], journeyId: string, step: number) {
  const url = new URL(window.location.href);
  if (view === 'closed' || view === 'library') { url.searchParams.delete('journey'); url.searchParams.delete('step'); }
  else { url.searchParams.set('journey', journeyId); url.searchParams.set('step', String(step)); }
  window.history.replaceState(null, '', url);
}

function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Request cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

function isPositioned(node: Summary): node is StreamNode {
  return 'bounds' in node && 'position' in node && 'radius' in node;
}

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

function TreeMap({ client, profileClient, journeyClient, manifest }: { client: TreeClient; profileClient: ProfileClient;
  journeyClient: JourneyClient; manifest: Manifest }) {
  const root = useMemo(() => rootNode(manifest), [manifest]);
  const container = useRef<HTMLElement>(null);
  const atHome = useRef(true);
  const focusRequest = useRef<AbortController | null>(null);
  const [size, setSize] = useState(getSize);
  const [camera, setCamera] = useState<CameraState>(() => openingCamera(root, getSize(), manifest));
  const [anchor, setAnchor] = useState(0);
  const view = useMemo(() => new OrthographicView({ id: `tree-${anchor}`, flipY: true }), [anchor]);
  const interaction = useRef({ active: false, changedAt: 0 });
  const [details, setDetails] = useState<Details | null>(null);
  const [pendingNode, setPendingNode] = useState<Summary | null>(null);
  const [pendingTaxon, setPendingTaxon] = useState<string | null>(null);
  const [past, setPast] = useState<Visit[]>([]);
  const [future, setFuture] = useState<Visit[]>([]);
  const selected = pendingNode ?? details?.node ?? null;
  const [profileState, setProfileState] = useState<ProfileState | null>(null);
  const [query, setQuery] = useState('');
  const [searchState, setSearchState] = useState<{ query: string; results: SearchResult[] }>({ query: '', results: [] });
  const searching = query.trim() !== searchState.query;
  const results = useMemo(() => searching ? [] : searchState.results, [searching, searchState.results]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeResult, setActiveResult] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [showRegions, setShowRegions] = useState(true);
  const [journeyState, setJourneyState] = useState<JourneyState>(initialJourneyState);
  const [journeyCatalog, setJourneyCatalog] = useState<JourneySummary[]>([]);
  const [activeJourney, setActiveJourney] = useState<Journey | null>(null);
  const [datasetMenuOpen, setDatasetMenuOpen] = useState(false);
  const [journeyMenuOpen, setJourneyMenuOpen] = useState(false);
  const initialJourneyLoaded = useRef(false);
  const homeCamera = useMemo(() => openingCamera(root, size, manifest), [root, size, manifest]);
  const { scene, error: streamError, prime } = useScene(client, anchor, camera, size, (nextAnchor, nextCamera) => {
    setAnchor(nextAnchor); setCamera({ ...nextCamera, transitionDuration: 0 });
  }, () => !interaction.current.active && performance.now() - interaction.current.changedAt > 300);
  const telemetry = useBrowserMetrics(benchmarkMode, camera, value => { atHome.current = false; setCamera({ ...value, transitionDuration: 0 }); });
  const { startFocus, recordFocusReady, recordSearch } = telemetry;
  const namedNodes = scene?.nodes ?? EMPTY_NODES;
  const preparedFocus = useRef(new Map<string, PreparedFocus>());
  const hoverPrefetch = useRef<{ index: number; timer: number } | null>(null);
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
  useEffect(() => () => {
    focusRequest.current?.abort();
    if (hoverPrefetch.current) clearTimeout(hoverPrefetch.current.timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const started = performance.now();
    const timer = setTimeout(() => {
      const directRequest = client.search(query, controller.signal);
      void directRequest.then(direct => {
        setSearchState({ query: query.trim(), results: direct.map(node => ({ node,
          matchKind: /^(?:ott)?\d+$/i.test(query.trim()) ? 'OpenTree ID' : undefined })) });
        if (query.trim()) recordSearch(performance.now() - started);
      }).catch(error => { if (!controller.signal.aborted) setNavigationError(error.message); });
      const profileRequest = profileClient.search(query, controller.signal).catch(error => {
        if (controller.signal.aborted) throw error;
        return [] as ProfileSearchHit[];
      });
      void Promise.all([directRequest, profileRequest]).then(async ([direct, profileHits]) => {
        controller.signal.throwIfAborted();
        const profileByOtt = new Map(profileHits.map(hit => [hit.ottId, hit]));
        const combined = new Map<number, SearchResult>();
        for (const node of direct) {
          const hit = node.ottId ? profileByOtt.get(node.ottId) : undefined;
          combined.set(node.index, { node, commonName: hit?.commonName, rank: hit?.rank,
            matchedName: hit?.matchedName, matchKind: hit?.matchKind ?? (/^(?:ott)?\d+$/i.test(query.trim()) ? 'OpenTree ID' : undefined) });
        }
        const missing = profileHits.filter(hit => ![...combined.values()].some(result => result.node.ottId === hit.ottId)).slice(0, 8);
        const resolved = await Promise.all(missing.map(async hit => {
          const nodes = await client.search(`ott${hit.ottId}`, controller.signal);
          const node = nodes.find(item => item.ottId === hit.ottId);
          return node ? { node, commonName: hit.commonName, rank: hit.rank, matchedName: hit.matchedName, matchKind: hit.matchKind } satisfies SearchResult : null;
        }));
        for (const result of resolved) if (result && !combined.has(result.node.index)) combined.set(result.node.index, result);
        const results = [...combined.values()].sort((a, b) => {
          const aHit = profileByOtt.get(a.node.ottId ?? -1), bHit = profileByOtt.get(b.node.ottId ?? -1);
          return Number(!aHit) - Number(!bHit) || a.node.scientificName.localeCompare(b.node.scientificName);
        }).slice(0, 12);
        setSearchState({ query: query.trim(), results });
      }).catch(error => { if (!controller.signal.aborted) setNavigationError(error.message); });
    }, 160);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [client, profileClient, query, recordSearch]);
  useEffect(() => {
    const ottId = selected?.ottId;
    if (!ottId || manifest.synthetic) return;
    const controller = new AbortController();
    void profileClient.profile(ottId, controller.signal).then(profile => {
      setProfileState(profile ? { ottId, status: 'ready', profile } : { ottId, status: 'missing' });
    }).catch(error => {
      if (!controller.signal.aborted) setProfileState({ ottId, status: 'error', error: error.message });
    });
    return () => controller.abort();
  }, [profileClient, selected?.ottId, manifest.synthetic]);
  const prepareFocus = useCallback((node: Summary, zoomOut = 0, maximumZoom = Infinity): PreparedFocus => {
    const key = `${node.index}:${Math.round(size.width)}x${Math.round(size.height)}:${zoomOut}:${maximumZoom}`;
    const cached = preparedFocus.current.get(key);
    if (cached) {
      preparedFocus.current.delete(key); preparedFocus.current.set(key, cached);
      return cached;
    }
    const target = client.prefetchDetails(node.index).then(details => ({ details,
      camera: zoomOutCamera(centeredFocusCamera(details.focus, size), zoomOut, maximumZoom) }));
    const ready = target.then(async value => {
      const scene = await client.view({ anchor: value.details.anchor, camera: value.camera, size });
      const settled = scene.rebase ? reframe(scene, value.camera) : { scene, camera: value.camera };
      if (!settled.scene.nodes.length) throw new Error('This part of the tree could not be drawn. Please try again.');
      return { ...value, ...settled };
    });
    const prepared = { target, ready };
    preparedFocus.current.set(key, prepared);
    while (preparedFocus.current.size > 24) preparedFocus.current.delete(preparedFocus.current.keys().next().value!);
    void ready.catch(() => { if (preparedFocus.current.get(key) === prepared) preparedFocus.current.delete(key); });
    return prepared;
  }, [client, size]);
  const queuePrefetch = useCallback((node?: Summary) => {
    if (!node) {
      if (hoverPrefetch.current) clearTimeout(hoverPrefetch.current.timer);
      hoverPrefetch.current = null; return;
    }
    if (hoverPrefetch.current?.index === node.index) return;
    if (hoverPrefetch.current) clearTimeout(hoverPrefetch.current.timer);
    hoverPrefetch.current = { index: node.index, timer: window.setTimeout(() => {
      hoverPrefetch.current = null;
      void client.prefetchDetails(node.index).catch(() => undefined);
      void profileClient.prefetch(node.ottId).catch(() => undefined);
    }, 180) };
  }, [client, profileClient]);
  const prefetchNow = useCallback((node: Summary) => {
    if (hoverPrefetch.current) clearTimeout(hoverPrefetch.current.timer);
    hoverPrefetch.current = null;
    void prepareFocus(node).ready.catch(() => undefined);
    void profileClient.prefetch(node.ottId).catch(() => undefined);
  }, [prepareFocus, profileClient]);
  useEffect(() => {
    const active = searchOpen ? results[activeResult]?.node : undefined;
    if (active) queuePrefetch(active);
    return () => queuePrefetch();
  }, [searchOpen, results, activeResult, queuePrefetch]);
  const focusNode = useCallback((node: Summary, preserveJourney = false, zoomOut = 0, maximumZoom = Infinity) => {
    if (!preserveJourney && journeyState.view === 'playing') setJourneyState(current => ({ ...current, view: 'paused' }));
    startFocus(node.index);
    focusRequest.current?.abort();
    const controller = new AbortController(); focusRequest.current = controller;
    const previous = { camera, anchor, details, home: atHome.current };
    const prepared = prepareFocus(node, zoomOut, maximumZoom);
    if (isPositioned(node)) {
      atHome.current = false;
      setCamera(animate(zoomOutCamera(centeredFocusCamera(node, size), zoomOut, maximumZoom)));
    }
    setPendingNode(node); setDetails(null);
    setPendingTaxon(node.scientificName);
    setNavigationError(null); setSearchOpen(false); setQuery('');
    void waitForSignal(prepared.target, controller.signal).then(async target => {
      setPendingNode(null); setDetails(target.details);
      const completed = await waitForSignal(prepared.ready, controller.signal);
      if (controller.signal.aborted) return;
      setPast(history => [...history.slice(-49), previous]); setFuture([]);
      atHome.current = false; setPendingTaxon(null); prime(completed.scene);
      setDetails(completed.details); setAnchor(completed.scene.anchor);
      setCamera(completed.scene.anchor === anchor ? animate(completed.camera) : { ...completed.camera, transitionDuration: 0 });
      recordFocusReady(node.index);
    }).catch(error => { if (!controller.signal.aborted) {
      atHome.current = previous.home; setNavigationError(error.message); setPendingTaxon(null); setPendingNode(null);
      setDetails(previous.details); setCamera(animate(previous.camera));
    } });
  }, [size, anchor, camera, details, startFocus, recordFocusReady, prime, prepareFocus, journeyState.view]);
  const loadJourneyCatalog = useCallback(() => {
    void journeyClient.catalog().then(setJourneyCatalog).catch(error => setNavigationError(error.message));
  }, [journeyClient]);
  const openJourney = useCallback((journeyId: string) => {
    const saved = Math.max(0, Number(localStorage.getItem(`tree-of-life:journey:${journeyId}`)) || 0);
    setJourneyState({ view: 'library', journeyId, step: saved });
    setActiveJourney(null); updateJourneyUrl('library', journeyId, saved);
    void Promise.all([journeyClient.catalog(), journeyClient.journey(journeyId)]).then(([catalog, journey]) => {
      setJourneyCatalog(catalog); setActiveJourney(journey);
      setJourneyState(current => current.journeyId === journeyId
        ? { ...current, step: Math.min(current.step, journey.steps.length - 1) } : current);
    }).catch(error => setNavigationError(error.message));
  }, [journeyClient]);
  const goJourneyStep = useCallback((step: number, requestedJourneyId?: string) => {
    if (manifest.presentation !== 'life') return;
    const journeyId = requestedJourneyId ?? journeyState.journeyId;
    void journeyClient.journey(journeyId).then(async journey => {
      setActiveJourney(journey);
      const bounded = Math.max(0, Math.min(journey.steps.length - 1, step));
      const current = journey.steps[bounded];
      const matches = await client.search(`ott${current.ottId}`);
      const node = matches.find(item => item.ottId === current.ottId);
      if (!node) throw new Error(`${current.mapTaxon ?? current.taxon} is not available in this tree publication.`);
      setJourneyState({ view: 'playing', journeyId, step: bounded });
      localStorage.setItem(`tree-of-life:journey:${journeyId}`, String(bounded));
      updateJourneyUrl('playing', journeyId, bounded);
      focusNode(node, true, JOURNEY_CONTEXT_ZOOM_OUT, JOURNEY_CONTEXT_MAX_ZOOM);
    }).catch(error => setNavigationError(error.message));
  }, [client, focusNode, journeyClient, journeyState.journeyId, manifest.presentation]);
  useEffect(() => {
    if (initialJourneyLoaded.current || journeyState.view !== 'playing') return;
    initialJourneyLoaded.current = true;
    loadJourneyCatalog(); goJourneyStep(journeyState.step, journeyState.journeyId);
  }, [goJourneyStep, journeyState.journeyId, journeyState.step, journeyState.view, loadJourneyCatalog]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (journeyState.view !== 'playing' || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === 'ArrowLeft' && journeyState.step > 0) { event.preventDefault(); goJourneyStep(journeyState.step - 1); }
      if (event.key === 'ArrowRight' && journeyState.step < (activeJourney?.steps.length ?? 1) - 1) { event.preventDefault(); goJourneyStep(journeyState.step + 1); }
      if (event.key === 'Escape') setJourneyState(current => ({ ...current, view: 'paused' }));
    };
    window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeJourney, goJourneyStep, journeyState]);
  const goHome = () => {
    if (journeyState.view === 'playing') setJourneyState(current => ({ ...current, view: 'paused' }));
    if (!atHome.current || details) { setPast(history => [...history.slice(-49), { camera, anchor, details, home: atHome.current }]); setFuture([]); }
    focusRequest.current?.abort(); atHome.current = true;
    setPendingTaxon(null); setPendingNode(null);
    setDetails(null); setQuery(''); setSearchOpen(false); setNavigationError(null); setAnchor(0);
    setCamera(anchor === 0 ? animate(homeCamera) : { ...homeCamera, transitionDuration: 0 });
  };
  const revisit = (direction: 'back' | 'forward') => {
    const history = direction === 'back' ? past : future, visit = history.at(-1);
    if (!visit) return;
    focusRequest.current?.abort(); setPendingTaxon(null); setPendingNode(null); setNavigationError(null);
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
  const selectedProfileState = profileState?.ottId === selected?.ottId ? profileState : null;
  const profile = selectedProfileState?.profile;
  const profileStatus = selected?.ottId && !manifest.synthetic ? selectedProfileState?.status ?? 'loading' : undefined;
  const articleName = profile?.wikipedia?.title;
  const canonicalCommonName = articleName && profile?.commonNames.find(item => item.name.localeCompare(articleName, undefined, { sensitivity: 'base' }) === 0)?.name;
  const primaryCommonName = canonicalCommonName ?? profile?.commonNames[0]?.name ?? selected?.commonName;
  const otherCommonNames = profile?.commonNames.filter(item => item.name !== primaryCommonName) ?? [];
  const profileImageUrl = profile?.image ? new URL(profile.image.src,
    new URL(import.meta.env.BASE_URL, window.location.href)).href : undefined;
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
  const activeDataset = manifest.presentation === 'life' ? 'life' : manifest.root.ottId === 81461 ? 'aves' : 'primates';
  return (
    <main className="app" ref={container} data-tree-ready={Boolean(scene)} data-pending-taxon={pendingTaxon ?? undefined}
      data-profile-status={profileStatus}
      data-scene-node-count={scene?.nodes.length ?? 0}
      data-camera-zoom={camera.zoom.toFixed(4)} data-camera-target={camera.target.slice(0, 2).map(value => value.toFixed(3)).join(',')}>
      <DeckGL views={view} viewState={deckView(camera)} layers={layers}
        controller={{ dragPan: true, scrollZoom: { speed: 0.03, smooth: true }, doubleClickZoom: true, touchZoom: true, touchRotate: false, keyboard: true }}
        onViewStateChange={({ viewState, interactionState }) => {
          if (interactionState.isDragging || interactionState.isZooming) atHome.current = false;
          interaction.current.changedAt = performance.now();
          setCamera({ ...cameraFromView(viewState, camera),
            transitionDuration: viewState.transitionDuration,
            transitionInterpolator: viewState.transitionInterpolator });
        }}
        onInteractionStateChange={state => {
          interaction.current.active = !!(state.isDragging || state.isZooming || state.isPanning);
        }}
        getCursor={({ isDragging, isHovering }) => isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'}
        getTooltip={({ object }) => object && 'scientificName' in object ? { text: object.scientificName } : null}
        onHover={info => queuePrefetch(info.object && 'scientificName' in info.object ? info.object as StreamNode : undefined)}
        onClick={info => {
          if (info.object) focusNode(info.object as StreamNode);
          else { focusRequest.current?.abort(); setPendingTaxon(null); setPendingNode(null); setDetails(null); setSearchOpen(false); }
        }}
        onError={error => setRenderError(error.message)}
        onAfterRender={() => { if (scene) telemetry.onPaint(scene.nodes.some(n => n.index === selected?.index) ? selected?.index : undefined); }}
      />
      <header className="top-bar">
        <div className="brand"><span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M16 27V17M16 17L7 10V5M16 17L25 10V5M16 17V6M7 10L3 7M25 10L29 7" /><circle cx="16" cy="5" r="2" /></svg></span><div>Tree of Life{manifest.synthetic && <span className="brand-subtitle">GENERATED SCALE TEST</span>}</div></div>
        <div className="search-box" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setSearchOpen(false); }}>
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input aria-label="Search taxa" placeholder="Search a taxon or OpenTree ID…" value={query}
            role="combobox" aria-autocomplete="list" aria-expanded={searchOpen && !!query.trim()} aria-controls="taxon-results"
            aria-activedescendant={searchOpen && results[activeResult] ? `result-${results[activeResult].node.id}` : undefined}
            onFocus={() => setSearchOpen(true)}
            onChange={event => { setQuery(event.target.value); setActiveResult(0); setSearchOpen(true); }}
            onKeyDown={event => {
              if (event.key === 'Escape') { setSearchOpen(false); return; }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault(); setSearchOpen(true);
                setActiveResult(index => results.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length : 0);
              }
              if (event.key === 'Enter' && results[activeResult]) { event.preventDefault(); focusNode(results[activeResult].node); }
            }} />
          {query && <button className="search-clear" aria-label="Clear search" onClick={() => { setQuery(''); setActiveResult(0); }}>×</button>}
          {searchOpen && query.trim() && <div className="search-results" id="taxon-results" role="listbox" aria-label="Matching taxa">
            {results.length ? results.map((result, index) => <button type="button" role="option" aria-selected={index === activeResult}
              id={`result-${result.node.id}`} key={result.node.id} onPointerEnter={() => queuePrefetch(result.node)} onPointerLeave={() => queuePrefetch()}
              onPointerDown={() => prefetchNow(result.node)} onFocus={() => queuePrefetch(result.node)} onClick={() => focusNode(result.node)}>
              <span className="search-result-title"><strong><span>{result.node.scientificName}</span></strong>{result.commonName && <em>{result.commonName}</em>}</span>
              <small><span>{result.rank ?? (result.node.isTerminal ? 'Terminal taxon' : 'Clade')}</span>
                <span>{result.matchKind && result.matchedName && result.matchedName.localeCompare(result.node.scientificName, undefined, { sensitivity: 'base' }) !== 0
                  ? `Matched ${result.matchKind}: ${result.matchedName}` : result.node.isTerminal ? '1 terminal taxon' : `${result.node.leafCount.toLocaleString()} terminal taxa`}</span></small>
            </button>) : <p role="status">{searching ? 'Searching…' : 'No matching taxa in this dataset.'}</p>}
          </div>}
        </div>
        {!manifest.synthetic && <div className="header-menu dataset-menu" onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setDatasetMenuOpen(false);
        }} onKeyDown={event => { if (event.key === 'Escape') setDatasetMenuOpen(false); }}>
          <button className="header-menu-trigger" aria-haspopup="menu" aria-expanded={datasetMenuOpen} onClick={() => {
            setJourneyMenuOpen(false); setDatasetMenuOpen(open => !open);
          }}>Explore <b aria-hidden="true">⌄</b></button>
          {datasetMenuOpen && <div className="header-menu-popover dataset-menu-popover" role="menu" aria-label="Tree datasets">
            <span>Choose a tree</span>
            {[['life', 'All life'], ['aves', 'Birds · Aves'], ['primates', 'Primates']].map(([id, label]) =>
              <button key={id} role="menuitemradio" aria-checked={activeDataset === id} onClick={() => {
                setDatasetMenuOpen(false);
                if (activeDataset === id) return;
                const url = new URL(window.location.href); url.searchParams.set('dataset', id); window.location.assign(url);
              }}><strong>{label}</strong><i aria-hidden="true">{activeDataset === id ? '✓' : ''}</i></button>)}
          </div>}
        </div>}
        {manifest.presentation === 'life' && <div className="header-menu" onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setJourneyMenuOpen(false);
        }} onKeyDown={event => { if (event.key === 'Escape') setJourneyMenuOpen(false); }}>
          <button className="header-menu-trigger" aria-haspopup="menu" aria-expanded={journeyMenuOpen} onClick={() => {
            setDatasetMenuOpen(false); setJourneyMenuOpen(open => !open); loadJourneyCatalog();
          }}>Journeys <b aria-hidden="true">⌄</b></button>
          {journeyMenuOpen && <div className="header-menu-popover" role="menu" aria-label="Guided journeys">
            <span>Guided journeys</span>
            {journeyCatalog.length ? journeyCatalog.map(item => <button key={item.id} className="journey-menu-item" role="menuitem" onClick={() => {
              setJourneyMenuOpen(false); openJourney(item.id);
            }}><strong>{item.category} · {item.title}</strong><small>{item.stepCount} stops · {item.duration}</small></button>)
              : <p className="journey-menu-loading">Loading journeys…</p>}
          </div>}
        </div>}
      </header>
      <nav className="map-controls" aria-label="Map controls">
        <button onClick={() => revisit('back')} disabled={!past.length} aria-label="Back to previous view" title="Back">←</button>
        <button onClick={() => revisit('forward')} disabled={!future.length} aria-label="Forward to next view" title="Forward">→</button>
        <button onClick={() => zoomBy(1)} aria-label="Zoom in" title="Zoom in">+</button>
        <button onClick={() => zoomBy(-1)} aria-label="Zoom out" title="Zoom out">−</button>
        <button onClick={goHome} aria-label="Home — fit entire tree" title="Fit entire tree">⌂</button>
        <button className="region-toggle" onClick={() => setShowRegions(value => !value)} aria-label="Show clade regions" aria-pressed={showRegions} title="Toggle clade regions">◒</button>
      </nav>
      {selected && breadcrumbs.length > 0 && <nav className="breadcrumbs" aria-label="Taxon lineage">
        {breadcrumbs.map((node, index) => <span key={node.id}>{index > 0 && <span className="separator">{index === 1 && namedLineage.length > 8 ? '…' : '›'}</span>}
          <button onPointerEnter={() => queuePrefetch(node)} onPointerLeave={() => queuePrefetch()} onPointerDown={() => prefetchNow(node)}
            onFocus={() => queuePrefetch(node)} onClick={() => focusNode(node)} aria-current={node.id === selected.id ? 'location' : undefined}>{node.scientificName}</button>
        </span>)}
      </nav>}
      <footer className="map-footer"><span><strong>{manifest.namedCount.toLocaleString()}</strong> named taxa · {root.leafCount} tips<span className="desktop-hint"> · Drag to pan · Scroll to zoom</span></span>
        <span className="attribution">{manifest.synthetic ? 'Generated benchmark data · ' : 'Data: Open Tree of Life · '}{manifest.provenance && <><a href={`${import.meta.env.BASE_URL}data/${manifest.presentation === 'life' ? 'life' : 'aves'}/${manifest.version}/manifest.json`} target="_blank" rel="noreferrer">{manifest.provenance.synthId}</a> · </>}<a href="https://lifemap.cnrs.fr/" target="_blank" rel="noreferrer">Inspired by Lifemap</a></span>
      </footer>
      {selected && !['library', 'playing', 'complete'].includes(journeyState.view) && <aside className="detail-panel" aria-label="Taxon details">
        <button className="close-button" onClick={() => { focusRequest.current?.abort(); setPendingTaxon(null); setPendingNode(null); setDetails(null); }} aria-label="Close details">×</button>
        <div className="rank">{profile?.rank ?? selected.rank ?? (selected.isTerminal ? 'Terminal taxon' : 'Clade')}</div>
        <h1>{selected.scientificName}</h1>
        {primaryCommonName && <p className="common-name">{primaryCommonName}</p>}
        <div className="taxon-stat"><strong>{selected.leafCount.toLocaleString()}</strong><span>terminal {selected.leafCount === 1 ? 'taxon' : 'taxa'} in this subtree</span></div>
        {profile?.image && profileImageUrl && <figure className="profile-image">
          <img src={profileImageUrl} alt={profile.image.alt} loading="lazy" decoding="async" />
          <figcaption>{profile.image.caption}<a href={profile.image.sourceUrl} target="_blank" rel="noreferrer">
            {profile.image.credit} · {profile.image.license} ↗</a></figcaption>
        </figure>}
        {profileStatus === 'loading' &&
          <section className="profile-loading" aria-label="Loading scientific profile"><span /><span /><span /></section>}
        {profile?.wikipedia && <section className="profile-about"><h2>About</h2><p>{profile.wikipedia.extract}</p>
          <a className="profile-attribution" href={`${profile.wikipedia.url}?oldid=${profile.wikipedia.revisionId}`} target="_blank" rel="noreferrer">
            From Wikipedia · revision {profile.wikipedia.revisionId} · CC BY-SA 4.0 ↗
          </a></section>}
        {profile?.facts && profile.facts.length > 0 && <section className="profile-facts"><h2>Field notes</h2><div>
          {profile.facts.map((fact, index) => <article key={`${fact.kind}:${fact.label}:${index}`}>
            <small>{fact.label}</small><p>{fact.value}</p>
            <a href={fact.source.url} target="_blank" rel="noreferrer">{fact.source.label} ↗</a>
          </article>)}</div></section>}
        {profile && profile.synonyms.length > 0 && <section><h2>Also known as</h2><div className="profile-tags">
          {profile.synonyms.map(name => <span key={name}>{name}</span>)}</div></section>}
        {otherCommonNames.length > 0 && <section><h2>Other common names</h2><div className="profile-tags common-tags">
          {otherCommonNames.map(item => <span key={`${item.name}:${item.source}`} title={item.source}>{item.name}</span>)}</div></section>}
        <p className="data-note">{manifest.synthetic ? 'Generated data for performance testing. These are not biological taxa.' : 'Relationships follow the OpenTree synthesis. Tips represent terminal taxa, not necessarily species. Distances on this map do not represent evolutionary time.'}</p>
        {manifest.provenance && <p className="data-note">Synthesis {manifest.provenance.synthId} · Taxonomy {manifest.provenance.taxonomyVersion}<br />Retrieved {manifest.provenance.fetchedAt.slice(0, 10)}</p>}
        {selectedProfileState?.status === 'error' && <p className="profile-error">Scientific profile unavailable. {selectedProfileState.error}</p>}
        {selected.ottId && <section className="profile-sources"><h2>Sources</h2><div>
          <a href={`https://tree.opentreeoflife.org/taxonomy/browse?id=${selected.ottId}`} target="_blank" rel="noreferrer"><span>OpenTree</span><small>OTT {selected.ottId}</small></a>
          {profile?.gbif && <a href={`https://www.gbif.org/species/${profile.gbif.usageKey}`} target="_blank" rel="noreferrer"><span>GBIF</span><small>Species {profile.gbif.usageKey}</small></a>}
          {profile?.wikipedia && <a href={profile.wikipedia.url} target="_blank" rel="noreferrer"><span>Wikipedia</span><small>{profile.wikipedia.title}</small></a>}
          {!profile?.wikipedia && profile?.wikidata && <a href={profile.wikidata.articleUrl} target="_blank" rel="noreferrer"><span>Wikipedia</span><small>{profile.wikidata.articleTitle}</small></a>}
          {profile?.wikipedia?.wikidataId && <a href={`https://www.wikidata.org/wiki/${profile.wikipedia.wikidataId}`} target="_blank" rel="noreferrer"><span>Wikidata</span><small>{profile.wikipedia.wikidataId}</small></a>}
          {profile?.wikidata && <a href={`https://www.wikidata.org/wiki/${profile.wikidata.itemId}`} target="_blank" rel="noreferrer"><span>Wikidata</span><small>{profile.wikidata.itemId}</small></a>}
        </div></section>}
        {descendants.length > 0 && <section><h2>Explore this clade</h2><div className="descendant-list">{descendants.map(node =>
          <button key={node.id} onPointerEnter={() => queuePrefetch(node)} onPointerLeave={() => queuePrefetch()}
            onPointerDown={() => prefetchNow(node)} onFocus={() => queuePrefetch(node)} onClick={() => focusNode(node)}>
            <span>{node.scientificName}</span><small>{node.leafCount} ›</small></button>)}</div></section>}
        <section><h2>Lineage</h2><div className="lineage">{namedLineage.map(node =>
          <button key={node.id} onPointerEnter={() => queuePrefetch(node)} onPointerLeave={() => queuePrefetch()}
            onPointerDown={() => prefetchNow(node)} onFocus={() => queuePrefetch(node)} onClick={() => focusNode(node)}
            aria-current={node.id === selected.id ? 'location' : undefined}>{node.scientificName}</button>)}</div></section>
      </aside>}
      {(streamError || navigationError) && <div className="stream-notice" role="alert">{streamError || navigationError}</div>}
      {pendingTaxon && <div className="stream-notice" role="status">Opening {pendingTaxon}…</div>}
      {!scene && <div className="stream-notice" role="status">Loading this part of the tree…</div>}
      {scene?.stats.limited && <div className="stream-notice" role="status">Showing an overview. Zoom in for more detail.</div>}
      {details?.childrenTruncated && selected && <div className="children-note">Showing {descendants.length} named descendants. Search to find more.</div>}
      {journeyState.view === 'paused' && <button className="journey-resume" onClick={() => goJourneyStep(journeyState.step)}>
        <span aria-hidden="true">✦</span><span><small>Journey paused</small>Resume: {activeJourney?.title ?? 'guided journey'}</span><b>→</b></button>}
      {['library', 'playing', 'complete'].includes(journeyState.view) && <Suspense fallback={<aside className="journey-panel journey-loading" aria-label="Loading journey"><div className="loading-indicator" /></aside>}>
        <JourneyPanel view={journeyState.view as 'library' | 'playing' | 'complete'} step={journeyState.step}
          journey={activeJourney} catalog={journeyCatalog} onSelect={openJourney}
          onBegin={() => goJourneyStep(journeyState.step)}
          onStep={goJourneyStep}
          onPause={() => setJourneyState(current => ({ ...current, view: 'paused' }))}
          onClose={() => { setJourneyState(current => ({ ...current, view: 'closed' })); updateJourneyUrl('closed', journeyState.journeyId, journeyState.step); }}
          onLibrary={() => { setJourneyState(current => ({ ...current, view: 'library' })); updateJourneyUrl('library', journeyState.journeyId, journeyState.step); }}
          onComplete={() => { setJourneyState(current => ({ ...current, view: 'complete' })); updateJourneyUrl('complete', journeyState.journeyId, journeyState.step); }} />
      </Suspense>}
      {benchmarkMode && <aside className="benchmark-panel" aria-label="Performance diagnostics">
        <strong>{manifest.title}</strong>
        <div>{manifest.nodeCount.toLocaleString()} total nodes · {scene?.nodes.length ?? 0} loaded for display</div>
        <div>First map: {telemetry.metrics.firstMapMs?.toFixed(0) ?? '…'} ms · Scene query: {scene?.stats.queryMs.toFixed(1) ?? '…'} ms</div>
        <div>Selection paint: {telemetry.metrics.selectionPaintMs?.toFixed(0) ?? '…'} ms · Ready: {telemetry.metrics.selectionReadyMs?.toFixed(0) ?? '…'} ms</div>
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
  const profileClient = useMemo(() => new ProfileClient(new URL(`${import.meta.env.BASE_URL}data/profiles/manifest.json`, window.location.href).href), []);
  const journeyClient = useMemo(() => new JourneyClient(new URL(`${import.meta.env.BASE_URL}data/journeys/manifest.json`, window.location.href).href), []);
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
  return <TreeMap client={loaded.client} profileClient={profileClient} journeyClient={journeyClient} manifest={loaded.manifest} />;
}
export default App;
