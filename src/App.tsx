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
import { cameraFromView, deckView, reframe, TreeOrthographicController } from './stream/reframe';
import { useBrowserMetrics } from './stream/useBrowserMetrics';
import { ProfileClient } from './profiles/client';
import { discoverTaxa, type DiscoveryResult } from './profiles/discovery';
import type { ProfileManifest, ProfileSearchScope, ScientificProfile } from './profiles/types';
import { JourneyClient } from './journeys/client';
import type { Journey, JourneySummary } from './journeys/types';
import { treeDataUrl } from './data/urls';
import { compareTaxa, parseTaxonSelection, taxonSelectionUrl, type TaxonComparison } from './tree/comparison';
import CompareMenu from './tree/CompareMenu';
import ExploreMenu from './tree/ExploreMenu';
import { completeTreeExploreUrl, type ExploreDestination } from './tree/explore';
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
type JourneyState = { view: 'closed' | 'library' | 'playing' | 'paused' | 'complete'; journeyId: string; step: number };
type RelatedBranches = { index: number; nodes: Summary[] };
type HistoryMode = 'push' | 'replace' | 'none';
type ComparisonProfiles = { key: string; first: ScientificProfile | null; second: ScientificProfile | null };
const getSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight });
const animate = (camera: Camera): CameraState => ({ ...camera,
  transitionDuration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650, transitionInterpolator: TRANSITION });
const EMPTY_NODES: StreamNode[] = [];
const benchmarkMode = new URLSearchParams(window.location.search).has('bench');
const SEARCH_SCOPES: Array<[ProfileSearchScope, string]> = [['all', 'All'], ['scientific name', 'Scientific'],
  ['common name', 'Common'], ['synonym', 'Synonyms']];
const PROFILE_METHOD_FIELDS = [['identityAndTopology', 'Identity & relationships'], ['rankAndSynonyms', 'Rank & synonyms'],
  ['commonNames', 'Common names'], ['description', 'Description'], ['conservation', 'Conservation']] as const;

function initialJourneyState(): JourneyState {
  const params = new URLSearchParams(window.location.search);
  const journeyId = params.get('journey');
  if (!journeyId || !/^[a-z0-9-]+$/.test(journeyId)) return { view: 'closed', journeyId: 'birds-flight', step: 0 };
  return { view: 'playing', journeyId, step: Math.max(0, Number(params.get('step')) || 0) };
}

