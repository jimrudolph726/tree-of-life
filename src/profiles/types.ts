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

export interface ScientificProfile {
  ottId: number;
  scientificName: string;
  rank?: string;
  commonNames: CommonName[];
  synonyms: string[];
  gbif?: GbifProfile;
  wikipedia?: WikipediaProfile;
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
  coverage: Record<string, number>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function validateProfileManifest(value: unknown): ProfileManifest {
  if (!isObject(value) || value.format !== 1 || typeof value.version !== 'string' ||
      !/^[a-f0-9]{16}$/.test(value.version) || !Number.isInteger(value.profileCount) ||
      !Number.isInteger(value.shardCount) || (value.shardCount as number) < 1 ||
      typeof value.shardPattern !== 'string' || !value.shardPattern.includes('{shard}') ||
      typeof value.routing !== 'string' || !Number.isInteger(value.maxCompressedShardBytes) ||
      !Number.isInteger(value.compressedPublicationBytes) || typeof value.retrievedAt !== 'string' ||
      !isObject(value.coverage)) {
    throw new Error('The scientific-profile manifest is invalid.');
  }
  return value as unknown as ProfileManifest;
}

function validCommonName(value: unknown): value is CommonName {
  return isObject(value) && typeof value.name === 'string' && typeof value.language === 'string' &&
    typeof value.source === 'string';
}

function validProfile(value: unknown): value is ScientificProfile {
  if (!isObject(value) || !Number.isInteger(value.ottId) || typeof value.scientificName !== 'string' ||
      !Array.isArray(value.commonNames) || !value.commonNames.every(validCommonName) ||
      !Array.isArray(value.synonyms) || !value.synonyms.every(name => typeof name === 'string')) return false;
  if (value.rank !== undefined && typeof value.rank !== 'string') return false;
  if (value.gbif !== undefined && (!isObject(value.gbif) || !Number.isInteger(value.gbif.usageKey) ||
      typeof value.gbif.scientificName !== 'string')) return false;
  if (value.wikipedia !== undefined && (!isObject(value.wikipedia) || typeof value.wikipedia.title !== 'string' ||
      typeof value.wikipedia.url !== 'string' || typeof value.wikipedia.extract !== 'string' ||
      !Number.isInteger(value.wikipedia.revisionId) || typeof value.wikipedia.wikidataId !== 'string' ||
      !/^Q\d+$/.test(value.wikipedia.wikidataId))) return false;
  return true;
}

export function validateProfileShard(value: unknown): ScientificProfile[] {
  if (!isObject(value) || !Array.isArray(value.profiles) || !value.profiles.every(validProfile)) {
    throw new Error('A scientific-profile shard is invalid.');
  }
  return value.profiles;
}
