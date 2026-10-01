"""Build the versioned scientific-profile publication.

The checked-in source snapshot makes normal builds deterministic and offline.
Use --refresh deliberately to resolve current Wikipedia articles and GBIF names,
ranks, and synonyms. Use --expand to maintain the 10,000 externally enriched
records. Publication adds a deterministic, topology-aware OpenTree sample to
produce 50,000 searchable profiles without adding runtime network dependencies.
"""

from __future__ import annotations

import argparse
from array import array
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import gzip
import hashlib
import heapq
import json
from pathlib import Path
import re
import shutil
import struct
import time
from urllib.parse import unquote, urlparse

import requests


ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / 'data/processed/profiles/source-snapshot.json'
OUTPUT = ROOT / 'public/data/profiles'
GBIF_ENRICHED_COUNT = 1000
EXTERNAL_PROFILE_COUNT = 10000
COUNT = 50000
SHARDS = 256
MAX_GZIP_SHARD_BYTES = 64 * 1024
MAX_GZIP_SEARCH_BYTES = 2 * 1024 * 1024
MAX_GZIP_CROSSWALK_BYTES = 1024 * 1024
MAX_GZIP_PUBLICATION_BYTES = 16 * 1024 * 1024
MAX_PROFILE_IMAGE_BYTES = 512 * 1024
WIKIDATA_CANDIDATE_LIMIT = 60000
USER_AGENT = 'TreeOfLifeExplorer/0.1 scientific-profile-etl'

SOURCE_PRIORITY = {
    'identityAndTopology': 'Open Tree of Life',
    'rankAndSynonyms': 'GBIF accepted exact match, then OpenTree',
    'commonNames': 'GBIF English preferred names, then other GBIF English names, then canonical Wikipedia title',
    'description': 'English Wikipedia introductory extract whose Wikidata item is a taxon or organism group or has a matching scientific-name property; never generated or treated as taxonomic authority',
    'conservation': 'IUCN Red List category exposed by the GBIF Species API for an exact accepted GBIF match',
    'fieldNotes': 'Peer-reviewed sources selected for the guided Journeys; each displayed fact carries its own citation',
    'media': 'Locally hosted Wikimedia Commons media with creator, license, source URL, and integrity metadata',
}
WIKIDATA_TAXON_CLASSES = {'Q16521', 'Q55983715'}  # taxon; organisms known by a particular common name
IUCN_CATEGORIES = {
    'EX': 'Extinct', 'EW': 'Extinct in the Wild', 'CR': 'Critically Endangered',
    'EN': 'Endangered', 'VU': 'Vulnerable', 'NT': 'Near Threatened',
    'LC': 'Least Concern', 'DD': 'Data Deficient',
}

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
            # WDQS occasionally emits a literal control character inside a
            # scientific-name string. Python's tolerant mode still requires a
            # complete JSON document while allowing that upstream defect.
            return json.loads(response.text, strict=False)
        except (requests.RequestException, ValueError) as error:
            if attempt + 1 == attempts:
                raise
            retry_after = getattr(getattr(error, 'response', None), 'headers', {}).get('Retry-After')
            delay = float(retry_after) if retry_after and retry_after.isdigit() else min(30, 1.5 * 2 ** attempt)
            time.sleep(delay)


def conservation_record(profile, attempts=5):
    """Read the GBIF projection of IUCN status for an exact GBIF identity."""
    usage_key = profile['gbif']['usageKey']
    url = f'https://api.gbif.org/v1/species/{usage_key}/iucnRedListCategory'
    for attempt in range(attempts):
        try:
            response = requests.get(url, headers={'User-Agent': USER_AGENT}, timeout=45)
            if response.status_code == 204:
                return None
            if response.status_code == 429 or response.status_code >= 500:
                raise requests.HTTPError(f'HTTP {response.status_code}', response=response)
            response.raise_for_status()
            value = response.json()
            code = value.get('code')
            if code not in IUCN_CATEGORIES:
                return None
            record = {
                'code': code,
                'category': IUCN_CATEGORIES[code],
                'system': 'IUCN Red List',
                'source': {'label': 'GBIF Species API · IUCN Red List category', 'url': url},
            }
            taxon_id = value.get('iucnTaxonID')
            if isinstance(taxon_id, str) and taxon_id:
                record['iucnTaxonId'] = taxon_id
            return record
        except (requests.RequestException, ValueError) as error:
            if attempt + 1 == attempts:
                raise
            retry_after = getattr(getattr(error, 'response', None), 'headers', {}).get('Retry-After')
            delay = float(retry_after) if retry_after and retry_after.isdigit() else min(20, 1.5 * 2 ** attempt)
            time.sleep(delay)


