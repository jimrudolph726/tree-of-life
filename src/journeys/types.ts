export interface JourneySource { label: string; url: string }

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
  sources: JourneySource[];
}

export interface Journey {
  id: string;
  category: string;
  title: string;
  subtitle: string;
  duration: string;
  introduction: string;
  steps: JourneyStep[];
}
