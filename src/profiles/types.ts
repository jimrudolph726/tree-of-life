export interface CommonName {
  name: string;
  language: string;
  source: string;
}

export interface GbifProfile {
  usageKey: number;
  canonicalName: string;
  scientificName: string;
  rank: string;
  status: string;
  confidence: number;
}

export interface WikipediaProfile {
  title: string;
  url: string;
  extract: string;
  revisionId: number;
  wikidataId: string;
}

export interface WikidataIdentity {
  itemId: string;
  articleTitle: string;
  articleUrl: string;
}

export interface ProfileSource {
  label: string;
  url: string;
}

export interface ProfileFact {
  kind: 'status' | 'age' | 'trait' | 'habitat' | 'range';
  label: string;
  value: string;
  source: ProfileSource;
}

export interface ConservationStatus {
  code: 'EX' | 'EW' | 'CR' | 'EN' | 'VU' | 'NT' | 'LC' | 'DD';
  category: string;
  system: 'IUCN Red List';
  iucnTaxonId?: string;
  source: ProfileSource;
}

export interface ProfileImage {
  src: string;
  alt: string;
  caption: string;
  credit: string;
  license: string;
  sourceUrl: string;
}

export interface ScientificProfile {
  ottId: number;
  scientificName: string;
  rank?: string;
  commonNames: CommonName[];
  synonyms: string[];
  gbif?: GbifProfile;
  wikipedia?: WikipediaProfile;
  wikidata?: WikidataIdentity;
  conservation?: ConservationStatus;
  facts?: ProfileFact[];
  image?: ProfileImage;
}

export interface ProfileManifest {
  format: number;
  version: string;
  profileCount: number;
  shardCount: number;
  shardPattern: string;
  routing: string;
  maxCompressedShardBytes: number;
  compressedPublicationBytes: number;
  retrievedAt: string;
  conservationRetrievedAt?: string;
  coverage: Record<string, number>;
  searchFile: string;
  compressedSearchBytes: number;
  crosswalkFile: string;
  crosswalkCount: number;
  compressedCrosswalkBytes: number;
  identityCoverage: Record<string, number>;
}

export type ProfileSearchRecord = [ottId: number, scientificName: string, rank: string | null,
  commonNames: string[], synonyms: string[]];

export type ProfileMatchKind = 'scientific name' | 'common name' | 'synonym';