def refresh_conservation(snapshot):
    profiles = [profile for profile in snapshot.get('profiles', []) if profile.get('gbif')]
    completed = 0
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(conservation_record, profile): profile for profile in profiles}
        for future in as_completed(futures):
            profile = futures[future]
            record = future.result()
            if record:
                profile['conservation'] = record
            else:
                profile.pop('conservation', None)
            completed += 1
            if completed % 100 == 0 or completed == len(profiles):
                print(f'Resolved conservation status {completed}/{len(profiles)}', flush=True)
    snapshot['conservationRetrievedAt'] = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    snapshot['sourcePriority'] = SOURCE_PRIORITY
    SNAPSHOT.write_text(compact_json(snapshot, pretty=True) + '\n', encoding='utf-8', newline='\n')
    return snapshot


def wikipedia_batch(rows):
    titles = [row.get('wikipediaTitle', row['scientificName']) for row in rows]
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
        lookup_title = row.get('wikipediaTitle', row['scientificName'])
        page = pages.get(resolved(lookup_title))
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


def wikidata_taxa(limit=WIKIDATA_CANDIDATE_LIMIT):
    """Return source-backed taxa that also have an English Wikipedia article."""
    rows, seen = [], set()
    page_size = 5000
    for offset in range(0, limit, page_size):
        query = f'''SELECT DISTINCT ?taxon ?name ?article WHERE {{
          ?taxon wdt:P31 wd:Q16521; wdt:P225 ?name.
          ?article schema:about ?taxon; schema:isPartOf <https://en.wikipedia.org/>.
        }} LIMIT {min(page_size, limit - offset)} OFFSET {offset}'''
        value = request_json('https://query.wikidata.org/sparql', params={'query': query, 'format': 'json'})
        bindings = value.get('results', {}).get('bindings', [])
        for item in bindings:
            taxon = item.get('taxon', {}).get('value', '').rsplit('/', 1)[-1]
            name = re.sub(r'\s+', ' ', item.get('name', {}).get('value', '')).strip()
            article = item.get('article', {}).get('value', '')
            key = (taxon, name, article)
            if key in seen or not re.fullmatch(r'Q\d+', taxon) or not name or not article.startswith('https://en.wikipedia.org/wiki/'):
                continue
            seen.add(key)
            rows.append({'wikidataId': taxon, 'scientificName': name,
                         'wikipediaTitle': unquote(urlparse(article).path.rsplit('/', 1)[-1]).replace('_', ' ')})
        print(f'Resolved Wikidata candidate page {offset // page_size + 1}/{(limit + page_size - 1) // page_size}', flush=True)
        if len(bindings) < min(page_size, limit - offset):
            break
        time.sleep(0.2)
    # Earlier Wikidata items tend to represent well-established and widely used
    # concepts. The hash provides a stable spread among items created together.
    rows.sort(key=lambda row: (int(row['wikidataId'][1:]),
              hashlib.sha256(row['scientificName'].encode()).hexdigest()))
    return rows


