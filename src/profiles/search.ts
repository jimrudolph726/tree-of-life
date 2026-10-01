import type { ProfileMatchKind, ProfileSearchHit, ProfileSearchRecord } from './types.ts';

export function normalizeScientificQuery(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function editDistance(a: string, b: string, limit: number) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let previousPrevious: number[] | undefined;
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (previousPrevious && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j], previousPrevious[j - 2] + 1);
      }
    }
    previousPrevious = previous;
    previous = current;
  }
  return previous[b.length];
}

function score(name: string, query: string, kind: ProfileMatchKind, allowFuzzy: boolean) {
  const normalized = normalizeScientificQuery(name);
  const exact = normalized === query;
  const starts = normalized.startsWith(query);
  const wordStarts = normalized.split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(query));
  const kindScore = kind === 'common name' ? 0 : kind === 'scientific name' ? 1 : 2;
  if (exact) return kindScore;
  if (starts || wordStarts || normalized.includes(query)) {
    const kindBase = kind === 'common name' ? 10 : kind === 'scientific name' ? 20 : 30;
    return kindBase + (starts ? 0 : wordStarts ? 5 : 10) + kindScore;
  }
  if (!allowFuzzy || query.length < 4) return null;
  const limit = query.length >= 5 ? 2 : 1;
  const distance = Math.min(editDistance(normalized, query, limit),
    ...normalized.split(' ').map(word => editDistance(word, query, limit)));
  return distance <= limit ? 60 + distance * 2 + kindScore : null;
}

export function searchProfiles(records: ProfileSearchRecord[], rawQuery: string, limit = 12): ProfileSearchHit[] {
  const query = normalizeScientificQuery(rawQuery);
  if (!query) return [];
  const hits: Array<ProfileSearchHit & { score: number }> = [];
  const matched = new Set<number>();
  const collect = (allowFuzzy: boolean) => {
    for (const [ottId, scientificName, rank, commonNames, synonyms] of records) {
      if (matched.has(ottId)) continue;
      let best: (ProfileSearchHit & { score: number }) | undefined;
      const candidates: [string, ProfileMatchKind][] = [[scientificName, 'scientific name'],
        ...commonNames.map(name => [name, 'common name'] as [string, ProfileMatchKind]),
        ...synonyms.map(name => [name, 'synonym'] as [string, ProfileMatchKind])];
      for (const [name, matchKind] of candidates) {
        const matchScore = score(name, query, matchKind, allowFuzzy);
        if (matchScore === null || (best && matchScore >= best.score)) continue;
        best = { ottId, scientificName, rank: rank ?? undefined, commonName: commonNames[0],
          matchedName: name, matchKind, score: matchScore };
      }
      if (best) { hits.push(best); matched.add(ottId); }
    }
  };
  collect(false);
  // Fuzzy comparison is substantially more expensive over the full 50,000-record
  // index. Run it only when direct scientific, common-name and synonym matching
  // found nothing; a precise result should not wait for unrelated typo matches.
  if (hits.length === 0) collect(true);
  return hits.sort((a, b) => a.score - b.score || a.scientificName.localeCompare(b.scientificName))
    .slice(0, limit).map(hit => ({ ottId: hit.ottId, scientificName: hit.scientificName, rank: hit.rank,
      commonName: hit.commonName, matchedName: hit.matchedName, matchKind: hit.matchKind }));
}
