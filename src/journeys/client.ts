import { validateJourney, validateJourneyCatalog, validateJourneyManifest,
  type Journey, type JourneyManifest, type JourneySummary } from './types.ts';

export class JourneyClient {
  private readonly manifestUrl: string;
  private manifest?: Promise<JourneyManifest>;
  private catalogRequest?: Promise<JourneySummary[]>;
  private journeys = new Map<string, Promise<Journey>>();

  constructor(manifestUrl: string) {
    this.manifestUrl = manifestUrl;
  }

  private getManifest() {
    if (!this.manifest) this.manifest = fetch(this.manifestUrl, { cache: 'no-cache' }).then(async response => {
      if (!response.ok) throw new Error(`Journeys could not be opened (${response.status}).`);
      return validateJourneyManifest(await response.json());
    }).catch(error => { this.manifest = undefined; throw error; });
    return this.manifest;
  }

  async catalog(): Promise<JourneySummary[]> {
    if (!this.catalogRequest) this.catalogRequest = this.getManifest().then(manifest =>
      fetch(new URL(`${manifest.version}/${manifest.catalogFile}`, this.manifestUrl).href,
        { cache: 'force-cache' }).then(async response => {
        if (!response.ok) throw new Error(`The Journey catalog could not be loaded (${response.status}).`);
        const catalog = validateJourneyCatalog(await response.json());
        if (catalog.length !== manifest.journeyCount) throw new Error('The Journey catalog is incomplete.');
        return catalog;
      })).catch(error => { this.catalogRequest = undefined; throw error; });
    return this.catalogRequest;
  }

  async journey(id: string): Promise<Journey> {
    let request = this.journeys.get(id);
    if (!request) {
      request = Promise.all([this.getManifest(), this.catalog()]).then(async ([manifest, catalog]) => {
        if (!catalog.some(item => item.id === id)) throw new Error('That Journey is not available.');
        const file = manifest.journeyPattern.replace('{id}', id);
        const response = await fetch(new URL(`${manifest.version}/${file}`, this.manifestUrl).href,
          { cache: 'force-cache' });
        if (!response.ok) throw new Error(`The selected Journey could not be loaded (${response.status}).`);
        const journey = validateJourney(await response.json());
        if (journey.id !== id) throw new Error('The selected Journey has the wrong identity.');
        return journey;
      }).catch(error => { this.journeys.delete(id); throw error; });
      this.journeys.set(id, request);
    }
    return request;
  }
}