def opentree_matches(rows):
    """Resolve exact Wikidata scientific names against the imported OpenTree release."""
    wanted = {row['scientificName'] for row in rows}
    provenance = json.loads((ROOT / 'data/processed/opentree/life/provenance.json').read_text(encoding='utf-8'))
    folder = ROOT / provenance['snapshotPath']
    offsets = array('I')
    with (folder / 'labels.u32').open('rb') as stream:
        offsets.fromfile(stream, (folder / 'labels.u32').stat().st_size // offsets.itemsize)
    labels = (folder / 'labels.utf8').read_bytes()
    found = {}
    for offset, length in zip(offsets[::2], offsets[1::2]):
        label = labels[offset:offset + length].decode('utf-8')
        match = re.fullmatch(r'(.+)_ott(\d+)', label)
        if not match:
            continue
        name = match.group(1).replace('_', ' ')
        if name in wanted:
            ott_id = int(match.group(2))
            found.setdefault(name, ott_id)
    output = []
    for row in rows:
        ott_id = found.get(row['scientificName'])
        if ott_id:
            output.append({**row, 'ottId': ott_id, 'selection': 'wikidata'})
    return output


def wikidata_ranks(rows):
    """Resolve taxon ranks in compact batches; unknown ranks remain absent."""
    ids = sorted({row['wikidataId'] for row in rows if row.get('wikidataId')})
    rank_by_item, rank_ids = {}, set()
    for start in range(0, len(ids), 50):
        value = request_json('https://www.wikidata.org/w/api.php', params={
            'action': 'wbgetentities', 'format': 'json', 'ids': '|'.join(ids[start:start + 50]),
            'props': 'claims',
        })
        for item_id, entity in value.get('entities', {}).items():
            claims = entity.get('claims', {}).get('P105', [])
            rank_id = next((claim.get('mainsnak', {}).get('datavalue', {}).get('value', {}).get('id')
                            for claim in claims if claim.get('rank') != 'deprecated'), None)
            if rank_id:
                rank_by_item[item_id] = rank_id; rank_ids.add(rank_id)
        time.sleep(0.1)
    rank_labels = {}
    ordered = sorted(rank_ids)
    for start in range(0, len(ordered), 50):
        value = request_json('https://www.wikidata.org/w/api.php', params={
            'action': 'wbgetentities', 'format': 'json', 'ids': '|'.join(ordered[start:start + 50]),
            'props': 'labels', 'languages': 'en',
        })
        for rank_id, entity in value.get('entities', {}).items():
            label = entity.get('labels', {}).get('en', {}).get('value')
            if label:
                rank_labels[rank_id] = label.lower()
    return {item_id: rank_labels[rank_id] for item_id, rank_id in rank_by_item.items() if rank_id in rank_labels}


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


def wikipedia_parallel(rows, batch_size=50, workers=4):
    """Resolve a large, one-time expansion while keeping concurrency modest."""
    output = {}
    batches = [rows[i:i + batch_size] for i in range(0, len(rows), batch_size)]
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(wikipedia_batch, batch): index for index, batch in enumerate(batches)}
        for completed, future in enumerate(as_completed(futures), 1):
            output.update(future.result())
            if completed % 10 == 0 or completed == len(batches):
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
        if len(selected) == GBIF_ENRICHED_COUNT:
            break
        if row['ottId'] not in seen and articles.get(row['ottId']):
            seen.add(row['ottId']); selected.append(row)
    if len(selected) < ENRICHED_COUNT:
        for row in rows:
            if len(selected) == GBIF_ENRICHED_COUNT:
                break
            if row['ottId'] not in seen:
                seen.add(row['ottId']); selected.append(row)
    if len(selected) != GBIF_ENRICHED_COUNT:
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


def journey_profile_overlays():
    """Turn reviewed Journey evidence into cited, reusable field-guide notes."""
    registry_path = ROOT / 'data/content/journey-media.json'
    registry = json.loads(registry_path.read_text(encoding='utf-8'))['media']
    overlays = {}
    for path in sorted((ROOT / 'data/content/journeys').glob('*.json')):
        journey = json.loads(path.read_text(encoding='utf-8'))
        for step in journey['steps']:
            # Some Journey stops deliberately display the nearest positioned
            # relative. Never attach that stop's facts to the substitute taxon.
            if step.get('mapTaxon') and step['mapTaxon'] != step['taxon']:
                continue
            ott_id = step['ottId']
            value = overlays.setdefault(ott_id, {'ottId': ott_id, 'scientificName': step['taxon'],
                                                  'facts': []})
            sources = step.get('sources', [])
            if not sources:
                raise ValueError(f"Journey step {step['taxon']} has no scientific source")
            source = {'label': sources[0]['label'], 'url': sources[0]['url']}
            if not any(fact['kind'] == 'status' for fact in value['facts']):
                value['facts'].append({'kind': 'status', 'label': 'Evidence type',
                                       'value': step['kind'].capitalize(), 'source': source})
            if not any(fact['kind'] == 'age' for fact in value['facts']):
                value['facts'].append({'kind': 'age', 'label': 'Time', 'value': step['age'], 'source': source})
            if len(value['facts']) < 8:
                value['facts'].append({'kind': 'trait',
                    'label': f"{journey['category']} · {step['title']}",
                    'value': step['summary'], 'source': source})
            media_id = step.get('image', {}).get('mediaId')
            media = registry.get(media_id)
            if media and 'image' not in value:
                image_path = ROOT / 'public' / media['src']
                if not image_path.is_file() or image_path.stat().st_size == 0:
                    raise ValueError(f'Missing profile media: {media["src"]}')
                if image_path.stat().st_size > MAX_PROFILE_IMAGE_BYTES:
                    raise ValueError(f'Profile media exceeds {MAX_PROFILE_IMAGE_BYTES} bytes: {media["src"]}')
                recorded_hash = media.get('sha256', '')
                if re.fullmatch(r'[a-f0-9]{64}', recorded_hash) and sha256(image_path) != recorded_hash:
                    raise ValueError(f'Profile media checksum changed: {media["src"]}')
                value['image'] = {
                    'src': media['src'], 'alt': step['image']['alt'],
                    'caption': step['image']['caption'], 'credit': media['credit'],
                    'license': media['license'], 'sourceUrl': media['sourceUrl'],
                }
    return overlays


