import type { ProfileMatchKind, ProfileSearchHit, ProfileSearchRecord } from './types.ts';

export function normalizeScientificQuery(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim().replace(/\s+/g, ' ');
}

function score(name: string, query: string, kind: ProfileMatchKind) {
  const normalized = normalizeScientificQuery(name);
  const exact = normalized === query;
  const starts = normalized.startsWith(query);
  const wordStarts = normalized.split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(query));
  if (!exact && !starts && !wordStarts) return null;
  const kindScore = kind === 'common name' ? 0 : kind === 'scientific name' ? 1 : 2;
  return (exact ? 0 : starts ? 10 : 20) + kindScore;
}

export function searchProfiles(records: ProfileSearchRecord[], rawQuery: string, limit = 12): ProfileSearchHit[] {
  const query = normalizeScientificQuery(rawQuery);
  if (!query) return [];
  const hits: Array<ProfileSearchHit & { score: number }> = [];
  for (const [ottId, scientificName, rank, commonNames, synonyms] of records) {
    let best: (ProfileSearchHit & { score: number }) | undefined;
    const candidates: [string, ProfileMatchKind][] = [[scientificName, 'scientific name'],
      ...commonNames.map(name => [name, 'common name'] as [string, ProfileMatchKind]),
      ...synonyms.map(name => [name, 'synonym'] as [string, ProfileMatchKind])];
    for (const [name, matchKind] of candidates) {
      const matchScore = score(name, query, matchKind);
      if (matchScore === null || (best && matchScore >= best.score)) continue;
      best = { ottId, scientificName, rank: rank ?? undefined, commonName: commonNames[0],
        matchedName: name, matchKind, score: matchScore };
    }
    if (best) hits.push(best);
  }
  return hits.sort((a, b) => a.score - b.score || a.scientificName.localeCompare(b.scientificName))
    .slice(0, limit).map(hit => ({ ottId: hit.ottId, scientificName: hit.scientificName, rank: hit.rank,
      commonName: hit.commonName, matchedName: hit.matchedName, matchKind: hit.matchKind }));
}
