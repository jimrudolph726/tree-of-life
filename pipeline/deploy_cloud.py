"""Publish immutable files first, then promote a complete app release. No deletes.

Local preflight needs no AWS credentials. Deploy/status/activate use the normal
boto3 credential chain (including an explicitly selected AWS profile).
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
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
         '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8'}


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


def prepare(folder):
    root = Path(folder).resolve()
    if not (root / 'index.html').is_file():
        raise ValueError('Missing dist/index.html. Run npm run build first.')
    versions, files = {}, []
    app_files = [root / 'index.html']
    for optional in ('DATA_SOURCES.txt',):
        if (root / optional).is_file():
            app_files.append(root / optional)
    assets = sorted((root / 'assets').glob('*'))
    if not assets:
        raise ValueError('Missing built application assets')
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
        folder = pointer.parent / version
        published = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
        if comparable_manifest(published) != comparable_manifest(manifest):
            raise ValueError(f'{dataset}: pointer does not match version manifest')
        for page in range(manifest['pageCount']):
            if not (folder / 'pages' / f'{page}.bin').is_file():
                raise ValueError(f'{dataset}: missing geometry page {page}')
        for required in (['search-top.json', 'overview.json'] if dataset == 'life' else ['search.json']):
            # Older formats expose their own search directory name.
            if required == 'search.json':
                required = manifest.get('searchDirectory', 'search.json')
            if not (folder / required).is_file():
                raise ValueError(f'{dataset}: missing {required}')
        for path in sorted(folder.rglob('*')):
            if path.is_file():
                if path.is_symlink() or not path.resolve().is_relative_to(root):
                    raise ValueError('Publication contains a symlink/outside file')
                if path.suffix not in ('.json', '.bin'):
                    raise ValueError(f'Unexpected dataset file: {path}')
                files.append((path, path.relative_to(root).as_posix(), path == folder / 'manifest.json'))
        app_files.append(pointer)
    identity = hashlib.sha256()
    for path in sorted(app_files + assets):
        if path.is_file():
            identity.update(path.relative_to(root).as_posix().encode())
            identity.update(content(path))
    release = identity.hexdigest()[:24]
    for path in app_files:
        files.append((path, f'releases/{release}/{path.relative_to(root).as_posix()}', False))
    return release, versions, files


def encode(path, key, canonical=False):
    raw = content(path, canonical)
    body = gzip.compress(raw, compresslevel=6, mtime=0)
    return body, {
        'ContentType': TYPES[path.suffix], 'ContentEncoding': 'gzip',
        'CacheControl': FRESH if key.startswith('releases/') else IMMUTABLE,
        'Metadata': {'sha256': hashlib.sha256(raw).hexdigest()},
        'ContentMD5': base64.b64encode(hashlib.md5(body).digest()).decode(),
    }


def listing(s3, bucket, prefixes):
    found = {}
    for prefix in prefixes:
        for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=prefix):
            for item in page.get('Contents', []):
                found[item['Key']] = {'etag': item['ETag'].strip('"'), 'size': item['Size']}
    return found


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


def verify_inventory(expected, actual):
    for key, metadata in expected.items():
        if actual.get(key) != metadata:
            raise ValueError(f'Incomplete or changed cloud release: {key}')


def app_origin(config):
    return next(item for item in config['Origins']['Items'] if item['Id'] == 'AppOrigin')


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


def deploy(s3, cf, bucket, distribution, folder):
    release, versions, files = prepare(folder)
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['preflight', 'deploy', 'activate', 'status'])
    parser.add_argument('--dist', default='dist')
    parser.add_argument('--bucket')
    parser.add_argument('--distribution')
    parser.add_argument('--release')
    parser.add_argument('--profile')
    parser.add_argument('--region', default='us-east-1')
    args = parser.parse_args()
    if args.command == 'preflight':
        release, versions, files = prepare(args.dist)
        print(json.dumps({'release': release, 'datasets': versions, 'files': len(files),
                          'sourceBytes': sum(p.stat().st_size for p, _, _ in files)}, indent=2))
        return
    if not args.distribution or (args.command != 'status' and not args.bucket):
        parser.error('--distribution and --bucket are required for deploy/activate; --distribution for status')
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
    elif args.command == 'activate':
        activate(s3, cf, args.bucket, args.distribution, args.release)
    else:
        deploy(s3, cf, args.bucket, args.distribution, args.dist)


if __name__ == '__main__':
    main()