def expand(snapshot):
    """Expand the 1,000-record GBIF snapshot to 10,000 sourced profiles."""
    existing = list(snapshot.get('profiles', []))
    if len(existing) == EXTERNAL_PROFILE_COUNT:
        return snapshot
    if len(existing) != GBIF_ENRICHED_COUNT:
        raise ValueError(f'Expansion expects {GBIF_ENRICHED_COUNT} starting profiles, found {len(existing)}')
    seen_ids = {profile['ottId'] for profile in existing}
    seen_names = {profile['scientificName'].casefold() for profile in existing}

    # Journey taxa are guaranteed entry before the broad Wikidata selection.
    overlays = journey_profile_overlays()
    journey_rows = [{'ottId': item['ottId'], 'scientificName': item['scientificName'], 'selection': 'journey'}
                    for item in overlays.values() if item['ottId'] not in seen_ids]
    journey_articles = wikipedia(journey_rows, batch_size=25) if journey_rows else {}
    if journey_rows:
        validate_wikidata_articles(journey_rows, journey_articles)
    for row in journey_rows:
        article = journey_articles.get(row['ottId'])
        profile = {'ottId': row['ottId'], 'scientificName': row['scientificName'], 'selection': 'journey',
                   'commonNames': preferred_common_names([], article, row['scientificName']), 'synonyms': []}
        if article:
            profile['wikipedia'] = article
        existing.append(profile); seen_ids.add(row['ottId']); seen_names.add(row['scientificName'].casefold())

    print('Querying validated Wikidata taxa with English Wikipedia articles', flush=True)
    matched = opentree_matches(wikidata_taxa())
    pool, pool_ids = [], set()
    for row in matched:
        if row['ottId'] in seen_ids or row['ottId'] in pool_ids or row['scientificName'].casefold() in seen_names:
            continue
        pool_ids.add(row['ottId']); pool.append(row)
    needed = EXTERNAL_PROFILE_COUNT - len(existing)
    if len(pool) < needed:
        raise ValueError(f'Only {len(pool):,} new OpenTree/Wikidata matches were available; need {needed:,}')
    selected = pool[:needed]
    for row in selected:
        title = row['wikipediaTitle']
        article_url = f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}"
        article_identity = {'title': title, 'url': article_url}
        profile = {'ottId': row['ottId'], 'scientificName': row['scientificName'],
                   'selection': 'wikidata',
                   'commonNames': preferred_common_names([], article_identity, row['scientificName']),
                   'synonyms': [], 'wikidata': {'itemId': row['wikidataId'],
                   'articleTitle': title, 'articleUrl': article_url}}
        existing.append(profile)
    if len(existing) != EXTERNAL_PROFILE_COUNT or len({item['ottId'] for item in existing}) != EXTERNAL_PROFILE_COUNT:
        raise ValueError('Expanded profile snapshot is incomplete or contains duplicate OTT IDs')
    snapshot = {**snapshot, 'format': 2,
                'retrievedAt': datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                'sourcePriority': SOURCE_PRIORITY,
                'profiles': sorted(existing, key=lambda item: item['ottId'])}
    SNAPSHOT.write_text(compact_json(snapshot, pretty=True) + '\n', encoding='utf-8', newline='\n')
    print(f'Wrote {EXTERNAL_PROFILE_COUNT:,} externally enriched profiles to {SNAPSHOT}', flush=True)
    return snapshot


