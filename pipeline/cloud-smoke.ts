import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { TreeStore } from '../src/stream/store.ts';
import { validateManifest } from '../src/stream/format.ts';
import { fitBounds, focusBounds, mapInsets } from '../src/tree/navigation.ts';
import { validateProfileManifest, validateProfileShard } from '../src/profiles/types.ts';
import { validateJourney, validateJourneyCatalog, validateJourneyManifest } from '../src/journeys/types.ts';

const address = process.argv[2];
assert.ok(address, 'Usage: node pipeline/cloud-smoke.ts https://distribution.cloudfront.net [report.json]');
const base = new URL(address);
assert.ok(base.protocol === 'https:' || (base.protocol === 'http:' && base.hostname === '127.0.0.1'), 'HTTPS required outside localhost');
base.pathname = '/'; base.search = ''; base.hash = '';
const samples: { path: string; ms: number; bytes: number; encoding: string | null; cache: string | null }[] = [];
async function read(path: string, immutable = false) {
  const start = performance.now();
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(60000), headers: { 'Accept-Encoding': 'gzip, br' } });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  const cache = response.headers.get('cache-control') ?? '';
  assert.ok(cache.includes(immutable ? 'immutable' : 'no-cache'), `${path}: incorrect cache policy`);
  const type = response.headers.get('content-type') ?? '';
  assert.ok(type.includes(path.endsWith('.bin') ? 'application/octet-stream' : path.endsWith('.json') ? 'application/json' : path.endsWith('.js') ? 'javascript' : 'text/html'), `${path}: wrong content type`);
  const buffer = await response.arrayBuffer();
  assert.ok(['gzip', 'br'].includes(response.headers.get('content-encoding') ?? ''), `${path}: compression absent`);
  samples.push({ path, ms: performance.now() - start, bytes: buffer.byteLength,
    encoding: response.headers.get('content-encoding'), cache: response.headers.get('x-cache') });
  return buffer;
}
const html = new TextDecoder().decode(await read(''));
const script = /<script[^>]*src="([^"]+\.js)"/.exec(html)?.[1];
assert.ok(script, 'Missing built app script');
await read(script, true);
const profileManifest = validateProfileManifest(JSON.parse(new TextDecoder().decode(await read('data/profiles/manifest.json'))));
const profileVersion = JSON.parse(new TextDecoder().decode(await read(`data/profiles/${profileManifest.version}/manifest.json`, true)));
assert.deepEqual(profileVersion, profileManifest);
const journeyManifest = validateJourneyManifest(JSON.parse(new TextDecoder().decode(await read('data/journeys/manifest.json'))));
const journeyVersion = JSON.parse(new TextDecoder().decode(await read(`data/journeys/${journeyManifest.version}/manifest.json`, true)));
assert.deepEqual(journeyVersion, journeyManifest);
const journeyCatalog = validateJourneyCatalog(JSON.parse(new TextDecoder().decode(
  await read(`data/journeys/${journeyManifest.version}/${journeyManifest.catalogFile}`, true))));
assert.equal(journeyCatalog.length, 3);
for (const summary of journeyCatalog) {
  const file = journeyManifest.journeyPattern.replace('{id}', summary.id);
  const journey = validateJourney(JSON.parse(new TextDecoder().decode(
    await read(`data/journeys/${journeyManifest.version}/${file}`, true))));
  assert.equal(journey.steps.length, summary.stepCount);
}
const results = [];
for (const [dataset, query] of [['life', 'Homo sapiens'], ['aves', 'Camarhynchus psittacula'], ['primates', 'Homo sapiens']]) {
  const manifest = validateManifest(JSON.parse(new TextDecoder().decode(await read(`data/${dataset}/manifest.json`))));
  const store = new TreeStore(manifest, path => read(`data/${dataset}/${path}`, true));
  const match = (await store.search(query)).find(n => n.scientificName === query);
  assert.ok(match, `${dataset}: missing search result ${query}`);
  const detail = await store.details(match.index);
  assert.equal(detail.node.id, match.id);
  assert.equal(detail.lineage[0].id, manifest.root.id);
  for (const size of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    const camera = fitBounds(focusBounds(detail.focus), size, mapInsets(size, true));
    const scene = await store.view({ anchor: detail.anchor, camera, size });
    assert.ok(scene.nodes.some(n => n.id === match.id));
    assert.ok(scene.lines.every(Number.isFinite));
  }
  if (dataset === 'life') {
    assert.ok(match.ottId);
    const shard = String(match.ottId % profileManifest.shardCount).padStart(2, '0');
    const profiles = validateProfileShard(JSON.parse(new TextDecoder().decode(
      await read(`data/profiles/${profileManifest.version}/shards/${shard}.json`, true))));
    const profile = profiles.find(item => item.ottId === match.ottId);
    assert.ok(profile?.wikipedia?.revisionId, 'Homo sapiens profile is missing its attributed description');
    assert.ok(profile.commonNames.length, 'Homo sapiens profile is missing its common name');
    const overview = JSON.parse(new TextDecoder().decode(await read(`data/life/${manifest.version}/overview.json`, true)));
    for (const name of ['Eukaryota', 'Archaea', 'Bacteria', 'Fungi', 'Opisthokonta']) {
      assert.ok(overview.nodes.some((n: { scientificName: string }) => n.scientificName === name));
    }
    // Repeat to observe CDN cache behavior; a first edge request may be a miss.
    await read(`data/life/${manifest.version}/overview.json`, true);
    const missing = await fetch(new URL(`data/life/${manifest.version}/pages/not-a-page.bin`, base));
    assert.ok([403, 404].includes(missing.status), 'Missing data must not return the HTML app');
  }
  results.push({ dataset, version: manifest.version, query, depth: detail.node.depth, requests: store.requests });
}
const report = { url: base.href, measuredAt: new Date().toISOString(), results, samples,
  limits: 'HTTP/shared-store smoke check, not a browser, GPU, physical phone or bandwidth-throttled test.' };
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2));
console.log(JSON.stringify({ url: base.href, passed: true, results, requests: samples.length }, null, 2));
