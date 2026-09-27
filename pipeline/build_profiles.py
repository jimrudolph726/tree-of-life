"""Build a small, versioned scientific-profile publication.

The checked-in source snapshot makes normal builds deterministic and offline.
Use --refresh deliberately to resolve current Wikipedia articles and GBIF names,
ranks, and synonyms for a representative set of OpenTree taxa.
"""

from __future__ import annotations

import argparse
from array import array
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import struct
import time

import requests


ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / 'data/processed/profiles/source-snapshot.json'
OUTPUT = ROOT / 'public/data/profiles'
COUNT = 1000
SHARDS = 64
MAX_GZIP_SHARD_BYTES = 24 * 1024
USER_AGENT = 'TreeOfLifeExplorer/0.1 scientific-profile-etl'

SOURCE_PRIORITY = {
    'identityAndTopology': 'Open Tree of Life',
    'rankAndSynonyms': 'GBIF accepted exact match, then OpenTree',
    'commonNames': 'GBIF English preferred names, then other GBIF English names, then canonical Wikipedia title',
    'description': 'English Wikipedia introductory extract whose Wikidata item is a taxon or organism group or has a matching scientific-name property; never generated or treated as taxonomic authority',
}
WIKIDATA_TAXON_CLASSES = {'Q16521', 'Q55983715'}  # taxon; organisms known by a particular common name

ESSENTIAL = [
    'cellular organisms', 'Eukaryota', 'Archaea', 'Bacteria', 'Opisthokonta', 'Fungi', 'Metazoa',
    'Bilateria', 'Cnidaria', 'Porifera', 'Ctenophora', 'Chordata', 'Mammalia', 'Primates', 'Homo',
    'Homo sapiens', 'Pan troglodytes', 'Gorilla gorilla', 'Pongo pygmaeus', 'Macaca mulatta',
    'Aves', 'Neognathae', 'Palaeognathae', 'Passeriformes', 'Psittaciformes', 'Galliformes',
    'Anseriformes', 'Strigiformes', 'Accipitriformes', 'Gallus gallus', 'Anas platyrhynchos',
    'Corvus corax', 'Passer domesticus', 'Columba livia', 'Struthio camelus', 'Aptenodytes forsteri',
    'Haliaeetus leucocephalus', 'Tyto alba', 'Camarhynchus psittacula', 'Dinosauria', 'Reptilia',
    'Crocodylus niloticus', 'Chelonia mydas', 'Amphibia', 'Xenopus laevis', 'Ambystoma mexicanum',
    'Actinopterygii', 'Danio rerio', 'Salmo salar', 'Chondrichthyes', 'Arthropoda', 'Insecta',
    'Drosophila melanogaster', 'Apis mellifera', 'Danaus plexippus', 'Bombyx mori', 'Arachnida',
    'Mollusca', 'Octopus vulgaris', 'Annelida', 'Nematoda', 'Caenorhabditis elegans', 'Echinodermata',
    'Strongylocentrotus purpuratus', 'Amoebozoa', 'Alveolata', 'Stramenopiles', 'Rhizaria',
    'Archaeplastida', 'Chloroplastida', 'Embryophyta', 'Tracheophyta', 'Arabidopsis thaliana',
    'Oryza sativa', 'Zea mays', 'Triticum aestivum', 'Solanum lycopersicum', 'Quercus robur',
    'Sequoia sempervirens', 'Saccharomyces cerevisiae', 'Schizosaccharomyces pombe', 'Neurospora crassa',
    'Agaricus bisporus', 'Pseudomonadati', 'Bacillati', 'Actinobacteria', 'Cyanobacteria',
    'Methanobacteriati', 'Thermoproteati', 'Escherichia coli', 'Bacillus subtilis',
    'Mycobacterium tuberculosis', 'Staphylococcus aureus', 'Pseudomonas aeruginosa', 'Thermus aquaticus',
    'Canis lupus', 'Felis catus', 'Panthera leo', 'Panthera tigris', 'Ursus maritimus',
    'Loxodonta africana', 'Balaenoptera musculus', 'Equus caballus', 'Bos taurus', 'Sus scrofa',
    'Oryctolagus cuniculus', 'Giraffa camelopardalis', 'Ornithorhynchus anatinus',
]


