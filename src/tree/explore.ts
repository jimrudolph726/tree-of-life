export interface ExploreDestination {
  id: string;
  label: string;
  scientificName: string;
  ottId: number;
  zoomOut: number;
  maximumZoom: number;
}

export interface ExploreSection {
  id: string;
  label: string;
  destinations: ExploreDestination[];
}

export const EXPLORE_SECTIONS: ExploreSection[] = [
  {
    id: 'domains', label: 'Domains', destinations: [
      { id: 'eukaryotes', label: 'Eukaryotes', scientificName: 'Eukaryota', ottId: 304358, zoomOut: 0.35, maximumZoom: 8 },
      { id: 'bacteria', label: 'Bacteria', scientificName: 'Bacteria', ottId: 844192, zoomOut: 0.35, maximumZoom: 8 },
      { id: 'archaea', label: 'Archaea', scientificName: 'Archaea', ottId: 996421, zoomOut: 0.35, maximumZoom: 8 },
    ],
  },
  {
    id: 'major', label: 'Major branches', destinations: [
      { id: 'animals', label: 'Animals', scientificName: 'Metazoa', ottId: 691846, zoomOut: 0.8, maximumZoom: 11 },
      { id: 'green-plants', label: 'Green plants', scientificName: 'Chloroplastida', ottId: 361838, zoomOut: 0.8, maximumZoom: 11 },
      { id: 'fungi', label: 'Fungi', scientificName: 'Fungi', ottId: 352914, zoomOut: 0.8, maximumZoom: 11 },
    ],
  },
  {
    id: 'familiar', label: 'Familiar branches', destinations: [
      { id: 'birds', label: 'Birds', scientificName: 'Aves', ottId: 81461, zoomOut: 1.25, maximumZoom: 13 },
      { id: 'mammals', label: 'Mammals', scientificName: 'Mammalia', ottId: 244265, zoomOut: 1.25, maximumZoom: 13 },
      { id: 'primates', label: 'Primates', scientificName: 'Primates', ottId: 913935, zoomOut: 1.25, maximumZoom: 14 },
    ],
  },
];

export const EXPLORE_DESTINATIONS = EXPLORE_SECTIONS.flatMap(section => section.destinations);

export function completeTreeExploreUrl(href: string, destination?: ExploreDestination) {
  const url = new URL(href);
  url.searchParams.set('dataset', 'life');
  url.searchParams.delete('journey');
  url.searchParams.delete('step');
  url.searchParams.delete('compare');
  if (destination) url.searchParams.set('taxon', `ott${destination.ottId}`);
  else url.searchParams.delete('taxon');
  return url;
}
