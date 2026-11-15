import type { TreeClient } from '../stream/client.ts';
import type { Summary } from '../stream/format.ts';
import type { ProfileClient } from './client.ts';
import type { ProfileSearchHit, ProfileSearchScope } from './types.ts';

export interface DiscoveryResult {
  node: Summary;
  commonName?: string;
  rank?: string;
  matchedName?: string;
  matchKind?: ProfileSearchHit['matchKind'] | 'OpenTree ID';
}

export async function discoverTaxa(client: TreeClient, profileClient: ProfileClient, query: string,
  signal: AbortSignal, scope: ProfileSearchScope = 'all', limit = 12): Promise<DiscoveryResult[]> {
  const profileRequest = profileClient.search(query, signal, scope).catch(error => {
    if (signal.aborted) throw error;
    return [] as ProfileSearchHit[];
  });
  const [direct, profileHits] = await Promise.all([client.search(query, signal), profileRequest]);
  signal.throwIfAborted();
  const profileByOtt = new Map(profileHits.map(hit => [hit.ottId, hit]));
  const combined = new Map<number, DiscoveryResult>();
  for (const node of direct) {
    const hit = node.ottId ? profileByOtt.get(node.ottId) : undefined;
    if ((scope === 'common name' || scope === 'synonym') && !hit) continue;
    combined.set(node.index, { node, commonName: hit?.commonName, rank: hit?.rank,
      matchedName: hit?.matchedName, matchKind: hit?.matchKind ?? (/^(?:ott)?\d+$/i.test(query.trim()) ? 'OpenTree ID' : undefined) });
  }
  const missing = profileHits.filter(hit => ![...combined.values()].some(result => result.node.ottId === hit.ottId)).slice(0, 8);
  const resolved = await Promise.all(missing.map(async hit => {
    const nodes = await client.search(`ott${hit.ottId}`, signal);
    const node = nodes.find(item => item.ottId === hit.ottId);
    return node ? { node, commonName: hit.commonName, rank: hit.rank, matchedName: hit.matchedName,
      matchKind: hit.matchKind } satisfies DiscoveryResult : null;
  }));
  for (const result of resolved) if (result && !combined.has(result.node.index)) combined.set(result.node.index, result);
  return [...combined.values()].sort((a, b) => {
    const aHit = profileByOtt.get(a.node.ottId ?? -1), bHit = profileByOtt.get(b.node.ottId ?? -1);
    return Number(!aHit) - Number(!bHit) || a.node.scientificName.localeCompare(b.node.scientificName);
  }).slice(0, limit);
}
