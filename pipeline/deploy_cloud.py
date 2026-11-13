"""Publish immutable files first, then promote a complete app release.

Local preflight needs no AWS credentials. Deploy/status/activate use the normal
boto3 credential chain (including an explicitly selected AWS profile). A full
deploy publishes locally built datasets; deploy-app reuses the active immutable
datasets and uploads only the newly built application. Retention is dry-run by
default; deletion requires explicit confirmation and separate S3 permission.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import time

DATASETS = ('life', 'aves', 'primates')
IMMUTABLE = 'public, max-age=31536000, immutable'
FRESH = 'no-cache, max-age=0, must-revalidate'
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
         '.css': 'text/css', '.json': 'application/json', '.bin': 'application/octet-stream',
         '.svg': 'image/svg+xml', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8'}


def valid_release(value):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', value):
        raise ValueError('Invalid release ID')
    return value


def content(path, canonical_manifest=False):
    raw = path.read_bytes()
    if canonical_manifest:
        value = json.loads(raw)
        # Build time is not part of the dataset content hash. Canonicalize it so
        # rebuilding the same scientific version cannot change an immutable URL.
        value = comparable_manifest(value)
        raw = (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode()
    return raw


def comparable_manifest(value):
    value = dict(value)
    value.pop('builtAt', None)
    # Older valid snapshots omit optional false feature flags.
    for flag in ('ancestryPages', 'detailPages'):
        value[flag] = bool(value.get(flag, False))
    return value


def app_sources(folder):
    root = Path(folder).resolve()
    if not (root / 'index.html').is_file():
        raise ValueError('Missing dist/index.html. Run npm run build:app first.')
    app_files = [root / 'index.html']
    for optional in ('DATA_SOURCES.txt',):
        if (root / optional).is_file():
            app_files.append(root / optional)
    assets = sorted((root / 'assets').glob('*'))
    if not assets:
        raise ValueError('Missing built application assets')
    profile_pointer = root / 'data' / 'profiles' / 'manifest.json'
    if not profile_pointer.is_file():
        raise ValueError('Missing scientific-profile publication. Run npm run data:profiles.')
    profile_manifest = json.loads(profile_pointer.read_text(encoding='utf-8'))
    profile_version = profile_manifest.get('version', '')
    shard_count = profile_manifest.get('shardCount', 0)
    if (not re.fullmatch(r'[0-9a-f]{16}', profile_version) or
            profile_manifest.get('format') != 3 or
            not isinstance(shard_count, int) or not 1 <= shard_count <= 512 or
            profile_manifest.get('profileCount') != 50000 or
            profile_manifest.get('maxCompressedShardBytes', 10**9) > 64 * 1024):
        raise ValueError('Invalid scientific-profile manifest')
    profile_folder = profile_pointer.parent / profile_version
    published = json.loads((profile_folder / 'manifest.json').read_text(encoding='utf-8'))
    if published != profile_manifest:
        raise ValueError('Scientific-profile pointer does not match version manifest')
    search_file = profile_manifest.get('searchFile')
    if search_file != 'search.json' or profile_manifest.get('compressedSearchBytes', 10**9) > 2 * 1024 * 1024:
        raise ValueError('Invalid scientific-profile search publication')
    crosswalk_file = profile_manifest.get('crosswalkFile')
    if (crosswalk_file != 'crosswalk.json' or profile_manifest.get('crosswalkCount') != 50000 or
            profile_manifest.get('compressedCrosswalkBytes', 10**9) > 1024 * 1024):
        raise ValueError('Invalid scientific identity crosswalk')
    profile_files = [profile_folder / 'manifest.json', profile_folder / search_file,
                     profile_folder / crosswalk_file]
    for shard in range(shard_count):
        path = profile_folder / 'shards' / f'{shard:02d}.json'
        if not path.is_file():
            raise ValueError(f'Missing scientific-profile shard {shard:02d}')
        profile_files.append(path)
    for path in profile_files:
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError('Scientific-profile publication contains a symlink/outside file')
    app_files.append(profile_pointer)
    assets.extend(profile_files)

    journey_pointer = root / 'data' / 'journeys' / 'manifest.json'
    if not journey_pointer.is_file():
        raise ValueError('Missing Journey publication. Run npm run data:journeys.')
    journey_manifest = json.loads(journey_pointer.read_text(encoding='utf-8'))
    journey_version = journey_manifest.get('version', '')
    if (not re.fullmatch(r'[0-9a-f]{16}', journey_version) or journey_manifest.get('journeyCount', 0) < 3 or
            journey_manifest.get('maxCompressedJourneyBytes', 10**9) > 20 * 1024 or
            journey_manifest.get('compressedCatalogBytes', 10**9) > 8 * 1024):
        raise ValueError('Invalid Journey manifest')
    journey_folder = journey_pointer.parent / journey_version
    if json.loads((journey_folder / 'manifest.json').read_text(encoding='utf-8')) != journey_manifest:
        raise ValueError('Journey pointer does not match version manifest')
    catalog_path = journey_folder / journey_manifest['catalogFile']
    catalog = json.loads(catalog_path.read_text(encoding='utf-8')).get('journeys', [])
    if len(catalog) != journey_manifest['journeyCount']:
        raise ValueError('Journey catalog is incomplete')
    journey_files = [journey_folder / 'manifest.json', catalog_path]
    for item in catalog:
        path = journey_folder / journey_manifest['journeyPattern'].replace('{id}', item['id'])
        if not path.is_file():
            raise ValueError(f'Missing Journey file: {item["id"]}')
        journey_files.append(path)
    image_files = sorted((root / 'images' / 'journeys').rglob('*.webp'))
    if not image_files:
        raise ValueError('Missing Journey images')
    for path in journey_files + image_files:
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError('Journey publication contains a symlink/outside file')
    app_files.extend([journey_pointer, *image_files])
    assets.extend(journey_files)
    return root, app_files, assets


def release_identity(root, app_files, assets, pointers):
    identity = hashlib.sha256()
    local = {path.relative_to(root).as_posix(): content(path) for path in app_files + assets if path.is_file()}
    for key, raw in sorted({**local, **pointers}.items()):
        identity.update(key.encode())
        identity.update(raw)
    return identity.hexdigest()[:24]


def prepare(folder, data_folder=None):
    root, app_files, assets = app_sources(folder)
    data_root = Path(data_folder).resolve() if data_folder else root
    versions, files, pointers = {}, [], {}
    for path in assets:
        if path.is_file() and path.suffix in TYPES:
            files.append((path, path.relative_to(root).as_posix(), False))
    for dataset in DATASETS:
        pointer = root / 'data' / dataset / 'manifest.json'
        manifest = json.loads(pointer.read_text(encoding='utf-8'))
        version = manifest['version']
        if not re.fullmatch(r'[0-9a-f]{16}', version):
            raise ValueError('Invalid dataset version')
        versions[dataset] = version
        dataset_folder = data_root / 'data' / dataset / version
        published = json.loads((dataset_folder / 'manifest.json').read_text(encoding='utf-8'))
        if comparable_manifest(published) != comparable_manifest(manifest):
            raise ValueError(f'{dataset}: pointer does not match version manifest')
        for page in range(manifest['pageCount']):
            if not (dataset_folder / 'pages' / f'{page}.bin').is_file():
                raise ValueError(f'{dataset}: missing geometry page {page}')
        for required in (['search-top.json', 'overview.json'] if dataset == 'life' else ['search.json']):
            # Older formats expose their own search directory name.
            if required == 'search.json':
                required = manifest.get('searchDirectory', 'search.json')
            if not (dataset_folder / required).is_file():
                raise ValueError(f'{dataset}: missing {required}')
        if dataset == 'life':
            tiles = manifest.get('tiles', {})
            if (tiles.get('format') != 2 or tiles.get('indexFile') != 'tiles/index.json' or
                    tiles.get('maxCompressedTileBytes', 10**9) > 256 * 1024 or
                    tiles.get('compressedBytes', 10**9) > 128 * 1024 * 1024):
                raise ValueError('life: invalid spatial tile publication')
            tile_index = json.loads((dataset_folder / tiles['indexFile']).read_text(encoding='utf-8'))
            listed = [(level['z'], key) for level in tile_index.get('levels', []) for key in level.get('tiles', [])]
            if len(listed) != tiles.get('tileCount'):
                raise ValueError('life: spatial tile count does not match its index')
            for level, key in listed:
                if not re.fullmatch(r'\d+/\d+', key) or not (dataset_folder / 'tiles' / str(level) / f'{key}.json').is_file():
                    raise ValueError(f'life: missing spatial tile {level}/{key}')
        for path in sorted(dataset_folder.rglob('*')):
            if path.is_file():
                if path.is_symlink() or not path.resolve().is_relative_to(data_root):
                    raise ValueError('Publication contains a symlink/outside file')
                if path.suffix not in ('.json', '.bin'):
                    raise ValueError(f'Unexpected dataset file: {path}')
                key = (Path('data') / dataset / version / path.relative_to(dataset_folder)).as_posix()
                files.append((path, key, path == dataset_folder / 'manifest.json'))
        app_files.append(pointer)
        pointers[pointer.relative_to(root).as_posix()] = content(pointer)
    release = release_identity(root, app_files, assets, pointers)
    for path in app_files:
        files.append((path, f'releases/{release}/{path.relative_to(root).as_posix()}', False))
    return release, versions, files


def prepare_app(folder, pointers):
    root, app_files, assets = app_sources(folder)
    expected = {f'data/{dataset}/manifest.json' for dataset in DATASETS}
    if set(pointers) != expected:
        raise ValueError('Active release does not contain every dataset pointer')
    versions = {}
    for dataset in DATASETS:
        manifest = json.loads(pointers[f'data/{dataset}/manifest.json'])
        version = manifest.get('version', '')
        if not re.fullmatch(r'[0-9a-f]{16}', version):
            raise ValueError(f'{dataset}: invalid active dataset version')
        versions[dataset] = version
    release = release_identity(root, app_files, assets, pointers)
    files = [(path, path.relative_to(root).as_posix(), False) for path in assets
             if path.is_file() and path.suffix in TYPES]
    files.extend((path, f'releases/{release}/{path.relative_to(root).as_posix()}', False)
                 for path in app_files)
    blobs = [(raw, f'releases/{release}/{key}', Path(key).suffix) for key, raw in pointers.items()]
    return release, versions, files, blobs


def encode_bytes(raw, suffix, key):
    body = gzip.compress(raw, compresslevel=6, mtime=0)
    return body, {
        'ContentType': TYPES[suffix], 'ContentEncoding': 'gzip',
        'CacheControl': (IMMUTABLE if re.match(r'^releases/[^/]+/(?:data/(?:profiles|journeys)/[0-9a-f]{16}/|images/journeys/)', key)
                         else FRESH if key.startswith('releases/') else IMMUTABLE),
        'Metadata': {'sha256': hashlib.sha256(raw).hexdigest()},
        'ContentMD5': base64.b64encode(hashlib.md5(body).digest()).decode(),
    }


def encode(path, key, canonical=False):
    return encode_bytes(content(path, canonical), path.suffix, key)


def listing(s3, bucket, prefixes):
    found = {}
    for prefix in prefixes:
        for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=prefix):
            for item in page.get('Contents', []):
                found[item['Key']] = {'etag': item['ETag'].strip('"'), 'size': item['Size']}
    return found


def retention_listing(s3, bucket, prefixes):
    """List current objects with the metadata needed for a conservative retention plan."""
    found = {}
    for prefix in prefixes:
        for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=prefix):
            for item in page.get('Contents', []):
                found[item['Key']] = {'size': item['Size'], 'lastModified': item['LastModified']}
    return found


def retention_category(key):
    parts = key.split('/')
    if parts[0] == 'data' and len(parts) > 1:
        return f'data/{parts[1]}'
    return parts[0]


def plan_retention(active, objects, releases, *, now=None, keep_releases=5, grace_days=30, warnings=None):
    """Return a deletion plan without mutating S3.

    `releases` maps release IDs to validated release records and their record
    timestamps. The active release, newest N releases, and every release inside
    the grace window are retained. Only objects unreferenced by all retained
    inventories can become candidates.
    """
    if keep_releases < 2:
        raise ValueError('Retention must keep at least two recent releases')
    if grace_days < 7:
        raise ValueError('Retention grace period must be at least seven days')
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=grace_days)
    ordered = sorted(releases, key=lambda item: releases[item]['lastModified'], reverse=True)
    retained = set(ordered[:keep_releases])
    retained.add(active)
    retained.update(item for item in ordered if releases[item]['lastModified'] >= cutoff)
    expired = set(releases) - retained
    protected = set()
    for release in retained & set(releases):
        protected.add(f'releases/{release}/release.json')
        protected.update(releases[release]['record']['objects'])

    candidates, orphans, recent_unreferenced = [], [], []
    for key, metadata in objects.items():
        if key in protected:
            continue
        match = re.fullmatch(r'releases/([^/]+)/.*', key)
        if match:
            release = match.group(1)
            if release not in releases:
                orphans.append(key)
                continue
            if release not in expired:
                continue
        elif not (key.startswith('data/') or key.startswith('assets/')):
            continue
        if metadata['lastModified'] >= cutoff:
            recent_unreferenced.append(key)
            continue
        candidates.append({'key': key, 'size': metadata['size'],
                           'lastModified': metadata['lastModified'].isoformat()})

    candidates.sort(key=lambda item: (item['key'].endswith('/release.json'), item['key']))
    by_prefix = {}
    for item in candidates:
        category = retention_category(item['key'])
        summary = by_prefix.setdefault(category, {'objects': 0, 'bytes': 0})
        summary['objects'] += 1; summary['bytes'] += item['size']
    warnings = list(warnings or [])
    if active not in releases:
        warnings.append(f'Active release record is missing or invalid: {active}')
    missing = sorted(key for key in protected if key not in objects)
    if missing:
        warnings.append(f'{len(missing)} retained inventory objects are absent from the current S3 listing')
    return {
        'mode': 'dry-run', 'activeRelease': active, 'keepNewestReleases': keep_releases,
        'graceDays': grace_days, 'cutoff': cutoff.isoformat(),
        'retainedReleases': sorted(retained), 'expiredReleases': sorted(expired),
        'protectedObjects': len(protected), 'candidateObjects': candidates,
        'candidateObjectCount': len(candidates),
        'candidateBytes': sum(item['size'] for item in candidates), 'candidatesByPrefix': by_prefix,
        'orphanObjectsNotAutomaticallyDeleted': sorted(orphans),
        'recentUnreferencedObjects': sorted(recent_unreferenced),
        'warnings': warnings, 'safeToApply': not warnings,
    }


def retention_report(s3, cf, bucket, distribution, *, keep_releases=5, grace_days=30):
    active = current_release(cf, distribution)
    objects = retention_listing(s3, bucket, ['releases/', 'data/', 'assets/'])
    releases, warnings = {}, []
    for key, metadata in objects.items():
        match = re.fullmatch(r'releases/([^/]+)/release\.json', key)
        if not match:
            continue
        release = match.group(1)
        try:
            valid_release(release)
            record, _ = read_json_object(s3, bucket, key)
            if record.get('release') != release or not isinstance(record.get('objects'), dict):
                raise ValueError('release ID or inventory mismatch')
            releases[release] = {'record': record, 'lastModified': metadata['lastModified']}
        except Exception as error:  # A malformed retained record must block deletion, not the audit.
            warnings.append(f'{key}: {error}')
    return plan_retention(active, objects, releases, keep_releases=keep_releases,
                          grace_days=grace_days, warnings=warnings)


def apply_retention(s3, cf, bucket, distribution, report, confirmation):
    if confirmation != bucket:
        raise ValueError('Retention apply requires --confirm-bucket with the exact bucket name')
    if not report.get('safeToApply'):
        raise ValueError('Refusing retention apply because the audit reported warnings')
    if current_release(cf, distribution) != report['activeRelease']:
        raise ValueError('Active release changed after the retention audit; run a new dry-run')
    keys = [item['key'] for item in report['candidateObjects']]
    for start in range(0, len(keys), 1000):
        response = s3.delete_objects(Bucket=bucket, Delete={
            'Objects': [{'Key': key} for key in keys[start:start + 1000]], 'Quiet': True,
        })
        if response.get('Errors'):
            raise ValueError(f"S3 retention deletion failed: {response['Errors']}")
    return {**report, 'mode': 'applied', 'deletedObjects': len(keys),
            'note': 'S3 versioning retains recoverable noncurrent versions until the bucket lifecycle expires them.'}


def upload_file(s3, bucket, entry, existing):
    path, key, canonical = entry
    body, options = encode(path, key, canonical)
    expected = {'etag': hashlib.md5(body).hexdigest(), 'size': len(body)}
    previous = existing.get(key)
    if previous != expected:
        if previous:
            remote = s3.head_object(Bucket=bucket, Key=key)
            if (remote.get('Metadata') != options['Metadata'] or
                    any(remote.get(k) != options[k] for k in ('ContentType', 'ContentEncoding', 'CacheControl'))):
                raise ValueError(f'Refusing to overwrite immutable object: {key}')
            # Different zlib versions may encode identical source bytes differently.
            return key, previous
        s3.put_object(Bucket=bucket, Key=key, Body=body, **options)
    return key, expected


def upload_bytes(s3, bucket, entry, existing):
    raw, key, suffix = entry
    body, options = encode_bytes(raw, suffix, key)
    expected = {'etag': hashlib.md5(body).hexdigest(), 'size': len(body)}
    previous = existing.get(key)
    if previous != expected:
        if previous:
            remote = s3.head_object(Bucket=bucket, Key=key)
            if (remote.get('Metadata') != options['Metadata'] or
                    any(remote.get(k) != options[k] for k in ('ContentType', 'ContentEncoding', 'CacheControl'))):
                raise ValueError(f'Refusing to overwrite immutable object: {key}')
            return key, previous
        s3.put_object(Bucket=bucket, Key=key, Body=body, **options)
    return key, expected


def verify_inventory(expected, actual):
    for key, metadata in expected.items():
        if actual.get(key) != metadata:
            raise ValueError(f'Incomplete or changed cloud release: {key}')


def app_origin(config):
    return next(item for item in config['Origins']['Items'] if item['Id'] == 'AppOrigin')


def read_json_object(s3, bucket, key):
    response = s3.get_object(Bucket=bucket, Key=key)
    raw = response['Body'].read()
    if response.get('ContentEncoding') == 'gzip' or key.endswith('/release.json'):
        raw = gzip.decompress(raw)
    return json.loads(raw), raw


def current_release(cf, distribution):
    state = cf.get_distribution(Id=distribution)['Distribution']
    if state['Status'] != 'Deployed':
        raise ValueError('Another distribution update is in progress. Wait before publishing.')
    release = app_origin(state['DistributionConfig']).get('OriginPath', '').removeprefix('/releases/')
    valid_release(release)
    return release


def inherited_data_inventory(record, versions):
    if record.get('datasets') != versions:
        raise ValueError('Active release record does not match its dataset pointers')
    expected = tuple(f'data/{dataset}/{version}/' for dataset, version in versions.items())
    inherited = {key: value for key, value in record.get('objects', {}).items() if key.startswith(expected)}
    if not all(any(key.startswith(prefix) for key in inherited) for prefix in expected):
        raise ValueError('Active release has no verified immutable dataset inventory')
    return inherited


def wait_distribution(cf, distribution):
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        state = cf.get_distribution(Id=distribution)['Distribution']
        if state['Status'] == 'Deployed':
            return state
        print('Waiting for CloudFront propagation…', flush=True)
        time.sleep(20)
    raise TimeoutError('CloudFront still propagating; inspect status before another deployment.')


def activate(s3, cf, bucket, distribution, release):
    valid_release(release)
    record_key = f'releases/{release}/release.json'
    record = json.loads(gzip.decompress(s3.get_object(Bucket=bucket, Key=record_key)['Body'].read()))
    if record['release'] != release:
        raise ValueError('Release record mismatch')
    verify_inventory(record['objects'], listing(s3, bucket, ['data/', 'assets/', f'releases/{release}/']))
    current = cf.get_distribution(Id=distribution)['Distribution']
    if current['Status'] != 'Deployed':
        raise ValueError('Another distribution update is in progress. Wait before promoting.')
    response = cf.get_distribution_config(Id=distribution)
    config = response['DistributionConfig']
    origin = app_origin(config)
    if not origin['DomainName'].startswith(bucket + '.'):
        raise ValueError('Distribution does not reference the specified bucket')
    previous = origin.get('OriginPath', '').removeprefix('/releases/')
    if previous != release:
        origin['OriginPath'] = f'/releases/{release}'
        cf.update_distribution(Id=distribution, IfMatch=response['ETag'], DistributionConfig=config)
        wait_distribution(cf, distribution)
    # Mutable HTML/pointers are uncached. Purge cached initial 403s as well.
    cf.create_invalidation(DistributionId=distribution, InvalidationBatch={
        'CallerReference': f'{release}-{time.time_ns()}',
        'Paths': {'Quantity': 1, 'Items': ['/*']}})
    url = 'https://' + current['DomainName']
    print(json.dumps({'url': url, 'activeRelease': release, 'previousRelease': previous,
                      'rollback': None if previous == 'unpublished' else f'python pipeline/deploy_cloud.py activate --bucket {bucket} --distribution {distribution} --release {previous}'}, indent=2))


def deploy(s3, cf, bucket, distribution, folder, data_folder=None):
    release, versions, files = prepare(folder, data_folder)
    existing = listing(s3, bucket, ['data/', 'assets/', f'releases/{release}/'])
    inventory = {}
    with ThreadPoolExecutor(max_workers=12) as executor:
        for start in range(0, len(files), 128):
            results = executor.map(lambda entry: upload_file(s3, bucket, entry, existing), files[start:start + 128])
            inventory.update(results)
            if start % 2048 == 0:
                print(f'Uploaded or reused {min(start + 128, len(files)):,}/{len(files):,} objects', flush=True)
    verify_inventory(inventory, listing(s3, bucket, ['data/', 'assets/', f'releases/{release}/']))
    record = {'release': release, 'datasets': versions, 'objects': inventory}
    s3.put_object(Bucket=bucket, Key=f'releases/{release}/release.json',
                  Body=gzip.compress(json.dumps(record, sort_keys=True).encode(), mtime=0),
                  ContentType='application/json', ContentEncoding='gzip', CacheControl=FRESH)
    activate(s3, cf, bucket, distribution, release)


def deploy_app(s3, cf, bucket, distribution, folder):
    active = current_release(cf, distribution)
    record, _ = read_json_object(s3, bucket, f'releases/{active}/release.json')
    pointers = {}
    for dataset in DATASETS:
        key = f'data/{dataset}/manifest.json'
        _, pointers[key] = read_json_object(s3, bucket, f'releases/{active}/{key}')
    release, versions, files, blobs = prepare_app(folder, pointers)
    inventory = inherited_data_inventory(record, versions)
    existing = listing(s3, bucket, ['assets/', 'data/profiles/', 'data/journeys/', f'releases/{release}/'])
    with ThreadPoolExecutor(max_workers=12) as executor:
        inventory.update(executor.map(lambda entry: upload_file(s3, bucket, entry, existing), files))
        inventory.update(executor.map(lambda entry: upload_bytes(s3, bucket, entry, existing), blobs))
    tree_prefixes = tuple(f'data/{dataset}/' for dataset in DATASETS)
    app_inventory = {key: value for key, value in inventory.items() if not key.startswith(tree_prefixes)}
    verify_inventory(app_inventory, listing(s3, bucket,
                     ['assets/', 'data/profiles/', 'data/journeys/', f'releases/{release}/']))
    next_record = {'release': release, 'datasets': versions, 'objects': inventory}
    s3.put_object(Bucket=bucket, Key=f'releases/{release}/release.json',
                  Body=gzip.compress(json.dumps(next_record, sort_keys=True).encode(), mtime=0),
                  ContentType='application/json', ContentEncoding='gzip', CacheControl=FRESH)
    activate(s3, cf, bucket, distribution, release)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['preflight', 'deploy', 'deploy-app', 'activate', 'status', 'retention'])
    parser.add_argument('--dist', default='dist')
    parser.add_argument('--data-root', help='Root containing data/<dataset>/<version>; defaults to --dist')
    parser.add_argument('--bucket')
    parser.add_argument('--distribution')
    parser.add_argument('--release')
    parser.add_argument('--profile')
    parser.add_argument('--region', default='us-east-1')
    parser.add_argument('--keep-releases', type=int, default=5,
                        help='Retention audit: always preserve at least this many newest releases (minimum 2)')
    parser.add_argument('--grace-days', type=int, default=30,
                        help='Retention audit: never remove objects newer than this many days (minimum 7)')
    parser.add_argument('--apply', action='store_true', help='Apply a reviewed retention plan; dry-run is the default')
    parser.add_argument('--confirm-bucket', help='Required with --apply; must exactly match --bucket')
    args = parser.parse_args()
    if (args.apply or args.confirm_bucket) and args.command != 'retention':
        parser.error('--apply and --confirm-bucket are valid only for the retention command')
    if args.command == 'preflight':
        release, versions, files = prepare(args.dist, args.data_root)
        print(json.dumps({'release': release, 'datasets': versions, 'files': len(files),
                          'sourceBytes': sum(p.stat().st_size for p, _, _ in files)}, indent=2))
        return
    if not args.distribution or (args.command != 'status' and not args.bucket):
        parser.error('--distribution and --bucket are required except for preflight/status; --distribution for status')
    if args.command == 'activate' and not args.release:
        parser.error('--release is required for activate')
    import boto3
    from botocore.config import Config
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    configuration = Config(retries={'mode': 'standard', 'max_attempts': 5}, max_pool_connections=16)
    s3 = session.client('s3', config=configuration)
    cf = session.client('cloudfront', config=configuration)
    if args.command == 'status':
        state = cf.get_distribution(Id=args.distribution)['Distribution']
        print(json.dumps({'status': state['Status'], 'url': 'https://' + state['DomainName'],
                          'release': app_origin(state['DistributionConfig']).get('OriginPath')}, indent=2))
    elif args.command == 'retention':
        try:
            report = retention_report(s3, cf, args.bucket, args.distribution,
                                      keep_releases=args.keep_releases, grace_days=args.grace_days)
            if args.apply:
                report = apply_retention(s3, cf, args.bucket, args.distribution, report, args.confirm_bucket)
        except ValueError as error:
            parser.error(str(error))
        print(json.dumps(report, indent=2))
    elif args.command == 'activate':
        activate(s3, cf, args.bucket, args.distribution, args.release)
    elif args.command == 'deploy-app':
        deploy_app(s3, cf, args.bucket, args.distribution, args.dist)
    else:
        deploy(s3, cf, args.bucket, args.distribution, args.dist, args.data_root)


if __name__ == '__main__':
    main()
