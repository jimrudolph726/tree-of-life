import type { ProfileMatchKind, ProfileSearchHit, ProfileSearchRecord } from './types.ts';

export function normalizeScientificQuery(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function editDistance(a: string, b: string, limit: number) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

function score(name: string, query: string, kind: ProfileMatchKind) {
  const normalized = normalizeScientificQuery(name);
  const exact = normalized === query;
  const starts = normalized.startsWith(query);
  const wordStarts = normalized.split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(query));
  const kindScore = kind === 'common name' ? 0 : kind === 'scientific name' ? 1 : 2;
  if (exact || starts || wordStarts || normalized.includes(query)) {
    return (exact ? 0 : starts ? 10 : wordStarts ? 20 : 30) + kindScore;
  }
  if (query.length < 4) return null;
  const limit = query.length >= 5 ? 2 : 1;
  const distance = Math.min(editDistance(normalized, query, limit),
    ...normalized.split(' ').map(word => editDistance(word, query, limit)));
  return distance <= limit ? 40 + distance * 2 + kindScore : null;
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
