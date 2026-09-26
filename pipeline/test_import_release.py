import unittest
from io import StringIO
from Bio import Phylo
from import_release import parse, source_id


class ReleaseParserTests(unittest.TestCase):
    def test_topology_and_quoted_names_match_biopython(self):
        text = "(('A quoted, taxon ott2':0.2,B_ott3)mrcaott2ott3,('O''Brien ott4')Group_ott5)Root_ott1;"
        records = sorted(parse(text))
        tree = Phylo.read(StringIO(text), 'newick')
        reference, pending = [], [(tree.root, -1, 0)]
        while pending:
            clade, parent, depth = pending.pop()
            index = len(reference)
            reference.append((index, parent, clade.name, depth, not clade.clades))
            pending.extend((child, index, depth + 1) for child in reversed(clade.clades))
        self.assertEqual(records, reference)
        self.assertEqual(source_id(records[2][2]), 'ott2')

    def test_deep_tree_uses_an_explicit_stack(self):
        text = '(' * 2000 + 'Leaf_ott2' + ')mrcaott2ott3' * 1999 + ')Root_ott1;'
        records = list(parse(text))
        self.assertEqual(len(records), 2001)
        self.assertEqual(records[0][3], 2000)

    def test_malformed_trees_are_rejected(self):
        for text in ['(A,B)', '(A,,B)Root;', '(A,B;', '(A,B);', 'A;B;', '(A,B))Root;']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                list(parse(text))


if __name__ == '__main__':
    unittest.main()