def validate_profile(profile):
    if not isinstance(profile.get('ottId'), int) or profile['ottId'] <= 0:
        raise ValueError('Profile has an invalid OTT ID')
    if not isinstance(profile.get('scientificName'), str) or not profile['scientificName']:
        raise ValueError('Profile has no scientific name')
    if len(profile.get('commonNames', [])) > 6 or len(profile.get('synonyms', [])) > 8:
        raise ValueError('Profile exceeds compact-list limits')
    gbif = profile.get('gbif')
    if gbif and (not isinstance(gbif.get('usageKey'), int) or gbif.get('usageKey') <= 0 or
                 gbif.get('canonicalName', '').casefold() != profile['scientificName'].casefold() or
                 not isinstance(gbif.get('confidence'), int) or not 0 <= gbif['confidence'] <= 100):
        raise ValueError(f"GBIF identity is not an exact canonical match for {profile['scientificName']}")
    article = profile.get('wikipedia')
    if article and (not article.get('url', '').startswith('https://en.wikipedia.org/wiki/') or
                    not isinstance(article.get('revisionId'), int) or not article.get('extract') or
                    not re.fullmatch(r'Q\d+', article.get('wikidataId', ''))):
        raise ValueError(f"Invalid Wikipedia attribution for {profile['scientificName']}")
    wikidata = profile.get('wikidata')
    if wikidata and (not re.fullmatch(r'Q\d+', wikidata.get('itemId', '')) or
                     not wikidata.get('articleTitle') or
                     not wikidata.get('articleUrl', '').startswith('https://en.wikipedia.org/wiki/')):
        raise ValueError(f"Invalid Wikidata identity for {profile['scientificName']}")
    conservation = profile.get('conservation')
    if conservation:
        source = conservation.get('source', {})
        expected_url = f"https://api.gbif.org/v1/species/{gbif['usageKey']}/iucnRedListCategory" if gbif else ''
        if (conservation.get('code') not in IUCN_CATEGORIES or
                conservation.get('category') != IUCN_CATEGORIES[conservation['code']] or
                conservation.get('system') != 'IUCN Red List' or
                (conservation.get('iucnTaxonId') is not None and
                 not re.fullmatch(r'\d+(?:_\d+)?', conservation['iucnTaxonId'])) or
                not source.get('label') or source.get('url') != expected_url):
            raise ValueError(f"Invalid conservation evidence for {profile['scientificName']}")
    image = profile.get('image')
    if image and (not image.get('src', '').startswith('images/') or
                  not image.get('sourceUrl', '').startswith('https://') or
                  not all(isinstance(image.get(key), str) and image[key].strip()
                          for key in ('alt', 'caption', 'credit', 'license'))):
        raise ValueError(f"Invalid media attribution for {profile['scientificName']}")
    facts = profile.get('facts', [])
    if len(facts) > 8:
        raise ValueError(f"Too many field notes for {profile['scientificName']}")
    for fact in facts:
        source = fact.get('source', {})
        if (fact.get('kind') not in {'status', 'age', 'trait', 'habitat', 'range'} or
                not all(isinstance(fact.get(key), str) and fact[key].strip() for key in ('label', 'value')) or
                not source.get('label') or not source.get('url', '').startswith('https://')):
            raise ValueError(f"Unsupported or unattributed fact for {profile['scientificName']}")


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


def apply_profile_overlays(profiles):
    by_id = {profile['ottId']: dict(profile) for profile in profiles}
    for ott_id, overlay in journey_profile_overlays().items():
        profile = by_id.get(ott_id)
        if not profile:
            raise ValueError(f'Journey profile OTT {ott_id} is absent from the source snapshot')
        if profile['scientificName'] != overlay['scientificName']:
            raise ValueError(f'Journey/OpenTree identity conflict for OTT {ott_id}: '
                             f"{overlay['scientificName']} != {profile['scientificName']}")
        profile['facts'] = overlay['facts']
        if overlay.get('image'):
            profile['image'] = overlay['image']
        by_id[ott_id] = profile
    return [by_id[profile['ottId']] for profile in profiles]


