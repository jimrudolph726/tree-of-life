"""Validate editorial Journey files and publish immutable, lazy JSON assets."""

from __future__ import annotations

from array import array
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil


ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / 'data/content/journeys'
MEDIA_FILE = ROOT / 'data/content/journey-media.json'
OUTPUT = ROOT / 'public/data/journeys'
MAX_GZIP_JOURNEY_BYTES = 20 * 1024
MAX_GZIP_CATALOG_BYTES = 8 * 1024


def compact(value, pretty=False):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      indent=2 if pretty else None, separators=None if pretty else (',', ':'))


def sha256_bytes(value: bytes):
    return hashlib.sha256(value).hexdigest()


def opentree_names():
    provenance = json.loads((ROOT / 'data/processed/opentree/life/provenance.json').read_text(encoding='utf-8'))
    folder = ROOT / provenance['snapshotPath']
    offsets = array('I')
    with (folder / 'labels.u32').open('rb') as stream:
        offsets.fromfile(stream, (folder / 'labels.u32').stat().st_size // offsets.itemsize)
    labels = (folder / 'labels.utf8').read_bytes()
    result = {}
    for offset, length in zip(offsets[::2], offsets[1::2]):
        label = labels[offset:offset + length].decode('utf-8')
        match = re.fullmatch(r'(.+)_ott(\d+)', label)
        if match:
            result[int(match.group(2))] = match.group(1).replace('_', ' ')
    return result, provenance


def require_text(value, name, minimum):
    if not isinstance(value, str) or len(value.strip()) < minimum:
        raise ValueError(f'{name} must contain at least {minimum} characters')


def validate_and_expand(value, path, media, tree_names):
    journey_id = value.get('id')
    if not isinstance(journey_id, str) or not re.fullmatch(r'[a-z0-9-]+', journey_id) or path.stem != journey_id:
        raise ValueError(f'{path}: invalid or mismatched journey ID')
    for field, minimum in [('category', 2), ('title', 10), ('subtitle', 40), ('introduction', 80)]:
        require_text(value.get(field), f'{journey_id}.{field}', minimum)
    if not re.fullmatch(r'\d+[–-]\d+ min', value.get('duration', '')):
        raise ValueError(f'{journey_id}: invalid duration')
    completion = value.get('completion', {})
    require_text(completion.get('title'), f'{journey_id}.completion.title', 10)
    require_text(completion.get('summary'), f'{journey_id}.completion.summary', 60)
    steps = value.get('steps')
    if not isinstance(steps, list) or not 8 <= len(steps) <= 10:
        raise ValueError(f'{journey_id}: journeys require 8–10 steps')
    titles = set()
    expanded = []
    for index, step in enumerate(steps, 1):
        prefix = f'{journey_id}.step{index}'
        for field, minimum in [('title', 8), ('taxon', 2), ('age', 2), ('era', 2),
                               ('summary', 80), ('evidence', 60), ('uncertainty', 40)]:
            require_text(step.get(field), f'{prefix}.{field}', minimum)
        if step['title'] in titles:
            raise ValueError(f'{journey_id}: duplicate step title {step["title"]}')
        titles.add(step['title'])
        if step.get('kind') not in ('fossil evidence', 'living lineage'):
            raise ValueError(f'{prefix}: invalid evidence kind')
        ott_id = step.get('ottId')
        expected_name = step.get('mapTaxon') or step['taxon']
        if not isinstance(ott_id, int) or tree_names.get(ott_id) != expected_name:
            raise ValueError(f'{prefix}: OTT {ott_id} resolves to {tree_names.get(ott_id)!r}, expected {expected_name!r}')
        sources = step.get('sources')
        if not isinstance(sources, list) or not sources or any(
                not isinstance(source.get('label'), str) or not source.get('url', '').startswith('https://')
                for source in sources):
            raise ValueError(f'{prefix}: every step needs an HTTPS source')
        authored_image = step.get('image', {})
        require_text(authored_image.get('alt'), f'{prefix}.image.alt', 30)
        require_text(authored_image.get('caption'), f'{prefix}.image.caption', 40)
        media_id = authored_image.get('mediaId')
        if media_id not in media:
            raise ValueError(f'{prefix}: unknown media ID {media_id!r}')
        record = media[media_id]
        for field in ('src', 'credit', 'license', 'sourceUrl', 'sha256'):
            require_text(record.get(field), f'{prefix}.media.{field}', 2)
        if not record['sourceUrl'].startswith('https://'):
            raise ValueError(f'{prefix}: image source must use HTTPS')
        if not (record['license'].startswith(('CC ', 'CC0')) or
                'public domain' in record['license'].casefold()):
            raise ValueError(f'{prefix}: unsupported image license {record["license"]!r}')
        image_path = ROOT / 'public' / record['src']
        if not image_path.is_file():
            raise ValueError(f'{prefix}: missing image {record["src"]}')
        if record.get('sha256') not in ('checked-in-existing-asset', sha256_bytes(image_path.read_bytes())):
            raise ValueError(f'{prefix}: image checksum changed for {media_id}')
        image = {**authored_image, **{key: record[key] for key in ('src', 'credit', 'license', 'sourceUrl')}}
        image.pop('mediaId', None)
        expanded.append({**step, 'image': image})
    return {**value, 'steps': expanded}


def main():
    media_value = json.loads(MEDIA_FILE.read_text(encoding='utf-8'))
    if media_value.get('format') != 1 or not isinstance(media_value.get('media'), dict):
        raise ValueError('Journey media metadata is invalid')
    names, provenance = opentree_names()
    journeys = [validate_and_expand(json.loads(path.read_text(encoding='utf-8')), path,
                                    media_value['media'], names)
                for path in sorted(CONTENT.glob('*.json'))]
    if len(journeys) < 3:
        raise ValueError('The Journey library must publish at least three journeys')
    catalog = [{key: journey[key] for key in ('id', 'category', 'title', 'subtitle', 'duration')}
               | {'stepCount': len(journey['steps']), 'coverImage': journey['steps'][0]['image']}
               for journey in journeys]
    journey_text = {journey['id']: compact(journey) + '\n' for journey in journeys}
    compressed = {journey_id: len(gzip.compress(text.encode(), compresslevel=9, mtime=0))
                  for journey_id, text in journey_text.items()}
    if max(compressed.values()) > MAX_GZIP_JOURNEY_BYTES:
        raise ValueError('A compressed Journey exceeds its payload budget')
    catalog_text = compact({'journeys': catalog}) + '\n'
    catalog_gzip = len(gzip.compress(catalog_text.encode(), compresslevel=9, mtime=0))
    if catalog_gzip > MAX_GZIP_CATALOG_BYTES:
        raise ValueError('The compressed Journey catalog exceeds its payload budget')
    digest = hashlib.sha256()
    for journey_id, text in journey_text.items():
        digest.update(journey_id.encode()); digest.update(text.encode())
    digest.update(catalog_text.encode())
    version = digest.hexdigest()[:16]
    manifest = {
        'format': 1, 'version': version, 'journeyCount': len(journeys), 'catalogFile': 'catalog.json',
        'journeyPattern': '{id}.json', 'maxCompressedJourneyBytes': max(compressed.values()),
        'compressedCatalogBytes': catalog_gzip,
        'openTree': {'synthId': provenance['synthId'], 'taxonomyVersion': provenance['taxonomyVersion']},
    }
    stage = OUTPUT / '.build-stage'
    if stage.exists(): shutil.rmtree(stage)
    folder = stage / version; folder.mkdir(parents=True)
    try:
        (folder / 'catalog.json').write_text(catalog_text, encoding='utf-8', newline='\n')
        for journey_id, text in journey_text.items():
            (folder / f'{journey_id}.json').write_text(text, encoding='utf-8', newline='\n')
        manifest_text = compact(manifest, pretty=True) + '\n'
        (folder / 'manifest.json').write_text(manifest_text, encoding='utf-8', newline='\n')
        destination = OUTPUT / version
        if destination.exists():
            if (destination / 'manifest.json').read_text(encoding='utf-8') != manifest_text:
                raise ValueError('Refusing to overwrite an immutable Journey publication')
        else:
            OUTPUT.mkdir(parents=True, exist_ok=True)
            shutil.copytree(folder, destination)
        next_pointer = OUTPUT / 'manifest.next.json'
        next_pointer.write_text(manifest_text, encoding='utf-8', newline='\n')
        next_pointer.replace(OUTPUT / 'manifest.json')
    finally:
        shutil.rmtree(stage)
    print(compact({'version': version, 'journeys': len(journeys),
                   'catalogGzipBytes': catalog_gzip, 'maxJourneyGzipBytes': max(compressed.values())}, pretty=True))


if __name__ == '__main__':
    main()
