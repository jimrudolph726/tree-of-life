import { validateProfileManifest, validateProfileSearch, validateProfileShard, type ProfileManifest,
  type ProfileSearchHit, type ProfileSearchRecord, type ScientificProfile } from './types.ts';
import { searchProfiles } from './search.ts';

const MAX_CACHED_SHARDS = 16;

export class ProfileClient {
  private readonly manifestUrl: string;
  private manifest?: Promise<ProfileManifest>;
  private shards = new Map<number, Map<number, ScientificProfile>>();
  private requests = new Map<number, Promise<Map<number, ScientificProfile>>>();
  private searchIndex?: Promise<ProfileSearchRecord[]>;

  constructor(manifestUrl: string) { this.manifestUrl = manifestUrl; }

  private getManifest() {
    if (!this.manifest) {
      this.manifest = fetch(this.manifestUrl, { cache: 'no-cache' }).then(async response => {
        if (!response.ok) throw new Error(`Scientific profiles could not be opened (${response.status}).`);
        return validateProfileManifest(await response.json());
      }).catch(error => { this.manifest = undefined; throw error; });
    }
    return this.manifest;
  }

  private async getShard(shard: number, manifest: ProfileManifest) {
    const cached = this.shards.get(shard);
    if (cached) {
      this.shards.delete(shard); this.shards.set(shard, cached);
      return cached;
    }
    let request = this.requests.get(shard);
    if (!request) {
      const name = shard.toString().padStart(2, '0');
      const relative = `${manifest.version}/${manifest.shardPattern.replace('{shard}', name)}`;
      request = fetch(new URL(relative, this.manifestUrl).href, { cache: 'force-cache' }).then(async response => {
        if (!response.ok) throw new Error(`Scientific profiles could not be loaded (${response.status}).`);
        const profiles = validateProfileShard(await response.json());
        if (profiles.some(profile => profile.ottId % manifest.shardCount !== shard)) {
          throw new Error('A scientific profile was routed to the wrong shard.');
        }
        const result = new Map(profiles.map(profile => [profile.ottId, profile]));
        this.shards.set(shard, result);
        while (this.shards.size > MAX_CACHED_SHARDS) this.shards.delete(this.shards.keys().next().value!);
        return result;
      }).finally(() => this.requests.delete(shard));
      this.requests.set(shard, request);
    }
    return request;
  }

  async profile(ottId: number, signal?: AbortSignal): Promise<ScientificProfile | null> {
    signal?.throwIfAborted();
    const manifest = await this.withSignal(this.getManifest(), signal);
    const shard = ((ottId % manifest.shardCount) + manifest.shardCount) % manifest.shardCount;
    const profiles = await this.withSignal(this.getShard(shard, manifest), signal);
    return profiles.get(ottId) ?? null;
  }

  prefetch(ottId?: number | null) {
    return ottId ? this.profile(ottId).then(() => undefined) : Promise.resolve();
  }

  async search(query: string, signal?: AbortSignal): Promise<ProfileSearchHit[]> {
    if (!query.trim()) return [];
    const manifest = await this.withSignal(this.getManifest(), signal);
    if (!this.searchIndex) {
      this.searchIndex = fetch(new URL(`${manifest.version}/${manifest.searchFile}`, this.manifestUrl).href,
        { cache: 'force-cache' }).then(async response => {
          if (!response.ok) throw new Error(`Scientific search could not be loaded (${response.status}).`);
          return validateProfileSearch(await response.json());
        }).catch(error => { this.searchIndex = undefined; throw error; });
    }
    return searchProfiles(await this.withSignal(this.searchIndex, signal), query);
  }

  private withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new DOMException('Request cancelled', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
        signal.removeEventListener('abort', abort); reject(error);
      });
    });
  }
}