def curation_sha256():
    digest = hashlib.sha256()
    paths = [ROOT / 'data/content/journey-media.json',
             *sorted((ROOT / 'data/content/journeys').glob('*.json'))]
    for path in paths:
        digest.update(path.relative_to(ROOT).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def search_profile(profile):
    """Compact, lazy-loaded discovery metadata; descriptions remain in routed shards."""
    return [profile['ottId'], profile['scientificName'], profile.get('rank'),
            [item['name'] for item in profile.get('commonNames', [])], profile.get('synonyms', [])]


def tree_wide_profiles(existing, target_count):
    """Add a deterministic, topology-aware sample from the pinned OpenTree release.

    Sixty percent of the added records prioritize shallow named internal clades,
    then broad immediate radiations. The remainder is a stable hash sample of
    named terminal taxa. This makes profile coverage useful across the tree while
    keeping OpenTree-only identities distinct from external enrichment.
    """
    if len(existing) >= target_count:
        return []
    provenance = json.loads((ROOT / 'data/processed/opentree/life/provenance.json').read_text(encoding='utf-8'))
    folder = ROOT / provenance['snapshotPath']
    offsets = array('I')
    with (folder / 'labels.u32').open('rb') as stream:
        offsets.fromfile(stream, (folder / 'labels.u32').stat().st_size // offsets.itemsize)
    labels = (folder / 'labels.utf8').read_bytes()
    parents = array('i')
    with (folder / 'parents.i32').open('rb') as stream:
        parents.fromfile(stream, (folder / 'parents.i32').stat().st_size // parents.itemsize)
    node_count = len(offsets) // 2
    if len(parents) != node_count:
        raise ValueError('OpenTree parent and label indexes have different lengths')
    children = array('I', [0]) * node_count
    depths = array('B', [0]) * node_count
    for index, parent in enumerate(parents):
        if parent < 0:
            continue
        if parent >= index:
            raise ValueError('OpenTree compact graph is not parent-before-child ordered')
        children[parent] += 1
        depth = depths[parent] + 1
        if depth > 255:
            raise ValueError('OpenTree depth exceeds the profile selector format')
        depths[index] = depth
    seen = {item['ottId'] for item in existing}
    needed = target_count - len(existing)
    internal_limit = min(needed, round(needed * 0.60))
    terminal_limit = needed - internal_limit
    internal_heap, terminal_heap = [], []

    def retain(heap, limit, quality, index, profile):
        entry = (quality, index, profile)
        if len(heap) < limit:
            heapq.heappush(heap, entry)
        elif quality > heap[0][0]:
            heapq.heapreplace(heap, entry)

    for index in range(node_count):
        offset, length = offsets[index * 2], offsets[index * 2 + 1]
        label = labels[offset:offset + length].decode('utf-8')
        match = re.fullmatch(r'(.+)_ott(\d+)', label)
        if not match:
            continue
        name = match.group(1).replace('_', ' ').strip()
        ott_id = int(match.group(2))
        if ott_id in seen or not re.search(r'[A-Za-z]', name) or name.casefold().startswith('mrca'):
            continue
        digest = int.from_bytes(hashlib.sha256(f'{ott_id}:{name}'.encode()).digest()[:8], 'big')
        if children[index]:
            profile = {'ottId': ott_id, 'scientificName': name, 'selection': 'tree-wide-clade',
                       'commonNames': [], 'synonyms': []}
            # Larger tuple means more useful: shallower, broader, then stable hash.
            retain(internal_heap, internal_limit, (-depths[index], children[index], -digest), index, profile)
        else:
            profile = {'ottId': ott_id, 'scientificName': name, 'selection': 'tree-wide-terminal',
                       'commonNames': [], 'synonyms': []}
            retain(terminal_heap, terminal_limit, (-digest,), index, profile)
    result = [entry[2] for entry in sorted(internal_heap, reverse=True)]
    result.extend(entry[2] for entry in sorted(terminal_heap, reverse=True))
    if len(result) != needed:
        raise ValueError(f'Only {len(result):,} tree-wide profiles were available; needed {needed:,}')
    return result


def identity_crosswalk(profiles):
    """Build a compact OTT-to-external-ID crosswalk and report ambiguous reuse."""
    rows, gbif_ids, wikidata_ids = [], {}, {}
    for profile in profiles:
        gbif_key = (profile.get('gbif') or {}).get('usageKey')
        wikipedia = profile.get('wikipedia') or {}
        wikidata = profile.get('wikidata') or {}
        wikidata_id = wikipedia.get('wikidataId') or wikidata.get('itemId')
        wikipedia_title = wikipedia.get('title') or wikidata.get('articleTitle')
        if wikipedia.get('wikidataId') and wikidata.get('itemId') and wikipedia['wikidataId'] != wikidata['itemId']:
            raise ValueError(f"Conflicting Wikidata identities for OTT {profile['ottId']}")
        rows.append([profile['ottId'], gbif_key, wikidata_id, wikipedia_title])
        if gbif_key:
            gbif_ids.setdefault(gbif_key, []).append(profile['ottId'])
        if wikidata_id:
            wikidata_ids.setdefault(wikidata_id, []).append(profile['ottId'])
    return rows, {
        'openTree': len(rows),
        'gbif': sum(bool(row[1]) for row in rows),
        'wikidata': sum(bool(row[2]) for row in rows),
        'wikipedia': sum(bool(row[3]) for row in rows),
        'gbifIdentifierCollisions': sum(len(ids) > 1 for ids in gbif_ids.values()),
        # One article can legitimately cover a genus and one or more subtaxa.
        'wikidataIdentifierCollisions': sum(len(ids) > 1 for ids in wikidata_ids.values()),
    }


def publish(snapshot):
    source_profiles = snapshot.get('profiles', [])
    if (len(source_profiles) != EXTERNAL_PROFILE_COUNT or
            len({item['ottId'] for item in source_profiles}) != EXTERNAL_PROFILE_COUNT):
        raise ValueError(f'Profile snapshot must contain exactly {EXTERNAL_PROFILE_COUNT} unique enriched taxa; run with --expand')
    profiles = apply_profile_overlays(source_profiles)
    profiles.extend(tree_wide_profiles(profiles, COUNT))
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
    search_text = compact_json({'profiles': [search_profile(profile) for profile in public_profiles]}) + '\n'
    search_compressed = len(gzip.compress(search_text.encode(), compresslevel=9, mtime=0))
    if search_compressed > MAX_GZIP_SEARCH_BYTES:
        raise ValueError(f'Compressed profile search index exceeds {MAX_GZIP_SEARCH_BYTES} bytes')
    crosswalk, identity_coverage = identity_crosswalk(profiles)
    crosswalk_text = compact_json({'format': 1,
                                   'fields': ['ottId', 'gbifUsageKey', 'wikidataItemId', 'wikipediaTitle'],
                                   'records': crosswalk}) + '\n'
    crosswalk_compressed = len(gzip.compress(crosswalk_text.encode(), compresslevel=9, mtime=0))
    if crosswalk_compressed > MAX_GZIP_CROSSWALK_BYTES:
        raise ValueError(f'Compressed identity crosswalk exceeds {MAX_GZIP_CROSSWALK_BYTES} bytes')
    hash_value = hashlib.sha256()
    for index, text in enumerate(shard_text):
        hash_value.update(f'{index:02d}.json'.encode()); hash_value.update(text.encode())
    hash_value.update(b'search.json'); hash_value.update(search_text.encode())
    hash_value.update(b'crosswalk.json'); hash_value.update(crosswalk_text.encode())
    hash_value.update(sha256(SNAPSHOT).encode())
    hash_value.update(curation_sha256().encode())
    version = hash_value.hexdigest()[:16]
    coverage = {
        'profiles': len(profiles),
        'enriched': sum(bool(item.get('wikipedia') or item.get('wikidata') or item.get('gbif') or item.get('facts')) for item in profiles),
        'externallyEnriched': len(source_profiles),
        'openTreeOnly': len(profiles) - len(source_profiles),
        'treeWideClades': sum(item.get('selection') == 'tree-wide-clade' for item in profiles),
        'treeWideTerminals': sum(item.get('selection') == 'tree-wide-terminal' for item in profiles),
        'descriptions': sum('wikipedia' in item for item in public_profiles),
        'commonNames': sum(bool(item.get('commonNames')) for item in public_profiles),
        'synonyms': sum(bool(item.get('synonyms')) for item in public_profiles),
        'fieldNotes': sum(bool(item.get('facts')) for item in public_profiles),
        'conservation': sum(bool(item.get('conservation')) for item in public_profiles),
        'media': sum(bool(item.get('image')) for item in public_profiles),
        'wikidata': sum(item.get('selection') == 'wikidata' for item in profiles),
        'primates': sum(item.get('selection') == 'primates' for item in profiles),
        'aves': sum(item.get('selection') == 'aves' for item in profiles),
        'essential': sum(item.get('selection') == 'essential' for item in profiles),
    }
    compressed = [len(gzip.compress(text.encode(), compresslevel=9, mtime=0)) for text in shard_text]
    if max(compressed) > MAX_GZIP_SHARD_BYTES:
        raise ValueError(f'Compressed profile shard exceeds {MAX_GZIP_SHARD_BYTES} bytes')
    if sum(compressed) > MAX_GZIP_PUBLICATION_BYTES:
        raise ValueError(f'Compressed profile publication exceeds {MAX_GZIP_PUBLICATION_BYTES} bytes')
    manifest = {
        'format': 3, 'version': version, 'profileCount': COUNT, 'shardCount': SHARDS,
        'shardPattern': 'shards/{shard}.json', 'routing': 'ottId modulo shardCount',
        'maxCompressedShardBytes': max(compressed), 'compressedPublicationBytes': sum(compressed),
        'searchFile': 'search.json', 'compressedSearchBytes': search_compressed,
        'crosswalkFile': 'crosswalk.json', 'crosswalkCount': len(crosswalk),
        'compressedCrosswalkBytes': crosswalk_compressed, 'identityCoverage': identity_coverage,
        'retrievedAt': snapshot['retrievedAt'], 'openTree': snapshot['openTree'],
        'sourcePriority': {**snapshot['sourcePriority'],
                           'coverage': 'Every profile has pinned OpenTree identity; externallyEnriched counts records with independently sourced fields'},
        'coverage': coverage,
        'sources': [
            {'name': 'Open Tree of Life', 'url': 'https://tree.opentreeoflife.org/', 'role': 'taxon identity and topology'},
            {'name': 'GBIF Species API', 'url': 'https://techdocs.gbif.org/en/openapi/v1/species',
             'role': 'rank, common names, synonyms and IUCN Red List category'},
            {'name': 'English Wikipedia', 'url': 'https://en.wikipedia.org/', 'role': 'attributed introductory descriptions',
             'license': 'CC BY-SA 4.0'},
            {'name': 'Wikidata', 'url': 'https://www.wikidata.org/', 'role': 'article-to-taxon validation'},
            {'name': 'Journey research', 'url': 'data/journeys/manifest.json',
             'role': 'peer-reviewed, field-level facts and locally hosted attributed media'},
        ],
        'sourceSnapshotSha256': sha256(SNAPSHOT),
        'curationSha256': curation_sha256(),
    }
    if snapshot.get('conservationRetrievedAt'):
        manifest['conservationRetrievedAt'] = snapshot['conservationRetrievedAt']
    stage = OUTPUT / '.build-stage'
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    try:
        folder = stage / version / 'shards'; folder.mkdir(parents=True)
        for index, text in enumerate(shard_text):
            (folder / f'{index:02d}.json').write_text(text, encoding='utf-8', newline='\n')
        (stage / version / 'search.json').write_text(search_text, encoding='utf-8', newline='\n')
        (stage / version / 'crosswalk.json').write_text(crosswalk_text, encoding='utf-8', newline='\n')
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
                        'compressedPublicationBytes': sum(compressed),
                        'compressedSearchBytes': search_compressed,
                        'compressedCrosswalkBytes': crosswalk_compressed}, pretty=True))
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh', action='store_true', help='Fetch a new official-source snapshot before publishing')
    parser.add_argument('--expand', action='store_true', help='Expand the saved source snapshot to the full field-guide set')
    parser.add_argument('--audit-snapshot', action='store_true', help='Revalidate saved Wikipedia articles using Wikidata')
    parser.add_argument('--refresh-conservation', action='store_true',
                        help='Refresh IUCN Red List categories exposed by GBIF for exact GBIF matches')
    args = parser.parse_args()
    if args.refresh:
        snapshot = expand(refresh())
    elif SNAPSHOT.exists():
        snapshot = json.loads(SNAPSHOT.read_text(encoding='utf-8'))
    else:
        parser.error('Missing profile source snapshot. Run with --refresh once.')
    if args.expand:
        snapshot = expand(snapshot)
    if args.refresh_conservation:
        snapshot = refresh_conservation(snapshot)
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