function updateJourneyUrl(view: JourneyState['view'], journeyId: string, step: number) {
  const url = new URL(window.location.href);
  url.searchParams.delete('taxon'); url.searchParams.delete('compare');
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

function terminalTaxaLabel(node: Summary) {
  const count = node.isTerminal ? 1 : node.leafCount;
  return `${count.toLocaleString()} terminal ${count === 1 ? 'taxon' : 'taxa'}`;
}

function packedLineage(scene: Scene | null | undefined, nodes: Summary[]) {
  const indices = new Set(nodes.map(node => node.index));
  const values: number[] = [];
  scene?.lineTargets.forEach((index, i) => { if (indices.has(index)) values.push(...scene.lines.subarray(i * 4, i * 4 + 4)); });
  const lines = new Float64Array(values);
  return { length: lines.length / 4, attributes: {
    getSourcePosition: { value: lines, size: 2, stride: 32, offset: 0 },
    getTargetPosition: { value: lines, size: 2, stride: 32, offset: 16 },
  } };
}

function conciseLineage(nodes: Summary[]) {
  const named = nodes.filter(node => !node.isSyntheticNode);
  return named.length <= 6 ? named : [...named.slice(0, 2), ...named.slice(-3)];
}

function profileCommonName(profile: ScientificProfile | null | undefined, node: Summary) {
  return profile?.commonNames[0]?.name ?? node.commonName;
}

function taxonDisplayName(node: Summary) {
  return node.scientificName || (node.isSyntheticNode ? 'Unnamed branching point' : node.ottId ? `OTT ${node.ottId}` : 'Unnamed taxon');
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

export function TreeMap({ client, profileClient, journeyClient, manifest }: { client: TreeClient; profileClient: ProfileClient;
  journeyClient: JourneyClient; manifest: Manifest }) {
  const root = useMemo(() => rootNode(manifest), [manifest]);
  const container = useRef<HTMLElement>(null);
  const atHome = useRef(true);
  const focusRequest = useRef<AbortController | null>(null);
  const exploreRequest = useRef<AbortController | null>(null);
  const [size, setSize] = useState(getSize);
  const [camera, setCamera] = useState<CameraState>(() => openingCamera(root, getSize(), manifest));
  const [anchor, setAnchor] = useState(0);
  const [viewRevision, setViewRevision] = useState(0);
  const view = useMemo(() => new OrthographicView({ id: `tree-${anchor}-${viewRevision}`, flipY: true }), [anchor, viewRevision]);
  const interaction = useRef({ active: false, changedAt: 0 });
  // Every anchor has its own local coordinate system, and even a new camera in
  // the same anchor must retire any in-flight wheel animation. Keep an
  // immediate frame identity so late deck.gl events cannot overwrite a newly
  // committed camera before React finishes rendering that view.
  const activeView = useRef({ anchor: 0, revision: 0 });
  const activateFrame = useCallback((nextAnchor: number) => {
    const revision = activeView.current.revision + 1;
    activeView.current = { anchor: nextAnchor, revision };
    setViewRevision(revision);
  }, []);
  const [details, setDetails] = useState<Details | null>(null);
  const [pendingNode, setPendingNode] = useState<Summary | null>(null);
  const [pendingTaxon, setPendingTaxon] = useState<string | null>(null);
  const [heldScene, setHeldScene] = useState<Scene | null>(null);
  const [navigationSlow, setNavigationSlow] = useState(false);
  const [past, setPast] = useState<Visit[]>([]);
  const [future, setFuture] = useState<Visit[]>([]);
  const selected = pendingNode ?? details?.node ?? null;
  const [profileState, setProfileState] = useState<ProfileState | null>(null);
  const [profileManifest, setProfileManifest] = useState<ProfileManifest | null>(null);
  const [relatedBranches, setRelatedBranches] = useState<RelatedBranches | null>(null);
  const [comparison, setComparison] = useState<TaxonComparison | null>(null);
  const [comparisonProfiles, setComparisonProfiles] = useState<ComparisonProfiles | null>(null);
  const [compareFirst, setCompareFirst] = useState<Summary | undefined>();
  const [compareSecond, setCompareSecond] = useState<Summary | undefined>();
  const [comparePending, setComparePending] = useState(false);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const urlRestoreRequest = useRef<AbortController | null>(null);
  const restoreUrlSelectionRef = useRef<() => Promise<void>>(async () => undefined);
  const [query, setQuery] = useState('');
  const [searchScope, setSearchScope] = useState<ProfileSearchScope>('all');
  const [searchState, setSearchState] = useState<{ query: string; scope: ProfileSearchScope; results: DiscoveryResult[] }>(
    { query: '', scope: 'all', results: [] });
  const searching = query.trim() !== searchState.query || searchScope !== searchState.scope;
  const results = useMemo(() => searching ? [] : searchState.results, [searching, searchState.results]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeResult, setActiveResult] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [showRegions, setShowRegions] = useState(true);
  const [journeyState, setJourneyState] = useState<JourneyState>(initialJourneyState);
  const [journeyCatalog, setJourneyCatalog] = useState<JourneySummary[]>([]);
  const [activeJourney, setActiveJourney] = useState<Journey | null>(null);
  const [exploreMenuOpen, setExploreMenuOpen] = useState(false);
  const [journeyMenuOpen, setJourneyMenuOpen] = useState(false);
  const [compareMenuOpen, setCompareMenuOpen] = useState(false);
  const initialJourneyLoaded = useRef(false);
  const homeCamera = useMemo(() => openingCamera(root, size, manifest), [root, size, manifest]);
  const { scene: liveScene, error: streamError, loading: sceneLoading, prime } = useScene(client, anchor, camera, size, (nextAnchor, nextCamera) => {
    activateFrame(nextAnchor);
    setAnchor(nextAnchor); setCamera({ ...nextCamera, transitionDuration: 0 });
  }, () => !interaction.current.active && performance.now() - interaction.current.changedAt > 300);
  const latestVisibleScene = useRef<Scene | null>(null);
  useEffect(() => { if (liveScene?.nodes.length) latestVisibleScene.current = liveScene; }, [liveScene]);
  const scene = pendingTaxon && heldScene?.anchor === anchor ? heldScene : liveScene;
  useEffect(() => {
    if (!pendingTaxon) return;
    const timer = window.setTimeout(() => setNavigationSlow(true), 4000);
    return () => window.clearTimeout(timer);
  }, [pendingTaxon]);
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
    exploreRequest.current?.abort();
    if (hoverPrefetch.current) clearTimeout(hoverPrefetch.current.timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const started = performance.now();
    const timer = setTimeout(() => {
      void discoverTaxa(client, profileClient, query, controller.signal, searchScope).then(results => {
        setSearchState({ query: query.trim(), scope: searchScope, results });
        if (query.trim()) recordSearch(performance.now() - started);
      }).catch(error => { if (!controller.signal.aborted) setNavigationError(error.message); });
    }, 160);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [client, profileClient, query, recordSearch, searchScope]);
  useEffect(() => {
    const ottId = selected?.ottId;
    if (!ottId || manifest.synthetic) return;
    const controller = new AbortController();
    void Promise.all([profileClient.profile(ottId, controller.signal), profileClient.metadata(controller.signal)]).then(([profile, metadata]) => {
      setProfileManifest(metadata);
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
  const syncTaxonUrl = useCallback((first?: Summary, second?: Summary, mode: HistoryMode = 'push') => {
    if (mode === 'none' || manifest.synthetic) return;
    const url = taxonSelectionUrl(window.location.href, first?.ottId ?? undefined, second?.ottId ?? undefined);
    if (url.href === window.location.href) return;
    window.history[mode === 'replace' ? 'replaceState' : 'pushState'](null, '', url);
  }, [manifest.synthetic]);
  const focusNode = useCallback((node: Summary, preserveJourney = false, zoomOut = 0, maximumZoom = Infinity,
    urlMode: HistoryMode = 'push') => {
    exploreRequest.current?.abort(); exploreRequest.current = null;
    setHeldScene(latestVisibleScene.current?.anchor === anchor ? latestVisibleScene.current : null);
    if (!preserveJourney && journeyState.view === 'playing') setJourneyState(current => ({ ...current, view: 'paused' }));
    if (urlMode !== 'none') { setComparison(null); setComparisonProfiles(null); setCompareFirst(undefined);
      setCompareSecond(undefined); setCompareMenuOpen(false); syncTaxonUrl(node, undefined, urlMode); }
    startFocus(node.index);
    focusRequest.current?.abort();
    const controller = new AbortController(); focusRequest.current = controller;
    const previous = { camera, anchor, details, home: atHome.current };
    const prepared = prepareFocus(node, zoomOut, maximumZoom);
    setPendingNode(node); setDetails(null);
    setNavigationSlow(false); setPendingTaxon(node.scientificName);
    setNavigationError(null); setSearchOpen(false); setQuery('');
    void waitForSignal(prepared.target, controller.signal).then(async target => {
      setPendingNode(null); setDetails(target.details);
      const completed = await waitForSignal(prepared.ready, controller.signal);
      if (controller.signal.aborted) return;
      setPast(history => [...history.slice(-49), previous]); setFuture([]);
      atHome.current = false; prime(completed.scene);
      // Details, geometry, anchor, and camera belong to one coordinate frame.
      // Commit them together only after the replacement scene is drawable.
      // An instant frame swap also avoids rendering a narrowly fetched scene
      // through an unrelated starting camera during a transition.
      activateFrame(completed.scene.anchor);
      setDetails(completed.details); setAnchor(completed.scene.anchor);
      setCamera({ ...completed.camera, transitionDuration: 0 });
      setHeldScene(null); setPendingTaxon(null); recordFocusReady(node.index);
    }).catch(error => { if (!controller.signal.aborted) {
      atHome.current = previous.home; setNavigationError(error.message); setPendingTaxon(null); setPendingNode(null);
      setHeldScene(null); setDetails(previous.details); setCamera(animate(previous.camera));
    } });
  }, [anchor, camera, details, startFocus, recordFocusReady, prime, prepareFocus, journeyState.view, syncTaxonUrl, activateFrame]);
  const beginComparison = useCallback((first: Details, second: Details, urlMode: HistoryMode = 'push') => {
    if (first.node.index === second.node.index) return;
    try {
      const next = compareTaxa(first, second);
      setComparison(next); setCompareFirst(first.node); setCompareSecond(second.node);
      setComparePending(false); setCompareMenuOpen(false); setNavigationError(null);
      syncTaxonUrl(first.node, second.node, urlMode);
      focusNode(next.mrca, false, 0, Infinity, 'none');
    } catch (error) {
      setNavigationError(error instanceof Error ? error.message : 'These taxa could not be compared.');
    }
  }, [focusNode, syncTaxonUrl]);
  const beginComparisonNodes = useCallback(() => {
    if (!compareFirst || !compareSecond || compareFirst.index === compareSecond.index) return;
    const controller = new AbortController(); setComparePending(true);
    void Promise.all([client.details(compareFirst.index, controller.signal), client.details(compareSecond.index, controller.signal)])
      .then(([first, second]) => beginComparison(first, second))
      .catch(error => setNavigationError(error instanceof Error ? error.message : 'These taxa could not be compared.'))
      .finally(() => setComparePending(false));
  }, [beginComparison, client, compareFirst, compareSecond]);
  useEffect(() => {
    if (!comparison) return;
    const controller = new AbortController();
    const key = `${comparison.first.node.index}:${comparison.second.node.index}`;
    const load = (node: Summary) => {
      const ottId = node.ottId;
      return ottId ? profileClient.profile(ottId, controller.signal) : Promise.resolve(null);
    };
    void Promise.all([load(comparison.first.node), load(comparison.second.node)]).then(([first, second]) => {
      setComparisonProfiles({ key, first, second });
    }).catch(() => undefined);
    return () => controller.abort();
  }, [comparison, profileClient]);
  const copySelectionLink = useCallback(async (first: Summary, second?: Summary) => {
    const url = taxonSelectionUrl(window.location.href, first.ottId ?? undefined, second?.ottId ?? undefined);
    try {
      await navigator.clipboard.writeText(url.href); setLinkNotice(second ? 'Comparison link copied' : 'Taxon link copied');
    } catch { setLinkNotice('Copy failed'); }
    window.setTimeout(() => setLinkNotice(null), 1800);
  }, []);
  const loadJourneyCatalog = useCallback(() => {
    void journeyClient.catalog().then(setJourneyCatalog).catch(error => setNavigationError(error.message));
  }, [journeyClient]);
  const openJourney = useCallback((journeyId: string) => {
    const saved = Math.max(0, Number(localStorage.getItem(`tree-of-life:journey:${journeyId}`)) || 0);
    focusRequest.current?.abort(); exploreRequest.current?.abort(); exploreRequest.current = null;
    setHeldScene(null); setPendingTaxon(null); setPendingNode(null); setExploreMenuOpen(false);
    setComparison(null); setComparisonProfiles(null); setCompareFirst(undefined); setCompareSecond(undefined);
    setCompareMenuOpen(false); setJourneyState({ view: 'library', journeyId, step: saved });
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
      focusNode(node, true, JOURNEY_CONTEXT_ZOOM_OUT, JOURNEY_CONTEXT_MAX_ZOOM, 'none');
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
  const goHome = useCallback((urlMode: HistoryMode = 'push') => {
    if (journeyState.view === 'playing') setJourneyState(current => ({ ...current, view: 'paused' }));
    if (!atHome.current || details) { setPast(history => [...history.slice(-49), { camera, anchor, details, home: atHome.current }]); setFuture([]); }
    focusRequest.current?.abort(); exploreRequest.current?.abort(); exploreRequest.current = null; atHome.current = true;
    setComparison(null); setComparisonProfiles(null); setCompareFirst(undefined); setCompareSecond(undefined); setCompareMenuOpen(false);
    setExploreMenuOpen(false); setHeldScene(null);
    setPendingTaxon(null); setPendingNode(null);
    activateFrame(0);
    setDetails(null); setQuery(''); setSearchOpen(false); setNavigationError(null); setAnchor(0);
    setCamera(anchor === 0 ? animate(homeCamera) : { ...homeCamera, transitionDuration: 0 });
    syncTaxonUrl(undefined, undefined, urlMode);
  }, [anchor, camera, details, homeCamera, journeyState.view, syncTaxonUrl, activateFrame]);
  const openExploreHome = useCallback(() => {
    setExploreMenuOpen(false);
    if (manifest.presentation === 'life') {
      goHome(); setJourneyState(current => ({ ...current, view: 'closed' })); return;
    }
    window.location.assign(completeTreeExploreUrl(window.location.href).href);
  }, [goHome, manifest.presentation]);
  const openExploreDestination = useCallback((destination: ExploreDestination) => {
    setExploreMenuOpen(false); setNavigationError(null);
    if (manifest.presentation !== 'life') {
      window.location.assign(completeTreeExploreUrl(window.location.href, destination).href); return;
    }
    exploreRequest.current?.abort();
    const controller = new AbortController(); exploreRequest.current = controller;
    setNavigationSlow(false); setPendingTaxon(destination.label);
    void client.search(`ott${destination.ottId}`, controller.signal).then(matches => {
      controller.signal.throwIfAborted();
      const node = matches.find(item => item.ottId === destination.ottId);
      if (!node) throw new Error(`${destination.scientificName} is not available in this tree publication.`);
      exploreRequest.current = null;
      focusNode(node, false, destination.zoomOut, destination.maximumZoom);
      setJourneyState(current => ({ ...current, view: 'closed' }));
    }).catch(error => {
      if (!controller.signal.aborted) {
        exploreRequest.current = null; setPendingTaxon(null);
        setNavigationError(error instanceof Error ? error.message : 'This destination could not be opened.');
      }
    });
  }, [client, focusNode, manifest.presentation]);
  const revisit = (direction: 'back' | 'forward') => {
    const history = direction === 'back' ? past : future, visit = history.at(-1);
    if (!visit) return;
    focusRequest.current?.abort(); setHeldScene(null); setPendingTaxon(null); setPendingNode(null); setNavigationError(null);
    const current = { camera, anchor, details, home: atHome.current };
    if (direction === 'back') { setPast(history.slice(0, -1)); setFuture(values => [...values, current]); }
    else { setFuture(history.slice(0, -1)); setPast(values => [...values, current]); }
    setComparison(null); setComparisonProfiles(null); setCompareFirst(undefined); setCompareSecond(undefined); setCompareMenuOpen(false);
    activateFrame(visit.anchor);
    atHome.current = visit.home; setDetails(visit.details); setAnchor(visit.anchor);
    setCamera({ ...visit.camera, transitionDuration: 0 }); setQuery(''); setSearchOpen(false);
    syncTaxonUrl(visit.details?.node, undefined, 'replace');
  };
  const restoreUrlSelection = useCallback(async () => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('journey')) return;
    const selection = parseTaxonSelection(url.search);
    if (!selection.taxon) { goHome('none'); return; }
    urlRestoreRequest.current?.abort();
    const controller = new AbortController(); urlRestoreRequest.current = controller;
    try {
      const find = async (ottId: number) => {
        const matches = await client.search(`ott${ottId}`, controller.signal);
        const node = matches.find(item => item.ottId === ottId);
        if (!node) throw new Error(`OTT ${ottId} is not available in this tree publication.`);
        return node;
      };
      const first = await find(selection.taxon);
      if (!selection.compare) { setCompareFirst(undefined); setCompareSecond(undefined); setComparison(null);
        focusNode(first, false, 0, Infinity, 'none'); return; }
      const second = await find(selection.compare);
      const [firstDetails, secondDetails] = await Promise.all([
        client.details(first.index, controller.signal), client.details(second.index, controller.signal),
      ]);
      beginComparison(firstDetails, secondDetails, 'none');
    } catch (error) {
      if (!controller.signal.aborted) setNavigationError(error instanceof Error ? error.message : 'This shared view could not be opened.');
    }
  }, [beginComparison, client, focusNode, goHome]);
  useEffect(() => { restoreUrlSelectionRef.current = restoreUrlSelection; }, [restoreUrlSelection]);
  useEffect(() => {
    const restore = () => { void restoreUrlSelectionRef.current(); };
    restore();
    window.addEventListener('popstate', restore);
    return () => { window.removeEventListener('popstate', restore); urlRestoreRequest.current?.abort(); };
  }, []);
  const zoomBy = (amount: number) => {
    atHome.current = false;
    setCamera(current => animate({ ...current, zoom: Math.max(current.minZoom, Math.min(current.maxZoom, current.zoom + amount)) }));
  };
  const lineage = useMemo(() => details?.lineage ?? [], [details]);
  const lineageIds = useMemo(() => new Set((comparison
    ? [...comparison.shared, ...comparison.firstBranch, ...comparison.secondBranch] : lineage).map(node => node.id)), [comparison, lineage]);
  const namedLineage = lineage.filter(node => !node.isSyntheticNode);
  const breadcrumbs = namedLineage.length > 8 ? [namedLineage[0], ...namedLineage.slice(-6)] : namedLineage;
  const descendants = details?.children ?? [];
  const parentGroup = selected?.isSyntheticNode ? namedLineage.at(-1)
    : namedLineage.length > 1 ? namedLineage.at(-2) : undefined;
  useEffect(() => {
    const parent = details?.lineage.at(-2);
    if (!details || !parent) return;
    const controller = new AbortController();
    void client.details(parent.index, controller.signal).then(parentDetails => {
      const lineageIndices = new Set(details.lineage.map(node => node.index));
      const nodes = parentDetails.children.filter(node => !lineageIndices.has(node.index) && !node.isSyntheticNode).slice(0, 6);
      setRelatedBranches({ index: details.node.index, nodes });
    }).catch(() => undefined);
    return () => controller.abort();
  }, [client, details]);
  const selectedProfileState = profileState?.ottId === selected?.ottId ? profileState : null;
  const profile = selectedProfileState?.profile;
  const profileStatus = selected?.ottId && !manifest.synthetic ? selectedProfileState?.status ?? 'loading' : undefined;
  const articleName = profile?.wikipedia?.title;
  const canonicalCommonName = articleName && profile?.commonNames.find(item => item.name.localeCompare(articleName, undefined, { sensitivity: 'base' }) === 0)?.name;
  const primaryCommonName = canonicalCommonName ?? profile?.commonNames[0]?.name ?? selected?.commonName;
  const otherCommonNames = profile?.commonNames.filter(item => item.name !== primaryCommonName) ?? [];
  const related = relatedBranches && relatedBranches.index === selected?.index ? relatedBranches.nodes : [];
  const profileSourceCount = profile ? 1 + Number(Boolean(profile.gbif || profile.conservation ||
    profile.commonNames.some(item => item.source === 'GBIF'))) + Number(Boolean(profile.wikipedia)) +
    Number(Boolean(profile.wikidata || profile.wikipedia?.wikidataId)) + Number(Boolean(profile.facts?.length || profile.image)) : 1;
  const profileTier = profile?.wikipedia || profile?.facts?.length || profile?.image ? 'Enriched profile'
    : profile ? 'Taxonomic profile' : 'OpenTree record';
  const comparisonKey = comparison ? `${comparison.first.node.index}:${comparison.second.node.index}` : '';
  const activeComparisonProfiles = comparisonProfiles?.key === comparisonKey ? comparisonProfiles : null;
  const firstComparisonLineage = comparison ? conciseLineage(comparison.firstBranch) : [];
  const secondComparisonLineage = comparison ? conciseLineage(comparison.secondBranch) : [];
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
  const highlightedLines = useMemo(() => packedLineage(scene, comparison ? [] : lineage), [scene, comparison, lineage]);
  const sharedComparisonLines = useMemo(() => packedLineage(scene, comparison?.shared ?? []), [scene, comparison]);
  const firstComparisonLines = useMemo(() => packedLineage(scene, comparison?.firstBranch ?? []), [scene, comparison]);
  const secondComparisonLines = useMemo(() => packedLineage(scene, comparison?.secondBranch ?? []), [scene, comparison]);
  const layers = useMemo(() => {
    const parameters = { depthCompare: 'always' as const, depthWriteEnabled: false };
    return [
      new PolygonLayer<StreamNode>({ id: 'clade-regions', data: regions, visible: showRegions, parameters, pickable: true,
        getPolygon: node => node.region, getFillColor: node => node.group ? DOMAIN_COLORS[node.group] : PALETTE[node.depth % PALETTE.length],
        stroked: true, getLineColor: [96, 128, 116, 40], getLineWidth: 1, lineWidthUnits: 'pixels' }),
      new LineLayer({ id: 'branches', data: lineData, parameters, getColor: [107, 124, 116, 150], getWidth: 1.1, widthUnits: 'pixels' }),
      new LineLayer({ id: 'lineage', data: highlightedLines, parameters, getColor: [37, 118, 99, 255], getWidth: 2.5, widthUnits: 'pixels' }),
      new LineLayer({ id: 'comparison-shared', data: sharedComparisonLines, parameters, getColor: [37, 118, 99, 255], getWidth: 3, widthUnits: 'pixels' }),
      new LineLayer({ id: 'comparison-first', data: firstComparisonLines, parameters, getColor: [179, 119, 62, 255], getWidth: 3, widthUnits: 'pixels' }),
      new LineLayer({ id: 'comparison-second', data: secondComparisonLines, parameters, getColor: [62, 112, 158, 255], getWidth: 3, widthUnits: 'pixels' }),
      new ScatterplotLayer<MapTreeNode>({ id: 'nodes', data: namedNodes, pickable: true, parameters,
        getPosition: node => node.position, radiusUnits: 'pixels',
        getRadius: node => node.id === selected?.id || node.id === comparison?.first.node.id || node.id === comparison?.second.node.id ? 7 : node.isTerminal ? 3 : 4.5,
        getFillColor: node => node.id === comparison?.first.node.id ? [179, 119, 62] : node.id === comparison?.second.node.id ? [62, 112, 158]
          : node.id === selected?.id ? [30, 119, 99] : lineageIds.has(node.id) ? [79, 144, 126] : [75, 94, 83],
        stroked: true, getLineColor: [255, 255, 255], getLineWidth: 1.5, lineWidthUnits: 'pixels',
        updateTriggers: { getRadius: [selected?.id, comparison?.first.node.id, comparison?.second.node.id],
          getFillColor: [selected?.id, comparison?.first.node.id, comparison?.second.node.id, lineageIds] } }),
      new TextLayer<MapTreeNode>({ id: 'labels', data: labelNodes, pickable: true, parameters,
        getPosition: node => node.position, getText: node => labelText(node, size), getSize: labelSize,
        sizeUnits: 'pixels', fontFamily: 'Arial, sans-serif', fontWeight: 500,
        getColor: node => node.id === selected?.id ? [24, 105, 84] : [43, 61, 50],
        getPixelOffset: node => labelOffset(node, camera, size), getTextAnchor: 'middle', getAlignmentBaseline: 'bottom',
        background: true, getBackgroundColor: [248, 249, 244, 230], backgroundPadding: [4, 2],
        updateTriggers: { getColor: [selected?.id], getText: [size.width], getPixelOffset: [camera, size] } }),
    ];
  }, [regions, showRegions, lineData, highlightedLines, sharedComparisonLines, firstComparisonLines,
    secondComparisonLines, lineageIds, namedNodes, selected, comparison, labelNodes, camera, size]);
  const mapLoading = Boolean(pendingTaxon) || sceneLoading || !scene;
  return (
    <main className="app" ref={container} data-tree-ready={Boolean(scene)} data-pending-taxon={pendingTaxon ?? undefined}
      data-map-loading={pendingTaxon ? 'navigation' : sceneLoading || !scene ? 'scene' : undefined} aria-busy={mapLoading}
      data-scene-held={pendingTaxon && heldScene ? 'true' : undefined}
      data-profile-status={profileStatus}
      data-comparison={comparison ? `${comparison.first.node.ottId ?? comparison.first.node.index}:${comparison.second.node.ottId ?? comparison.second.node.index}` : undefined}
      data-scene-node-count={scene?.nodes.length ?? 0}
      data-camera-anchor={anchor} data-camera-zoom={camera.zoom.toFixed(4)}
      data-camera-target={camera.target.slice(0, 2).map(value => value.toFixed(3)).join(',')}>
      <DeckGL views={view} viewState={deckView(camera)} layers={layers}
        controller={{ type: TreeOrthographicController, dragPan: true, scrollZoom: true,
          doubleClickZoom: true, touchZoom: true, touchRotate: false, keyboard: true }}
        onViewStateChange={({ viewId, viewState, interactionState }) => {
          // A transition can emit one last callback after its OrthographicView
          // has been replaced. Its target is meaningless in the new anchor's
          // coordinate system, so never allow it back into application state.
          if (viewId !== `tree-${activeView.current.anchor}-${activeView.current.revision}`) return;
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
          else { focusRequest.current?.abort(); setComparison(null); setComparisonProfiles(null); setCompareFirst(undefined); setCompareSecond(undefined);
            setCompareMenuOpen(false);
            setHeldScene(null); setPendingTaxon(null); setPendingNode(null); setDetails(null); setSearchOpen(false); syncTaxonUrl(); }
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
            onFocus={() => { setSearchOpen(true); setExploreMenuOpen(false); setJourneyMenuOpen(false); setCompareMenuOpen(false); }}
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
          {searchOpen && query.trim() && <div className="search-results">
            <div className="search-scopes" role="group" aria-label="Search by name type">{SEARCH_SCOPES.map(([scope, label]) =>
              <button key={scope} type="button" aria-pressed={searchScope === scope} onClick={() => {
                setSearchScope(scope); setActiveResult(0);
              }}>{label}</button>)}</div>
            <div id="taxon-results" role="listbox" aria-label="Matching taxa">
              {results.length ? results.map((result, index) => <button type="button" role="option" aria-selected={index === activeResult}
                id={`result-${result.node.id}`} key={result.node.id} onPointerEnter={() => queuePrefetch(result.node)} onPointerLeave={() => queuePrefetch()}
                onPointerDown={event => { event.preventDefault(); prefetchNow(result.node); }}
                onFocus={() => queuePrefetch(result.node)} onClick={() => focusNode(result.node)}>
                <span className="search-result-title"><strong><span>{result.node.scientificName}</span></strong>{result.commonName && <em>{result.commonName}</em>}</span>
                <small><span>{result.rank ?? (result.node.isTerminal ? 'Terminal taxon' : 'Clade')}</span>
                  <span>{result.matchKind && result.matchedName && result.matchedName.localeCompare(result.node.scientificName, undefined, { sensitivity: 'base' }) !== 0
                    ? `Matched ${result.matchKind}: ${result.matchedName}` : terminalTaxaLabel(result.node)}</span></small>
              </button>) : <p role="status">{searching ? 'Searching…' : `No ${searchScope === 'all' ? '' : `${searchScope} `}matches in this dataset.`}</p>}
            </div>
          </div>}
        </div>
        {!manifest.synthetic && <div className="header-menu explore-menu" onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setExploreMenuOpen(false);
        }} onKeyDown={event => { if (event.key === 'Escape') setExploreMenuOpen(false); }}>
          <button className="header-menu-trigger" aria-haspopup="menu" aria-expanded={exploreMenuOpen} onClick={() => {
            setJourneyMenuOpen(false); setCompareMenuOpen(false); setExploreMenuOpen(open => !open);
          }}>Explore <b aria-hidden="true">⌄</b></button>
          {exploreMenuOpen && <ExploreMenu selectedOttId={selected?.ottId} onHome={openExploreHome} onSelect={openExploreDestination} />}
        </div>}
        {manifest.presentation === 'life' && <div className="header-menu" onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setJourneyMenuOpen(false);
        }} onKeyDown={event => { if (event.key === 'Escape') setJourneyMenuOpen(false); }}>
          <button className="header-menu-trigger" aria-haspopup="menu" aria-expanded={journeyMenuOpen} onClick={() => {
            setExploreMenuOpen(false); setCompareMenuOpen(false); setJourneyMenuOpen(open => !open); loadJourneyCatalog();
          }}>Journeys <b aria-hidden="true">⌄</b></button>
          {journeyMenuOpen && <div className="header-menu-popover" role="menu" aria-label="Guided journeys">
            <span>Guided journeys</span>
            {journeyCatalog.length ? journeyCatalog.map(item => <button key={item.id} className="journey-menu-item" role="menuitem" onClick={() => {
              setJourneyMenuOpen(false); openJourney(item.id);
            }}><strong>{item.category} · {item.title}</strong><small>{item.stepCount} stops · {item.duration}</small></button>)
              : <p className="journey-menu-loading">Loading journeys…</p>}
          </div>}
        </div>}
        {!manifest.synthetic && <div className="header-menu compare-menu" onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setCompareMenuOpen(false);
        }} onKeyDown={event => { if (event.key === 'Escape') setCompareMenuOpen(false); }}>
          <button className="header-menu-trigger" aria-haspopup="dialog" aria-expanded={compareMenuOpen} onClick={() => {
            setExploreMenuOpen(false); setJourneyMenuOpen(false); setCompareMenuOpen(open => !open); setLinkNotice(null);
          }}><span>Compare{comparison && <i className="comparison-active-dot" aria-label="Comparison active" />}</span>
            <b aria-hidden="true">⌄</b></button>
          {compareMenuOpen && <CompareMenu client={client} profileClient={profileClient}
            current={comparison ? null : details?.node ?? selected} first={compareFirst} second={compareSecond}
            active={Boolean(comparison)} pending={comparePending} linkNotice={linkNotice}
            onFirst={setCompareFirst} onSecond={setCompareSecond} onCompare={beginComparisonNodes}
            onSwap={() => {
              if (!compareFirst || !compareSecond) return;
              setCompareFirst(compareSecond); setCompareSecond(compareFirst);
              if (comparison) {
                const reversed = compareTaxa(comparison.second, comparison.first); setComparison(reversed);
                syncTaxonUrl(reversed.first.node, reversed.second.node, 'replace');
              }
            }}
            onCopy={() => {
              if (comparison) void copySelectionLink(comparison.first.node, comparison.second.node);
              else if (compareFirst && compareSecond) void copySelectionLink(compareFirst, compareSecond);
            }}
            onEnd={() => {
              const target = comparison?.second.node;
              setComparison(null); setComparisonProfiles(null); setCompareFirst(undefined); setCompareSecond(undefined);
              setCompareMenuOpen(false);
              if (target) focusNode(target, false, 0, Infinity, 'replace');
              else syncTaxonUrl(selected ?? undefined, undefined, 'replace');
            }} />}
        </div>}
      </header>
      <nav className="map-controls" aria-label="Map controls">
        <button onClick={() => revisit('back')} disabled={!past.length} aria-label="Back to previous view" title="Back">←</button>
        <button onClick={() => revisit('forward')} disabled={!future.length} aria-label="Forward to next view" title="Forward">→</button>
        <button onClick={() => zoomBy(1)} aria-label="Zoom in" title="Zoom in">+</button>
        <button onClick={() => zoomBy(-1)} aria-label="Zoom out" title="Zoom out">−</button>
        <button onClick={() => goHome()} aria-label="Home — fit entire tree" title="Fit entire tree">⌂</button>
        <button className="region-toggle" onClick={() => setShowRegions(value => !value)} aria-label="Show clade regions" aria-pressed={showRegions} title="Toggle clade regions">◒</button>
      </nav>
      {selected && breadcrumbs.length > 0 && <nav className="breadcrumbs" aria-label="Taxon lineage">
        {breadcrumbs.map((node, index) => <span key={node.id}>{index > 0 && <span className="separator">{index === 1 && namedLineage.length > 8 ? '…' : '›'}</span>}
          <button onPointerEnter={() => queuePrefetch(node)} onPointerLeave={() => queuePrefetch()} onPointerDown={() => prefetchNow(node)}
            onFocus={() => queuePrefetch(node)} onClick={() => focusNode(node)} aria-current={node.id === selected.id ? 'location' : undefined}>{node.scientificName}</button>
        </span>)}
      </nav>}
      <footer className="map-footer"><span><strong>{manifest.namedCount.toLocaleString()}</strong> named taxa · {root.leafCount} tips<span className="desktop-hint"> · Drag to pan · Scroll to zoom</span></span>
        <span className="attribution">{manifest.synthetic ? 'Generated benchmark data · ' : 'Data: Open Tree of Life · '}{manifest.provenance && <><a href={treeDataUrl(`data/${manifest.presentation === 'life' ? 'life' : 'aves'}/${manifest.version}/manifest.json`)} target="_blank" rel="noreferrer">{manifest.provenance.synthId}</a> · </>}<a href="https://lifemap.cnrs.fr/" target="_blank" rel="noreferrer">Inspired by Lifemap</a></span>
      </footer>
      {comparison && !['library', 'playing', 'complete'].includes(journeyState.view) && <aside className="comparison-panel" aria-label="Taxon comparison">
        <button className="close-button" onClick={() => { const target = comparison.second.node; setComparison(null); setComparisonProfiles(null);
          focusNode(target, false, 0, Infinity, 'replace'); }} aria-label="Close comparison">×</button>
        <div className="comparison-eyebrow">Evolutionary comparison</div>
        <h1>{comparison.first.node.scientificName} <span>&amp;</span> {comparison.second.node.scientificName}</h1>
        <button className="comparison-mrca" onClick={() => focusNode(comparison.mrca, false, 0, Infinity, 'none')}>
          <small>Most recent common ancestor</small><strong>{taxonDisplayName(comparison.mrca)}</strong><span>Center on the map →</span>
        </button>
        <div className="comparison-legend" aria-label="Comparison map legend"><span className="shared">Shared ancestry</span>
          <span className="first">{comparison.first.node.scientificName}</span><span className="second">{comparison.second.node.scientificName}</span></div>
        <div className="comparison-taxa">
          {([[comparison.first, activeComparisonProfiles?.first, firstComparisonLineage, 'first'],
            [comparison.second, activeComparisonProfiles?.second, secondComparisonLineage, 'second']] as const).map(([item, itemProfile, branch, side]) =>
            <article className={`comparison-taxon ${side}`} key={item.node.id}>
              <div className="rank">{itemProfile?.rank ?? item.node.rank ?? (item.node.isTerminal ? 'Terminal taxon' : 'Clade')}</div>
              <h2>{item.node.scientificName}</h2>
              {profileCommonName(itemProfile, item.node) && <p className="comparison-common">{profileCommonName(itemProfile, item.node)}</p>}
              <p className="comparison-count"><strong>{item.node.leafCount.toLocaleString()}</strong> terminal {item.node.leafCount === 1 ? 'taxon' : 'taxa'}</p>
              {activeComparisonProfiles ? itemProfile?.wikipedia
                ? <p className="comparison-description">{itemProfile.wikipedia.extract}</p>
                : <p className="comparison-description muted">No sourced description is currently available.</p>
                : <p className="comparison-description muted">Loading profile…</p>}
              {itemProfile?.conservation && <p className={`comparison-status status-${itemProfile.conservation.code.toLocaleLowerCase()}`}>
                {itemProfile.conservation.system}: {itemProfile.conservation.category} ({itemProfile.conservation.code})</p>}
              <div className="comparison-branch" aria-label={`${item.node.scientificName} lineage from the common ancestor`}>
                {branch.length ? branch.map((node, index) => <span key={node.id}>{index > 0 && <i>›</i>}{node.scientificName}</span>)
                  : <span>This taxon is the common ancestor.</span>}
              </div>
              <button className="comparison-view" onClick={() => { setComparison(null); setComparisonProfiles(null);
                focusNode(item.node, false, 0, Infinity, 'replace'); }}>View profile</button>
            </article>)}
        </div>
        <p className="comparison-note">Highlighted paths show ancestry in the OpenTree synthesis. Their drawn lengths do not represent elapsed time or genetic distance.</p>
        <div className="comparison-actions"><button onClick={() => void copySelectionLink(comparison.first.node, comparison.second.node)}>Copy comparison link</button>
          <button onClick={() => { const reversed = compareTaxa(comparison.second, comparison.first); setComparison(reversed);
            setCompareFirst(reversed.first.node); setCompareSecond(reversed.second.node);
            syncTaxonUrl(reversed.first.node, reversed.second.node, 'replace'); }}>Swap sides</button></div>
        {linkNotice && <p className="link-notice" role="status">{linkNotice}</p>}
      </aside>}
      {selected && !comparison && !['library', 'playing', 'complete'].includes(journeyState.view) && <aside className="detail-panel" aria-label="Taxon details">
        <button className="close-button" onClick={() => { focusRequest.current?.abort(); setCompareMenuOpen(false); setPendingTaxon(null);
          setHeldScene(null); setPendingNode(null); setDetails(null); syncTaxonUrl(); }} aria-label="Close details">×</button>
        <div className="rank">{profile?.rank ?? selected.rank ?? (selected.isTerminal ? 'Terminal taxon' : 'Clade')}</div>
        <h1>{selected.scientificName}</h1>
        {primaryCommonName && <p className="common-name">{primaryCommonName}</p>}
        <div className="taxon-stat"><strong>{selected.leafCount.toLocaleString()}</strong><span>terminal {selected.leafCount === 1 ? 'taxon' : 'taxa'} in this subtree</span></div>
        {details?.node.ottId && <div className="profile-actions" aria-label="Taxon actions">
          <button className="compare-start" onClick={() => { setCompareFirst(details.node); setCompareSecond(undefined);
            setExploreMenuOpen(false); setJourneyMenuOpen(false); setCompareMenuOpen(true); setLinkNotice(null); }}>Compare this taxon</button>
          <button onClick={() => void copySelectionLink(details.node)}>Copy taxon link</button>
        </div>}
        {linkNotice && <p className="link-notice" role="status">{linkNotice}</p>}
        {details && <section className="evolution-context"><h2>Evolutionary context</h2><dl>
          <div><dt>Parent group</dt><dd>{parentGroup ? <button onPointerEnter={() => queuePrefetch(parentGroup)}
            onPointerLeave={() => queuePrefetch()} onPointerDown={() => prefetchNow(parentGroup)} onFocus={() => queuePrefetch(parentGroup)}
            onClick={() => focusNode(parentGroup)}>{parentGroup.scientificName}</button> : 'Root of this tree'}</dd></div>
          <div><dt>Named ancestry</dt><dd>{Math.max(0, namedLineage.length - 1).toLocaleString()} groups</dd></div>
          <div><dt>Record</dt><dd>{profileStatus === 'loading' ? 'Loading profile…' : <>{profileTier} · {profileSourceCount} {profileSourceCount === 1 ? 'source' : 'sources'}</>}</dd></div>
        </dl>
        {related.length > 0 && <div className="related-branches"><small>Nearby branches</small><div>{related.map(node =>
          <button key={node.id} onPointerEnter={() => queuePrefetch(node)} onPointerLeave={() => queuePrefetch()}
            onPointerDown={() => prefetchNow(node)} onFocus={() => queuePrefetch(node)} onClick={() => focusNode(node)}>{node.scientificName}</button>)}</div></div>}
        </section>}
        {profile?.conservation && <a className={`conservation-status status-${profile.conservation.code.toLocaleLowerCase()}`}
          href={profile.conservation.source.url} target="_blank" rel="noreferrer">
          <span><small>{profile.conservation.system}</small><strong>{profile.conservation.category}</strong></span>
          <b>{profile.conservation.code}</b>
        </a>}
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
        <section className="scientific-record"><h2>Scientific record</h2><dl>
          <div><dt>Rank</dt><dd>{profile?.rank ?? selected.rank ?? (selected.isTerminal ? 'Terminal taxon' : 'Clade')}</dd></div>
          <div><dt>OpenTree identifier</dt><dd>OTT {selected.ottId ?? 'not assigned'}</dd></div>
          {profile?.gbif && <><div><dt>GBIF status</dt><dd>{profile.gbif.status.toLocaleLowerCase()}</dd></div>
            <div><dt>Identity match</dt><dd>{profile.gbif.confidence}% confidence</dd></div></>}
          {profileManifest && <div><dt>Profile release</dt><dd>{profileManifest.version}</dd></div>}
        </dl></section>
        {selectedProfileState?.status === 'missing' && <p className="profile-missing">This taxon is present in OpenTree, but it does not yet have an enriched encyclopedia profile. Its name, ancestry, relationships and subtree counts remain available.</p>}
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
        {profileManifest && <details className="profile-method"><summary>How this profile was assembled</summary><div>
          {PROFILE_METHOD_FIELDS.map(([key, label]) => profileManifest.sourcePriority[key] && <p key={key}><strong>{label}</strong>{profileManifest.sourcePriority[key]}</p>)}
          <small>Profile sources retrieved {profileManifest.retrievedAt.slice(0, 10)} · OpenTree {profileManifest.openTree.synthId} · Taxonomy {profileManifest.openTree.taxonomyVersion}</small>
        </div></details>}
        {descendants.length > 0 && <section><h2>Explore this clade</h2><div className="descendant-list">{descendants.map(node =>
          <button key={node.id} onPointerEnter={() => queuePrefetch(node)} onPointerLeave={() => queuePrefetch()}
            onPointerDown={() => prefetchNow(node)} onFocus={() => queuePrefetch(node)} onClick={() => focusNode(node)}>
            <span>{node.scientificName}</span><small>{node.leafCount} ›</small></button>)}</div></section>}
        <section><h2>Lineage</h2><div className="lineage">{namedLineage.map(node =>
          <button key={node.id} onPointerEnter={() => queuePrefetch(node)} onPointerLeave={() => queuePrefetch()}
            onPointerDown={() => prefetchNow(node)} onFocus={() => queuePrefetch(node)} onClick={() => focusNode(node)}
            aria-current={node.id === selected.id ? 'location' : undefined}>{node.scientificName}</button>)}</div></section>
      </aside>}
      {mapLoading && <div className="map-loading-rail" aria-hidden="true"><span /></div>}
      {(pendingTaxon || !scene) && <div className="map-loading-card" role="status" aria-live="polite" aria-atomic="true">
        <div className="loading-indicator" aria-hidden="true" /><span>
          <strong>{pendingTaxon ? `Opening ${pendingTaxon}` : 'Drawing the tree map'}</strong>
          <small>{navigationSlow ? 'Still loading — larger branches can take a moment.' : 'Loading tree data…'}</small>
        </span>
      </div>}
      {(streamError || navigationError) && <div className="stream-notice error" role="alert">{streamError || navigationError}</div>}
      {scene?.stats.limited && !pendingTaxon && <div className="stream-notice" role="status">Showing an overview. Zoom in for more detail.</div>}
      {!comparison && details?.childrenTruncated && selected && <div className="children-note">Showing {descendants.length} named descendants. Search to find more.</div>}
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

export default TreeMap;