export interface ProfileSearchHit {
  ottId: number;
  scientificName: string;
  rank?: string;
  commonName?: string;
  matchedName: string;
  matchKind: ProfileMatchKind;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function validateProfileManifest(value: unknown): ProfileManifest {
  if (!isObject(value) || value.format !== 3 || typeof value.version !== 'string' ||
      !/^[a-f0-9]{16}$/.test(value.version) || !Number.isInteger(value.profileCount) ||
      !Number.isInteger(value.shardCount) || (value.shardCount as number) < 1 ||
      typeof value.shardPattern !== 'string' || !value.shardPattern.includes('{shard}') ||
      typeof value.routing !== 'string' || !Number.isInteger(value.maxCompressedShardBytes) ||
      !Number.isInteger(value.compressedPublicationBytes) || typeof value.retrievedAt !== 'string' ||
      !isObject(value.coverage) || typeof value.searchFile !== 'string' ||
      !Number.isInteger(value.compressedSearchBytes) || typeof value.crosswalkFile !== 'string' ||
      !Number.isInteger(value.crosswalkCount) || !Number.isInteger(value.compressedCrosswalkBytes) ||
      !isObject(value.identityCoverage)) {
    throw new Error('The scientific-profile manifest is invalid.');
  }
  return value as unknown as ProfileManifest;
}

export function validateProfileSearch(value: unknown): ProfileSearchRecord[] {
  if (!isObject(value) || !Array.isArray(value.profiles) || value.profiles.some(row =>
    !Array.isArray(row) || row.length !== 5 || !Number.isInteger(row[0]) || typeof row[1] !== 'string' ||
    (row[2] !== null && typeof row[2] !== 'string') || !Array.isArray(row[3]) ||
    !row[3].every(name => typeof name === 'string') || !Array.isArray(row[4]) ||
    !row[4].every(name => typeof name === 'string'))) {
    throw new Error('The scientific-profile search index is invalid.');
  }
  return value.profiles as ProfileSearchRecord[];
}

function validCommonName(value: unknown): value is CommonName {
  return isObject(value) && typeof value.name === 'string' && typeof value.language === 'string' &&
    typeof value.source === 'string';
}

function validFact(value: unknown): value is ProfileFact {
  if (!isObject(value) || !['status', 'age', 'trait', 'habitat', 'range'].includes(String(value.kind)) ||
      typeof value.label !== 'string' || typeof value.value !== 'string' || !isObject(value.source) ||
      typeof value.source.label !== 'string' || typeof value.source.url !== 'string' ||
      !value.source.url.startsWith('https://')) return false;
  return true;
}

function validConservation(value: unknown): value is ConservationStatus {
  return isObject(value) && ['EX', 'EW', 'CR', 'EN', 'VU', 'NT', 'LC', 'DD'].includes(String(value.code)) &&
    typeof value.category === 'string' && value.system === 'IUCN Red List' &&
    (value.iucnTaxonId === undefined || /^\d+(?:_\d+)?$/.test(String(value.iucnTaxonId))) &&
    isObject(value.source) && typeof value.source.label === 'string' && typeof value.source.url === 'string' &&
    value.source.url.startsWith('https://api.gbif.org/');
}

function validImage(value: unknown): value is ProfileImage {
  return isObject(value) && typeof value.src === 'string' && value.src.startsWith('images/') &&
    typeof value.alt === 'string' && typeof value.caption === 'string' && typeof value.credit === 'string' &&
    typeof value.license === 'string' && typeof value.sourceUrl === 'string' && value.sourceUrl.startsWith('https://');
}

function validProfile(value: unknown): value is ScientificProfile {
  if (!isObject(value) || !Number.isInteger(value.ottId) || typeof value.scientificName !== 'string' ||
      !Array.isArray(value.commonNames) || !value.commonNames.every(validCommonName) ||
      !Array.isArray(value.synonyms) || !value.synonyms.every(name => typeof name === 'string')) return false;
  if (value.rank !== undefined && typeof value.rank !== 'string') return false;
  if (value.gbif !== undefined && (!isObject(value.gbif) || !Number.isInteger(value.gbif.usageKey) ||
      typeof value.gbif.canonicalName !== 'string' ||
      value.gbif.canonicalName.localeCompare(value.scientificName, undefined, { sensitivity: 'base' }) !== 0 ||
      typeof value.gbif.scientificName !== 'string' || typeof value.gbif.rank !== 'string' ||
      typeof value.gbif.status !== 'string' || !Number.isInteger(value.gbif.confidence) ||
      (value.gbif.confidence as number) < 0 || (value.gbif.confidence as number) > 100)) return false;
  if (value.wikipedia !== undefined && (!isObject(value.wikipedia) || typeof value.wikipedia.title !== 'string' ||
      typeof value.wikipedia.url !== 'string' || typeof value.wikipedia.extract !== 'string' ||
      !Number.isInteger(value.wikipedia.revisionId) || typeof value.wikipedia.wikidataId !== 'string' ||
      !/^Q\d+$/.test(value.wikipedia.wikidataId))) return false;
  if (value.wikidata !== undefined && (!isObject(value.wikidata) || typeof value.wikidata.itemId !== 'string' ||
      !/^Q\d+$/.test(value.wikidata.itemId) || typeof value.wikidata.articleTitle !== 'string' ||
      typeof value.wikidata.articleUrl !== 'string' ||
      !value.wikidata.articleUrl.startsWith('https://en.wikipedia.org/wiki/'))) return false;
  if (value.conservation !== undefined && !validConservation(value.conservation)) return false;
  if (value.facts !== undefined && (!Array.isArray(value.facts) || value.facts.length > 8 ||
      !value.facts.every(validFact))) return false;
  if (value.image !== undefined && !validImage(value.image)) return false;
  return true;
}

export function validateProfileShard(value: unknown): ScientificProfile[] {
  if (!isObject(value) || !Array.isArray(value.profiles) || !value.profiles.every(validProfile)) {
    throw new Error('A scientific-profile shard is invalid.');
  }
  return value.profiles;
}
