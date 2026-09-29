export interface JourneySource { label: string; url: string }

export interface JourneyImage {
  src: string;
  alt: string;
  caption: string;
  credit: string;
  license: string;
  sourceUrl: string;
}

export interface JourneyStep {
  title: string;
  taxon: string;
  mapTaxon?: string;
  ottId: number;
  age: string;
  era: string;
  kind: 'fossil evidence' | 'living lineage';
  summary: string;
  evidence: string;
  uncertainty: string;
  image: JourneyImage;
  sources: JourneySource[];
}

export interface Journey {
  id: string;
  category: string;
  title: string;
  subtitle: string;
  duration: string;
  introduction: string;
  completion: { title: string; summary: string };
  steps: JourneyStep[];
}

export interface JourneySummary {
  id: string;
  category: string;
  title: string;
  subtitle: string;
  duration: string;
  stepCount: number;
  coverImage: JourneyImage;
}

export interface JourneyManifest {
  format: number;
  version: string;
  journeyCount: number;
  catalogFile: string;
  journeyPattern: string;
  maxCompressedJourneyBytes: number;
  compressedCatalogBytes: number;
  openTree: { synthId: string; taxonomyVersion: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validImage(value: unknown): value is JourneyImage {
  return isObject(value) && ['src', 'alt', 'caption', 'credit', 'license', 'sourceUrl']
    .every(key => typeof value[key] === 'string');
}

function validSummary(value: unknown): value is JourneySummary {
  return isObject(value) && ['id', 'category', 'title', 'subtitle', 'duration']
    .every(key => typeof value[key] === 'string') && Number.isInteger(value.stepCount) && validImage(value.coverImage);
}

export function validateJourneyManifest(value: unknown): JourneyManifest {
  if (!isObject(value) || value.format !== 1 || typeof value.version !== 'string' ||
      !/^[a-f0-9]{16}$/.test(value.version) || !Number.isInteger(value.journeyCount) ||
      typeof value.catalogFile !== 'string' || typeof value.journeyPattern !== 'string' ||
      !value.journeyPattern.includes('{id}') || !Number.isInteger(value.maxCompressedJourneyBytes) ||
      !Number.isInteger(value.compressedCatalogBytes) || !isObject(value.openTree) ||
      typeof value.openTree.synthId !== 'string' || typeof value.openTree.taxonomyVersion !== 'string') {
    throw new Error('The Journey manifest is invalid.');
  }
  return value as unknown as JourneyManifest;
}

export function validateJourneyCatalog(value: unknown): JourneySummary[] {
  if (!isObject(value) || !Array.isArray(value.journeys) || !value.journeys.every(validSummary)) {
    throw new Error('The Journey catalog is invalid.');
  }
  return value.journeys;
}

export function validateJourney(value: unknown): Journey {
  const coverImage = isObject(value) && Array.isArray(value.steps) && isObject(value.steps[0]) ? value.steps[0].image : null;
  if (!isObject(value) || !validSummary({ ...value, stepCount: Array.isArray(value.steps) ? value.steps.length : 0, coverImage }) ||
      typeof value.introduction !== 'string' || !isObject(value.completion) ||
      typeof value.completion.title !== 'string' || typeof value.completion.summary !== 'string' ||
      !Array.isArray(value.steps) || value.steps.length < 8 || value.steps.length > 10 || value.steps.some(step =>
        !isObject(step) || !Number.isInteger(step.ottId) || typeof step.title !== 'string' ||
        typeof step.taxon !== 'string' || (step.mapTaxon !== undefined && typeof step.mapTaxon !== 'string') ||
        typeof step.age !== 'string' || typeof step.era !== 'string' ||
        !['fossil evidence', 'living lineage'].includes(String(step.kind)) || typeof step.summary !== 'string' ||
        typeof step.evidence !== 'string' || typeof step.uncertainty !== 'string' || !validImage(step.image) ||
        !Array.isArray(step.sources) || step.sources.some(source => !isObject(source) ||
          typeof source.label !== 'string' || typeof source.url !== 'string'))) {
    throw new Error('The selected Journey is invalid.');
  }
  return value as unknown as Journey;
}
