import type { Details, Summary } from '../stream/format.ts';

export interface TaxonComparison {
  first: Details;
  second: Details;
  mrca: Summary;
  shared: Summary[];
  firstBranch: Summary[];
  secondBranch: Summary[];
}

export function compareTaxa(first: Details, second: Details): TaxonComparison {
  let sharedCount = 0;
  const limit = Math.min(first.lineage.length, second.lineage.length);
  while (sharedCount < limit && first.lineage[sharedCount].index === second.lineage[sharedCount].index) sharedCount++;
  if (!sharedCount) throw new Error('These taxa do not share a root in the active tree.');
  return {
    first,
    second,
    mrca: first.lineage[sharedCount - 1],
    shared: first.lineage.slice(0, sharedCount),
    firstBranch: first.lineage.slice(sharedCount),
    secondBranch: second.lineage.slice(sharedCount),
  };
}

function parseOtt(value: string | null) {
  if (!value) return undefined;
  const match = /^(?:ott)?([1-9]\d*)$/i.exec(value.trim());
  const parsed = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseTaxonSelection(search: string) {
  const params = new URLSearchParams(search);
  const taxon = parseOtt(params.get('taxon'));
  const compare = parseOtt(params.get('compare'));
  return { taxon, compare: taxon && compare && taxon !== compare ? compare : undefined };
}

export function taxonSelectionUrl(href: string, taxon?: number, compare?: number) {
  const url = new URL(href);
  url.searchParams.delete('journey');
  url.searchParams.delete('step');
  if (taxon) url.searchParams.set('taxon', `ott${taxon}`); else url.searchParams.delete('taxon');
  if (taxon && compare && taxon !== compare) url.searchParams.set('compare', `ott${compare}`);
  else url.searchParams.delete('compare');
  return url;
}
