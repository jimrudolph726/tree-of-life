import gzip
import io
import json
from pathlib import Path
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
        for dataset in cloud.DATASETS:
            value = json.dumps({'version': '0123456789abcdef', 'pageCount': 1})
            self.write(f'data/{dataset}/manifest.json', value)
            self.write(f'data/{dataset}/0123456789abcdef/manifest.json', value)
            self.write(f'data/{dataset}/0123456789abcdef/pages/0.bin', 'geometry')
            self.write(f'data/{dataset}/0123456789abcdef/search.json', '[]')
            if dataset == 'life':
                self.write(f'data/{dataset}/0123456789abcdef/overview.json', '{}')
                self.write(f'data/{dataset}/0123456789abcdef/search-top.json', '[]')

    def test_preflight_excludes_unrelated_files_and_old_versions(self):
        self.fixture()
        self.write('.env', 'SECRET')
        self.write('data/life/aaaaaaaaaaaaaaaa/old.json', '{}')
        release, _, files = cloud.prepare(self.root)
        keys = [key for _, key, _ in files]
        self.assertIn(f'releases/{release}/data/life/manifest.json', keys)
        self.assertIn('assets/app-123.js', keys)
        self.assertFalse(any('.env' in key or 'aaaaaaaaaaaaaaaa' in key for key in keys))
        self.assertEqual(cloud.prepare(self.root)[0], release)
        self.write('index.html', 'changed app')
        self.assertNotEqual(cloud.prepare(self.root)[0], release)

    def test_incomplete_local_publication_fails(self):
        self.fixture()
        (self.root / 'data/life/0123456789abcdef/pages/0.bin').unlink()
        with self.assertRaisesRegex(ValueError, 'missing geometry'):
            cloud.prepare(self.root)

    def test_compression_and_cache_headers(self):
        file = self.write('page.bin', 'geometry bytes')
        body, headers = cloud.encode(file, 'data/life/version/pages/0.bin')
        self.assertEqual(gzip.decompress(body), file.read_bytes())
        self.assertEqual(headers['ContentType'], 'application/octet-stream')
        self.assertIn('immutable', headers['CacheControl'])
        self.assertEqual(cloud.encode(file, 'releases/id/manifest.json')[1]['CacheControl'], cloud.FRESH)

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
