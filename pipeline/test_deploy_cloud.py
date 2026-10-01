import gzip
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import deploy_cloud as cloud


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write(self, path, value):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(value, encoding='utf-8')
        return file

    def fixture(self):
        self.write('index.html', '<script src="/assets/app-123.js"></script>')
        self.write('assets/app-123.js', 'console.log("app")')
        self.profile_fixture()
        for dataset in cloud.DATASETS:
            value = json.dumps({'version': '0123456789abcdef', 'pageCount': 1})
            self.write(f'data/{dataset}/manifest.json', value)
            self.write(f'data/{dataset}/0123456789abcdef/manifest.json', value)
            self.write(f'data/{dataset}/0123456789abcdef/pages/0.bin', 'geometry')
            self.write(f'data/{dataset}/0123456789abcdef/search.json', '[]')
            if dataset == 'life':
                self.write(f'data/{dataset}/0123456789abcdef/overview.json', '{}')
                self.write(f'data/{dataset}/0123456789abcdef/search-top.json', '[]')

    def profile_fixture(self):
        value = json.dumps({'format': 3, 'version': 'fedcba9876543210', 'profileCount': 50000,
                            'shardCount': 2, 'maxCompressedShardBytes': 100,
                            'searchFile': 'search.json', 'compressedSearchBytes': 100,
                            'crosswalkFile': 'crosswalk.json', 'crosswalkCount': 50000,
                            'compressedCrosswalkBytes': 100})
        self.write('data/profiles/manifest.json', value)
        self.write('data/profiles/fedcba9876543210/manifest.json', value)
        self.write('data/profiles/fedcba9876543210/shards/00.json', '{"profiles":[]}')
        self.write('data/profiles/fedcba9876543210/shards/01.json', '{"profiles":[]}')
        self.write('data/profiles/fedcba9876543210/search.json', '{"profiles":[]}')
        self.write('data/profiles/fedcba9876543210/crosswalk.json', '{"records":[]}')
        self.journey_fixture()

    def journey_fixture(self):
        value = json.dumps({'format': 1, 'version': 'abcdef0123456789', 'journeyCount': 3,
                            'catalogFile': 'catalog.json', 'journeyPattern': '{id}.json',
                            'maxCompressedJourneyBytes': 100, 'compressedCatalogBytes': 100})
        folder = 'data/journeys/abcdef0123456789'
        catalog = {'journeys': [{'id': item} for item in ('flight', 'vision', 'walking')]}
        self.write('data/journeys/manifest.json', value)
        self.write(f'{folder}/manifest.json', value)
        self.write(f'{folder}/catalog.json', json.dumps(catalog))
        for item in ('flight', 'vision', 'walking'):
            self.write(f'{folder}/{item}.json', '{}')
        self.write('images/journeys/flight/cover.webp', 'image')

    def test_preflight_excludes_unrelated_files_and_old_versions(self):
        self.fixture()
        self.write('.env', 'SECRET')
        self.write('data/life/aaaaaaaaaaaaaaaa/old.json', '{}')
        release, _, files = cloud.prepare(self.root)
        keys = [key for _, key, _ in files]
        self.assertIn(f'releases/{release}/data/life/manifest.json', keys)
        self.assertIn('assets/app-123.js', keys)
        self.assertIn(f'releases/{release}/images/journeys/flight/cover.webp', keys)
        self.assertNotIn('images/journeys/flight/cover.webp', keys)
        self.assertFalse(any('.env' in key or 'aaaaaaaaaaaaaaaa' in key for key in keys))
        self.assertEqual(cloud.prepare(self.root)[0], release)
        self.write('index.html', 'changed app')
        self.assertNotEqual(cloud.prepare(self.root)[0], release)

    def test_incomplete_local_publication_fails(self):
        self.fixture()
        (self.root / 'data/life/0123456789abcdef/pages/0.bin').unlink()
        with self.assertRaisesRegex(ValueError, 'missing geometry'):
            cloud.prepare(self.root)

    def test_full_release_reads_immutable_datasets_from_separate_root(self):
        self.fixture()
        data_root = self.root / 'generated-data'
        for dataset in cloud.DATASETS:
            source = self.root / 'data' / dataset / '0123456789abcdef'
            destination = data_root / 'data' / dataset / '0123456789abcdef'
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(source, destination)
        release, versions, files = cloud.prepare(self.root, data_root)
        keys = [key for _, key, _ in files]
        self.assertEqual(versions, {dataset: '0123456789abcdef' for dataset in cloud.DATASETS})
        self.assertIn('data/life/0123456789abcdef/pages/0.bin', keys)
        self.assertIn(f'releases/{release}/data/life/manifest.json', keys)

    def test_app_release_reuses_remote_dataset_pointers_without_local_data(self):
        self.write('index.html', '<script src="/assets/app-123.js"></script>')
        self.write('assets/app-123.js', 'console.log("app")')
        self.profile_fixture()
        pointers = {f'data/{dataset}/manifest.json':
                    json.dumps({'version': '0123456789abcdef', 'pageCount': 1}).encode()
                    for dataset in cloud.DATASETS}
        release, versions, files, blobs = cloud.prepare_app(self.root, pointers)
        self.assertEqual(versions, {dataset: '0123456789abcdef' for dataset in cloud.DATASETS})
        self.assertIn('assets/app-123.js', [key for _, key, _ in files])
        self.assertIn('data/profiles/fedcba9876543210/shards/00.json',
                      [key for _, key, _ in files])
        self.assertIn(f'releases/{release}/images/journeys/flight/cover.webp',
                      [key for _, key, _ in files])
        self.assertEqual({key for _, key, _ in blobs},
                         {f'releases/{release}/data/{dataset}/manifest.json' for dataset in cloud.DATASETS})
        pointers['data/life/manifest.json'] = json.dumps(
            {'version': 'fedcba9876543210', 'pageCount': 1}).encode()
        self.assertNotEqual(cloud.prepare_app(self.root, pointers)[0], release)

    def test_full_and_app_only_paths_produce_the_same_release_identity(self):
        self.fixture()
        pointers = {f'data/{dataset}/manifest.json':
                    (self.root / f'data/{dataset}/manifest.json').read_bytes()
                    for dataset in cloud.DATASETS}
        self.assertEqual(cloud.prepare(self.root)[0], cloud.prepare_app(self.root, pointers)[0])

    def test_app_release_inherits_only_verified_active_dataset_objects(self):
        versions = {dataset: '0123456789abcdef' for dataset in cloud.DATASETS}
        data = {f'data/{dataset}/0123456789abcdef/manifest.json': {'etag': dataset, 'size': 1}
                for dataset in cloud.DATASETS}
        record = {'datasets': versions, 'objects': {
            **data, 'assets/old.js': {'etag': 'old', 'size': 1},
            'releases/old/index.html': {'etag': 'old', 'size': 1}}}
        self.assertEqual(cloud.inherited_data_inventory(record, versions), data)
        record['datasets'] = {**versions, 'life': 'fedcba9876543210'}
        with self.assertRaisesRegex(ValueError, 'does not match'):
            cloud.inherited_data_inventory(record, versions)

    def test_app_deploy_publishes_small_release_and_keeps_data_inventory(self):
        self.write('index.html', '<script src="/assets/app-123.js"></script>')
        self.write('assets/app-123.js', 'console.log("app")')
        self.profile_fixture()
        versions = {dataset: '0123456789abcdef' for dataset in cloud.DATASETS}
        data = {f'data/{dataset}/0123456789abcdef/manifest.json': {'etag': dataset, 'size': 1}
                for dataset in cloud.DATASETS}
        record = {'release': 'active', 'datasets': versions, 'objects': data}
        pointers = {f'releases/active/data/{dataset}/manifest.json':
                    json.dumps({'version': versions[dataset], 'pageCount': 1}).encode()
                    for dataset in cloud.DATASETS}
        s3, cf = MagicMock(), MagicMock()
        cf.get_distribution.return_value = {'Distribution': {
            'Status': 'Deployed', 'DistributionConfig': {'Origins': {'Items': [
                {'Id': 'AppOrigin', 'OriginPath': '/releases/active'}]}}}}

        def get_object(**kwargs):
            key = kwargs['Key']
            raw = json.dumps(record).encode() if key.endswith('/release.json') else pointers[key]
            return {'Body': io.BytesIO(gzip.compress(raw)), 'ContentEncoding': 'gzip'}

        s3.get_object.side_effect = get_object
        with patch.object(cloud, 'listing', return_value={}), \
                patch.object(cloud, 'verify_inventory'), patch.object(cloud, 'activate') as activate:
            cloud.deploy_app(s3, cf, 'bucket', 'distribution', self.root)
        activate.assert_called_once()
        release = activate.call_args.args[-1]
        release_put = next(call for call in s3.put_object.call_args_list
                           if call.kwargs['Key'] == f'releases/{release}/release.json')
        published = json.loads(gzip.decompress(release_put.kwargs['Body']))
        self.assertEqual(published['datasets'], versions)
        self.assertTrue(set(data).issubset(published['objects']))
        self.assertIn('assets/app-123.js', published['objects'])
        self.assertIn(f'releases/{release}/index.html', published['objects'])

    def test_compression_and_cache_headers(self):
        file = self.write('page.bin', 'geometry bytes')
        body, headers = cloud.encode(file, 'data/life/version/pages/0.bin')
        self.assertEqual(gzip.decompress(body), file.read_bytes())
        self.assertEqual(headers['ContentType'], 'application/octet-stream')
        self.assertIn('immutable', headers['CacheControl'])
        self.assertEqual(cloud.encode(file, 'releases/id/manifest.json')[1]['CacheControl'], cloud.FRESH)
        self.assertEqual(cloud.encode(file, 'releases/id/data/profiles/fedcba9876543210/shards/00.json')[1]['CacheControl'], cloud.IMMUTABLE)
        self.assertEqual(cloud.encode(file, 'releases/id/data/journeys/abcdef0123456789/vision.json')[1]['CacheControl'], cloud.IMMUTABLE)
        self.assertEqual(cloud.encode(file, 'releases/id/images/journeys/flight/cover.webp')[1]['CacheControl'], cloud.IMMUTABLE)
        blob, options = cloud.encode_bytes(b'{}', '.json', 'releases/id/data/life/manifest.json')
        self.assertEqual(gzip.decompress(blob), b'{}')
        self.assertEqual(options['CacheControl'], cloud.FRESH)

    def test_identical_upload_is_reused_and_changed_data_refused(self):
        file = self.write('page.bin', 'geometry')
        s3 = MagicMock()
        key, metadata = cloud.upload_file(s3, 'bucket', (file, 'data/page.bin', False), {})
        s3.put_object.assert_called_once()
        s3.reset_mock()
        cloud.upload_file(s3, 'bucket', (file, key, False), {key: metadata})
        s3.put_object.assert_not_called()
        file.write_text('changed', encoding='utf-8')
        s3.head_object.return_value = {'Metadata': {'sha256': 'old'}}
        with self.assertRaisesRegex(ValueError, 'Refusing to overwrite'):
            cloud.upload_file(s3, 'bucket', (file, key, False), {key: metadata})
        s3.put_object.assert_not_called()

    def test_partial_cloud_upload_never_promotes(self):
        s3, cf = MagicMock(), MagicMock()
        record = {'release': 'abc', 'objects': {'missing.bin': {'etag': 'x', 'size': 1}}}
        s3.get_object.return_value = {'Body': io.BytesIO(gzip.compress(json.dumps(record).encode()))}
        with patch.object(cloud, 'listing', return_value={}):
            with self.assertRaisesRegex(ValueError, 'Incomplete or changed'):
                cloud.activate(s3, cf, 'bucket', 'distribution', 'abc')
        cf.update_distribution.assert_not_called()

    def test_rollback_switches_only_app_origin_with_etag(self):
        s3, cf = MagicMock(), MagicMock()
        record = {'release': 'old', 'objects': {}}
        s3.get_object.return_value = {'Body': io.BytesIO(gzip.compress(json.dumps(record).encode()))}
        cf.get_distribution.return_value = {'Distribution': {'Status': 'Deployed', 'DomainName': 'example.cloudfront.net'}}
        config = {'Origins': {'Items': [
            {'Id': 'AppOrigin', 'DomainName': 'bucket.s3.amazonaws.com', 'OriginPath': '/releases/new'},
            {'Id': 'DataOrigin', 'DomainName': 'bucket.s3.amazonaws.com'}]}}
        cf.get_distribution_config.return_value = {'ETag': 'revision', 'DistributionConfig': config}
        with patch.object(cloud, 'listing', return_value={}), patch.object(cloud, 'wait_distribution'):
            cloud.activate(s3, cf, 'bucket', 'distribution', 'old')
        args = cf.update_distribution.call_args.kwargs
        self.assertEqual(args['IfMatch'], 'revision')
        self.assertEqual(cloud.app_origin(args['DistributionConfig'])['OriginPath'], '/releases/old')
        self.assertNotIn('OriginPath', args['DistributionConfig']['Origins']['Items'][1])

    def test_unsafe_release_ids_rejected(self):
        for value in ('../other', 'a/b', '', 'x' * 81):
            with self.assertRaises(ValueError):
                cloud.valid_release(value)

    def test_build_time_does_not_change_immutable_manifest(self):
        file = self.write('manifest.json', '{"builtAt":"yesterday","version":"abc"}')
        before = cloud.content(file, True)
        file.write_text('{"builtAt":"today","version":"abc"}', encoding='utf-8')
        self.assertEqual(before, cloud.content(file, True))


if __name__ == '__main__':
    unittest.main()
