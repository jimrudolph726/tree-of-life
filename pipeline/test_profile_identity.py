"""Independent identity checks for the published scientific profiles."""

from array import array
import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
PROFILE_ROOT = ROOT / 'public/data/profiles'


class ProfileIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((PROFILE_ROOT / 'manifest.json').read_text(encoding='utf-8'))
        version_root = PROFILE_ROOT / cls.manifest['version']
        cls.profiles = {}
        for shard in range(cls.manifest['shardCount']):
            path = version_root / 'shards' / f'{shard:02d}.json'
            for profile in json.loads(path.read_text(encoding='utf-8'))['profiles']:
                cls.profiles[profile['ottId']] = profile
        cls.crosswalk = json.loads((version_root / cls.manifest['crosswalkFile']).read_text(encoding='utf-8'))

    def test_every_profile_identity_matches_the_pinned_opentree_release(self):
        provenance = json.loads(
            (ROOT / 'data/processed/opentree/life/provenance.json').read_text(encoding='utf-8')
        )
        source_root = ROOT / provenance['snapshotPath']
        offsets = array('I')
        offsets_path = source_root / 'labels.u32'
        with offsets_path.open('rb') as stream:
            offsets.fromfile(stream, offsets_path.stat().st_size // offsets.itemsize)
        labels = (source_root / 'labels.utf8').read_bytes()

        unmatched = {ott_id: profile['scientificName'] for ott_id, profile in self.profiles.items()}
        for offset, length in zip(offsets[::2], offsets[1::2]):
            label = labels[offset:offset + length].decode('utf-8')
            match = re.fullmatch(r'(.+)_ott(\d+)', label)
            if not match:
                continue
            ott_id = int(match.group(2))
            expected = unmatched.get(ott_id)
            if expected is not None:
                self.assertEqual(match.group(1).replace('_', ' '), expected, f'ott{ott_id}')
                del unmatched[ott_id]
                if not unmatched:
                    break

        self.assertEqual(unmatched, {}, 'Published profile IDs must exist in the pinned OpenTree labels')

    def test_crosswalk_identifiers_match_the_published_profiles(self):
        self.assertEqual(
            self.crosswalk['fields'],
            ['ottId', 'gbifUsageKey', 'wikidataItemId', 'wikipediaTitle'],
        )
        rows = self.crosswalk['records']
        self.assertEqual(len(rows), len(self.profiles))
        self.assertEqual(len({row[0] for row in rows}), len(rows))

        for ott_id, gbif_key, wikidata_id, wikipedia_title in rows:
            profile = self.profiles[ott_id]
            self.assertEqual(gbif_key, profile.get('gbif', {}).get('usageKey'))
            expected_wikidata_id = (
                profile.get('wikipedia', {}).get('wikidataId')
                or profile.get('wikidata', {}).get('itemId')
            )
            self.assertEqual(wikidata_id, expected_wikidata_id)
            expected_title = (
                profile.get('wikipedia', {}).get('title')
                or profile.get('wikidata', {}).get('articleTitle')
            )
            self.assertEqual(wikipedia_title, expected_title)

        coverage = self.manifest['identityCoverage']
        self.assertEqual(coverage['openTree'], len(self.profiles))
        self.assertEqual(coverage['gbifIdentifierCollisions'], 0)


if __name__ == '__main__':
    unittest.main()
