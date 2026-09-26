import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import import_opentree
from import_opentree import parse_newick


class ImportTests(unittest.TestCase):
    def test_names_quotes_and_non_ott_names_are_retained(self):
        nodes = parse_newick("(Homo_sapiens_ott770315,'Quoted taxon ott42',Bare_label)Root_ott1;")
        self.assertEqual([n['scientificName'] for n in nodes], ['Root', 'Homo sapiens', 'Quoted taxon', 'Bare label'])
        self.assertEqual(nodes[2]['sourceLabel'], 'Quoted taxon ott42')
        self.assertFalse(nodes[3]['isSyntheticNode'])
        self.assertEqual(nodes[3]['parentId'], 'ott1')

    def test_structural_nodes_preserve_source_ids_and_edges(self):
        nodes = parse_newick('((A_ott2,B_ott3)mrcaott2ott3,(C_ott4,D_ott5))Root_ott1;')
        self.assertEqual(nodes[1]['id'], 'mrcaott2ott3')
        self.assertTrue(nodes[1]['isSyntheticNode'])
        self.assertEqual(nodes[2]['parentId'], 'mrcaott2ott3')
        self.assertTrue(nodes[4]['isSyntheticNode'])
        self.assertEqual(nodes[4]['sourceLabel'], '')
        self.assertEqual(nodes[5]['parentId'], nodes[4]['id'])

    def test_deep_source_does_not_use_recursive_traversal(self):
        nodes = parse_newick('(' * 1500 + 'Tip_ott2' + ')' * 1500 + 'Root_ott1;')
        self.assertEqual(len(nodes), 1501)
        self.assertEqual(nodes[-1]['depth'], 1500)

    def test_duplicate_identifiers_fail(self):
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            parse_newick('(A_ott2,B_ott2)Root_ott1;')

    def test_offline_audit_detects_corruption_without_repairing_it(self):
        def response(endpoint, payload):
            if endpoint.endswith('about'):
                return dict(synth_id='test1', date_created='2026-01-01', taxonomy_version='test')
            if endpoint.endswith('subtree'):
                return dict(newick='(Tip_ott2)Root_ott1;')
            if payload.get('include_lineage'):
                return dict(synth_id='test1', taxon=dict(name='Tip'), lineage=[dict(node_id='ott1')])
            return dict(synth_id='test1', num_tips=1, taxon=dict(name='Root'))

        with TemporaryDirectory() as directory, patch.object(import_opentree, 'ROOT', Path(directory)), \
                patch.object(import_opentree, 'post', side_effect=response), redirect_stdout(StringIO()):
            import_opentree.run('audit', 1)
            import_opentree.run('audit', 1, offline=True)
            node_file = Path(directory) / 'data/processed/opentree/audit/nodes.json'
            original = node_file.read_bytes()
            corrupt = original.replace(b'Tip', b'Wrong')
            node_file.write_bytes(corrupt)
            with self.assertRaisesRegex(AssertionError, 'Processed nodes differ'):
                import_opentree.run('audit', 1, offline=True)
            self.assertEqual(node_file.read_bytes(), corrupt)
            node_file.write_bytes(original)
            newick = Path(directory) / 'data/raw/opentree/audit/test1/tree.newick'
            newick.write_text('(Wrong_ott2)Root_ott1;', encoding='utf-8')
            with self.assertRaisesRegex(AssertionError, 'Archived Newick mismatch'):
                import_opentree.run('audit', 1, offline=True)


if __name__ == '__main__':
    unittest.main()