def compact_json(value, *, pretty=False):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      indent=2 if pretty else None, separators=None if pretty else (',', ':'))


def sha256(path: Path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def node_candidate(node, group):
    ott_id = node.get('ottId')
    name = node.get('scientificName')
    if not isinstance(ott_id, int) or not isinstance(name, str) or node.get('isSyntheticNode'):
        return None
    return {'ottId': ott_id, 'scientificName': name, 'group': group,
            'depth': int(node.get('depth', 999)), 'terminal': bool(node.get('isTerminal'))}


def compact_life_matches(names):
    manifest = json.loads((ROOT / 'public/data/life/manifest.json').read_text(encoding='utf-8'))
    overview = json.loads((ROOT / 'public/data/life' / manifest['version'] / manifest['overview']['file']).read_text(encoding='utf-8'))
    wanted = set(names)
    found = {}
    for node in overview['nodes']:
        name, ott_id = node.get('scientificName'), node.get('ottId')
        if name in wanted and isinstance(ott_id, int):
            found[name] = {'ottId': ott_id, 'scientificName': name, 'group': 'essential',
                           'depth': int(node.get('depth', 0)), 'terminal': bool(node.get('isTerminal'))}
    provenance = json.loads((ROOT / 'data/processed/opentree/life/provenance.json').read_text(encoding='utf-8'))
    folder = ROOT / provenance['snapshotPath']
    offsets = array('I')
    with (folder / 'labels.u32').open('rb') as stream:
        offsets.fromfile(stream, (folder / 'labels.u32').stat().st_size // offsets.itemsize)
    labels = (folder / 'labels.utf8').read_bytes()
    for offset, length in zip(offsets[::2], offsets[1::2]):
        label = labels[offset:offset + length].decode('utf-8')
        match = re.fullmatch(r'(.+)_ott(\d+)', label)
        if not match:
            continue
        name = match.group(1).replace('_', ' ')
        if name in wanted and name not in found:
            found[name] = {'ottId': int(match.group(2)), 'scientificName': name, 'group': 'essential',
                           'depth': 0, 'terminal': False}
            if len(found) == len(wanted):
                break
    return found


def candidates():
    life = compact_life_matches(ESSENTIAL)
    result = [life[name] for name in ESSENTIAL if name in life]
    seen = {item['ottId'] for item in result}

    def add_file(path, group, maximum):
        nodes = json.loads((ROOT / path).read_text(encoding='utf-8'))
        rows = [node_candidate(node, group) for node in nodes]
        rows = [row for row in rows if row and row['ottId'] not in seen]
        # Shallow clades first; hash ordering then gives a deterministic spread of tips.
        rows.sort(key=lambda row: (row['terminal'], row['depth'],
                  hashlib.sha256(f"{row['ottId']}:{row['scientificName']}".encode()).hexdigest()))
        for row in rows[:maximum]:
            seen.add(row['ottId']); result.append(row)

    add_file('public/data/primates.nodes.json', 'primates', 1100)
    add_file('data/processed/opentree/aves/nodes.json', 'aves', 2400)
    return result


def request_json(url, *, params=None, data=None, attempts=8):
    for attempt in range(attempts):
        try:
            response = requests.post(url, data=data, headers={'User-Agent': USER_AGENT}, timeout=45) if data else \
                requests.get(url, params=params, headers={'User-Agent': USER_AGENT}, timeout=45)
            if response.status_code == 429 or response.status_code >= 500:
                raise requests.HTTPError(f'HTTP {response.status_code}', response=response)
            response.raise_for_status()
            return response.json()
        except (requests.RequestException, ValueError) as error:
            if attempt + 1 == attempts:
                raise
            retry_after = getattr(getattr(error, 'response', None), 'headers', {}).get('Retry-After')
            delay = float(retry_after) if retry_after and retry_after.isdigit() else min(30, 1.5 * 2 ** attempt)
            time.sleep(delay)


def wikipedia_batch(rows):
    titles = [row['scientificName'] for row in rows]
    value = request_json('https://en.wikipedia.org/w/api.php', data={
        'action': 'query', 'format': 'json', 'formatversion': 2, 'redirects': 1,
        'prop': 'extracts|info|revisions|pageprops', 'inprop': 'url', 'rvprop': 'ids',
        'exintro': 1, 'explaintext': 1, 'exsentences': 2, 'maxlag': 5, 'titles': '|'.join(titles),
    })
    query = value.get('query', {})
    aliases = {}
    for key in ('normalized', 'converted', 'redirects'):
        aliases.update({item['from']: item['to'] for item in query.get(key, [])})

    def resolved(title):
        for _ in range(4):
            next_title = aliases.get(title)
            if not next_title or next_title == title:
                break
            title = next_title
        return title

    pages = {page.get('title'): page for page in query.get('pages', []) if 'missing' not in page}
    output = {}
    for row in rows:
        page = pages.get(resolved(row['scientificName']))
        props = page.get('pageprops', {}) if page else {}
        extract = re.sub(r'\s+', ' ', page.get('extract', '')).strip() if page else ''
        if not page or 'disambiguation' in props or not extract:
            output[row['ottId']] = None
            continue
        output[row['ottId']] = {
            'title': page['title'], 'url': page.get('canonicalurl') or page.get('fullurl'),
            'extract': extract, 'revisionId': page.get('lastrevid') or (page.get('revisions') or [{}])[0].get('revid'),
            'wikidataId': props.get('wikibase_item'),
        }
    return output


def wikipedia(rows, batch_size=50):
    output = {}
    batches = [rows[i:i + batch_size] for i in range(0, len(rows), batch_size)]
    # Wikimedia applies global anonymous limits. Sequential batches are both
    # faster than repeated 429 retries and kinder to the shared service.
    for completed, batch in enumerate(batches, 1):
        output.update(wikipedia_batch(batch))
        time.sleep(0.2)
        if completed % 10 == 0:
            print(f'Resolved Wikipedia batch {completed}/{len(batches)}', flush=True)
    return output


def choose(rows, articles):
    selected = []
    seen = set()

    def take(group, count=None, required=False):
        matches = [row for row in rows if row['group'] == group and row['ottId'] not in seen]
        matches.sort(key=lambda row: (not bool(articles.get(row['ottId'])), row['terminal'], row['depth'], row['scientificName']))
        for row in matches:
            if not required and not articles.get(row['ottId']):
                continue
            seen.add(row['ottId']); selected.append(row)
            if count is not None and sum(item['group'] == group for item in selected) >= count:
                break

    take('essential', required=True)
    take('primates', 430)
    take('aves', 430)
    for row in rows:
        if len(selected) == COUNT:
            break
        if row['ottId'] not in seen and articles.get(row['ottId']):
            seen.add(row['ottId']); selected.append(row)
    if len(selected) < COUNT:
        for row in rows:
            if len(selected) == COUNT:
                break
            if row['ottId'] not in seen:
                seen.add(row['ottId']); selected.append(row)
    if len(selected) != COUNT:
        raise ValueError(f'Only {len(selected)} profile candidates were available')
    return selected


def validate_wikidata_articles(rows, articles):
    pairs = [(row['ottId'], (articles.get(row['ottId']) or {}).get('wikidataId'), row['scientificName']) for row in rows]
    ids = sorted({item for _, item, _ in pairs if item})
    evidence = {}
    for start in range(0, len(ids), 50):
        batch = ids[start:start + 50]
        value = request_json('https://www.wikidata.org/w/api.php', params={
            'action': 'wbgetentities', 'format': 'json', 'ids': '|'.join(batch), 'props': 'claims',
        })
        for item_id, entity in value.get('entities', {}).items():
            classes = {claim.get('mainsnak', {}).get('datavalue', {}).get('value', {}).get('id')
                       for claim in entity.get('claims', {}).get('P31', [])}
            taxon_names = {claim.get('mainsnak', {}).get('datavalue', {}).get('value')
                           for claim in entity.get('claims', {}).get('P225', [])}
            evidence[item_id] = (classes, {name.casefold() for name in taxon_names if isinstance(name, str)})
        time.sleep(0.2)
    candidates = sum(bool(articles.get(ott_id)) for ott_id, _, _ in pairs)
    invalid = []
    for ott_id, item_id, scientific_name in pairs:
        classes, taxon_names = evidence.get(item_id, (set(), set()))
        accepted = bool(classes & WIKIDATA_TAXON_CLASSES or scientific_name.casefold() in taxon_names)
        if articles.get(ott_id) and not accepted:
            invalid.append(ott_id); articles[ott_id] = None
    print(f'Wikidata accepted {candidates - len(invalid)}/{candidates} candidate articles as biological taxa', flush=True)
    return invalid


def preferred_common_names(records, article, scientific_name):
    trusted = ('Integrated Taxonomic Information System', 'Catalogue of Life', 'Mammal Species of the World')
    candidates = []
    for item in records:
        name = re.sub(r'\s+', ' ', item.get('vernacularName', '')).strip()
        if item.get('language') != 'eng' or not name:
            continue
        score = (0 if item.get('preferred') else 1, 0 if item.get('source') in trusted else 1,
                 len(name), name.casefold())
        candidates.append((score, name, item.get('source') or 'GBIF'))
    if article:
        title = re.sub(r'\s*\([^)]*\)$', '', article['title']).strip()
        if title.casefold() != scientific_name.casefold() and scientific_name.casefold() not in title.casefold():
            candidates.append(((2, 1, len(title), title.casefold()), title, 'Wikipedia'))
    found, output = set(), []
    for _, name, source in sorted(candidates):
        key = name.casefold()
        if key in found:
            continue
        found.add(key); output.append({'name': name, 'language': 'en', 'source': source})
        if len(output) == 6:
            break
    return output


def gbif_profile(row, article):
    match = request_json('https://api.gbif.org/v1/species/match', params={'name': row['scientificName']})
    accepted = (match.get('matchType') == 'EXACT' and match.get('confidence', 0) >= 90 and
                match.get('canonicalName', '').casefold() == row['scientificName'].casefold())
    if not accepted or not isinstance(match.get('usageKey'), int):
        return {'match': None, 'commonNames': preferred_common_names([], article, row['scientificName']), 'synonyms': []}
    key = match['usageKey']
    vernacular = request_json(f'https://api.gbif.org/v1/species/{key}/vernacularNames', params={'limit': 100}).get('results', [])
    synonym_rows = request_json(f'https://api.gbif.org/v1/species/{key}/synonyms', params={'limit': 100}).get('results', [])
    synonyms, seen = [], {row['scientificName'].casefold()}
    for item in synonym_rows:
        name = re.sub(r'\s+', ' ', item.get('canonicalName') or item.get('scientificName') or '').strip()
        if name and name.casefold() not in seen:
            seen.add(name.casefold()); synonyms.append(name)
            if len(synonyms) == 8:
                break
    return {
        'match': {'usageKey': key, 'canonicalName': match.get('canonicalName'),
                  'scientificName': match.get('scientificName'), 'rank': str(match.get('rank', '')).lower() or None,
                  'status': match.get('status'), 'confidence': match.get('confidence')},
        'commonNames': preferred_common_names(vernacular, article, row['scientificName']),
        'synonyms': synonyms,
    }


def refresh():
    rows = candidates()
    print(f'Prepared {len(rows):,} representative candidates', flush=True)
    articles = wikipedia(rows)
    selected = choose(rows, articles)
    validate_wikidata_articles(selected, articles)
    enriched = {}
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(gbif_profile, row, articles.get(row['ottId'])): row for row in selected}
        for completed, future in enumerate(as_completed(futures), 1):
            row = futures[future]
            try:
                enriched[row['ottId']] = future.result()
            except requests.RequestException as error:
                print(f"GBIF unavailable for {row['scientificName']}: {error}", flush=True)
                enriched[row['ottId']] = {'match': None,
                    'commonNames': preferred_common_names([], articles.get(row['ottId']), row['scientificName']), 'synonyms': []}
            if completed % 100 == 0:
                print(f'Enriched GBIF profile {completed}/{len(selected)}', flush=True)
    retrieved = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    life_manifest = json.loads((ROOT / 'public/data/life/manifest.json').read_text(encoding='utf-8'))
    profiles = []
    for row in selected:
        article, extra = articles.get(row['ottId']), enriched[row['ottId']]
        profile = {'ottId': row['ottId'], 'scientificName': row['scientificName'],
                   'selection': row['group'], 'commonNames': extra['commonNames'], 'synonyms': extra['synonyms']}
        if extra['match']:
            profile['rank'] = extra['match']['rank']; profile['gbif'] = extra['match']
        if article:
            profile['wikipedia'] = article
        profiles.append(profile)
    snapshot = {
        'format': 1, 'retrievedAt': retrieved,
        'openTree': {'synthId': life_manifest['provenance']['synthId'],
                     'taxonomyVersion': life_manifest['provenance']['taxonomyVersion']},
        'sourcePriority': SOURCE_PRIORITY, 'profiles': sorted(profiles, key=lambda item: item['ottId']),
    }
    SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    SNAPSHOT.write_text(compact_json(snapshot, pretty=True) + '\n', encoding='utf-8', newline='\n')
    return snapshot


def validate_profile(profile):
    if not isinstance(profile.get('ottId'), int) or profile['ottId'] <= 0:
        raise ValueError('Profile has an invalid OTT ID')
    if not isinstance(profile.get('scientificName'), str) or not profile['scientificName']:
        raise ValueError('Profile has no scientific name')
    if len(profile.get('commonNames', [])) > 6 or len(profile.get('synonyms', [])) > 8:
        raise ValueError('Profile exceeds compact-list limits')
    article = profile.get('wikipedia')
    if article and (not article.get('url', '').startswith('https://en.wikipedia.org/wiki/') or
                    not isinstance(article.get('revisionId'), int) or not article.get('extract') or
                    not re.fullmatch(r'Q\d+', article.get('wikidataId', ''))):
        raise ValueError(f"Invalid Wikipedia attribution for {profile['scientificName']}")


def public_profile(profile):
    """Remove ETL-only fields and obvious catalogue artefacts from visitor-facing names."""
    value = {key: item for key, item in profile.items() if key != 'selection'}
    scientific = profile['scientificName'].casefold()
    seen = set()
    common = []
    for item in profile.get('commonNames', []):
        name = item['name'].strip()
        folded = name.casefold()
        if (not name or folded in seen or folded in {'taxonomy', 'common name', 'english'} or
                folded == scientific or (' ' in scientific and scientific in folded)):
            continue
        seen.add(folded); common.append(item)
    value['commonNames'] = common
    return value


def publish(snapshot):
    profiles = snapshot.get('profiles', [])
    if len(profiles) != COUNT or len({item['ottId'] for item in profiles}) != COUNT:
        raise ValueError(f'Profile snapshot must contain exactly {COUNT} unique taxa')
    for profile in profiles:
        validate_profile(profile)
    required = {'Eukaryota', 'Archaea', 'Bacteria', 'Fungi', 'Opisthokonta', 'Bilateria',
                'Primates', 'Aves', 'Homo sapiens', 'Camarhynchus psittacula'}
    names = {item['scientificName'] for item in profiles}
    if missing := required - names:
        raise ValueError(f'Missing required profile coverage: {sorted(missing)}')
    public_profiles = [public_profile(profile) for profile in profiles]
    buckets = [[] for _ in range(SHARDS)]
    for profile, public in zip(profiles, public_profiles):
        buckets[profile['ottId'] % SHARDS].append(public)
    shard_text = [compact_json({'profiles': bucket}) + '\n' for bucket in buckets]
    hash_value = hashlib.sha256()
    for index, text in enumerate(shard_text):
        hash_value.update(f'{index:02d}.json'.encode()); hash_value.update(text.encode())
    hash_value.update(sha256(SNAPSHOT).encode())
    version = hash_value.hexdigest()[:16]
    coverage = {
        'profiles': len(profiles),
        'descriptions': sum('wikipedia' in item for item in public_profiles),
        'commonNames': sum(bool(item.get('commonNames')) for item in public_profiles),
        'synonyms': sum(bool(item.get('synonyms')) for item in public_profiles),
        'primates': sum(item.get('selection') == 'primates' for item in profiles),
        'aves': sum(item.get('selection') == 'aves' for item in profiles),
        'essential': sum(item.get('selection') == 'essential' for item in profiles),
    }
    compressed = [len(gzip.compress(text.encode(), compresslevel=9, mtime=0)) for text in shard_text]
    if max(compressed) > MAX_GZIP_SHARD_BYTES:
        raise ValueError(f'Compressed profile shard exceeds {MAX_GZIP_SHARD_BYTES} bytes')
    manifest = {
        'format': 1, 'version': version, 'profileCount': COUNT, 'shardCount': SHARDS,
        'shardPattern': 'shards/{shard}.json', 'routing': 'ottId modulo shardCount',
        'maxCompressedShardBytes': max(compressed), 'compressedPublicationBytes': sum(compressed),
        'retrievedAt': snapshot['retrievedAt'], 'openTree': snapshot['openTree'],
        'sourcePriority': snapshot['sourcePriority'], 'coverage': coverage,
        'sources': [
            {'name': 'Open Tree of Life', 'url': 'https://tree.opentreeoflife.org/', 'role': 'taxon identity and topology'},
            {'name': 'GBIF Species API', 'url': 'https://techdocs.gbif.org/en/openapi/v1/species', 'role': 'rank, common names and synonyms'},
            {'name': 'English Wikipedia', 'url': 'https://en.wikipedia.org/', 'role': 'attributed introductory descriptions',
             'license': 'CC BY-SA 4.0'},
            {'name': 'Wikidata', 'url': 'https://www.wikidata.org/', 'role': 'article-to-taxon validation'},
        ],
        'sourceSnapshotSha256': sha256(SNAPSHOT),
    }
    stage = OUTPUT / '.build-stage'
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    try:
        folder = stage / version / 'shards'; folder.mkdir(parents=True)
        for index, text in enumerate(shard_text):
            (folder / f'{index:02d}.json').write_text(text, encoding='utf-8', newline='\n')
        manifest_text = compact_json(manifest, pretty=True) + '\n'
        (stage / version / 'manifest.json').write_text(manifest_text, encoding='utf-8', newline='\n')
        destination = OUTPUT / version
        if destination.exists():
            existing = json.loads((destination / 'manifest.json').read_text(encoding='utf-8'))
            if existing != manifest:
                raise ValueError('Refusing to overwrite an immutable profile publication')
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(stage / version, destination)
        next_pointer = OUTPUT / 'manifest.next.json'
        next_pointer.write_text(manifest_text, encoding='utf-8', newline='\n')
        next_pointer.replace(OUTPUT / 'manifest.json')
    finally:
        shutil.rmtree(stage)
    print(compact_json({'version': version, **coverage,
                        'maxCompressedShardBytes': max(compressed),
                        'compressedPublicationBytes': sum(compressed)}, pretty=True))
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh', action='store_true', help='Fetch a new official-source snapshot before publishing')
    parser.add_argument('--audit-snapshot', action='store_true', help='Revalidate saved Wikipedia articles using Wikidata')
    args = parser.parse_args()
    if args.refresh:
        snapshot = refresh()
    elif SNAPSHOT.exists():
        snapshot = json.loads(SNAPSHOT.read_text(encoding='utf-8'))
    else:
        parser.error('Missing profile source snapshot. Run with --refresh once.')
    if args.audit_snapshot:
        articles = {profile['ottId']: profile.get('wikipedia') for profile in snapshot['profiles']}
        rows = [{'ottId': profile['ottId'], 'scientificName': profile['scientificName']}
                for profile in snapshot['profiles']]
        missing = [row for row in rows if not articles.get(row['ottId'])]
        if missing:
            articles.update(wikipedia(missing))
        invalid = set(validate_wikidata_articles(rows, articles))
        essential_retry = [row for row in rows if not articles.get(row['ottId']) and
                           next(profile for profile in snapshot['profiles'] if profile['ottId'] == row['ottId']).get('selection') == 'essential']
        if essential_retry:
            recovered = wikipedia(essential_retry, batch_size=10)
            retry_invalid = set(validate_wikidata_articles(essential_retry, recovered))
            invalid.difference_update({row['ottId'] for row in essential_retry if recovered.get(row['ottId'])})
            invalid.update(retry_invalid)
            articles.update(recovered)
        for profile in snapshot['profiles']:
            article = articles.get(profile['ottId'])
            if profile['ottId'] in invalid or not article:
                profile.pop('wikipedia', None)
                profile['commonNames'] = [item for item in profile.get('commonNames', []) if item.get('source') != 'Wikipedia']
            else:
                profile['wikipedia'] = article
                if not profile.get('commonNames'):
                    profile['commonNames'] = preferred_common_names([], article, profile['scientificName'])
        snapshot['sourcePriority'] = SOURCE_PRIORITY
        SNAPSHOT.write_text(compact_json(snapshot, pretty=True) + '\n', encoding='utf-8', newline='\n')
    publish(snapshot)


if __name__ == '__main__':
    main()
