"""Import the complete, pinned OpenTree release without building millions of Python objects.

Both official Newick representations are parsed independently and compared node for
node. The output is a compact parent array and indexed UTF-8 source-label table.
Large downloaded/generated files stay in ignored .opentree/, not Git history.
"""
import argparse
from array import array
from datetime import datetime, timezone
import hashlib
from itertools import zip_longest
import json
from pathlib import Path
import re
import shutil
import sys
import tarfile
import requests

ROOT = Path(__file__).resolve().parents[1]
RELEASE = 'opentree16.1'
BASE = f'https://files.opentreeoflife.org/synthesis/{RELEASE}'
TOKEN = re.compile(r"\s+|\[[^\]]*\]|'(?:[^']|'')*'|[(),;:]|[^\s(),;:\[\]']+")
OTT = re.compile(r'^(.*)[_ ]ott(\d+)$')


def sha(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def source_id(label):
    match = OTT.fullmatch(label)
    return f'ott{match[2]}' if match else label


def parse(text):
    """Yield (preorder index, parent index, label, depth, terminal) iteratively.

    Internal records arrive after their children. Branch lengths are accepted but
    not used as layout distances. Reject missing labels or malformed topology.
    """
    stack, index, current, expect_node, skip_length, ended = [], 0, None, True, False, False
    end = 0
    for match in TOKEN.finditer(text):
        if match.start() != end:
            raise ValueError('Invalid Newick token')
        end = match.end()
        token = match[0]
        if token.isspace() or token.startswith('['):
            continue
        if ended:
            raise ValueError('Multiple trees or trailing tokens')
        if skip_length:
            float(token); skip_length = False; continue
        if token == '(':
            if not expect_node:
                raise ValueError('Unexpected opening parenthesis')
            stack.append((index, stack[-1][0] if stack else -1, len(stack), False))
            index += 1
        elif token == ')':
            if expect_node or current is not None or not stack:
                raise ValueError('Unbalanced or unlabelled internal node')
            current = stack.pop(); expect_node = False
        elif token == ',':
            if expect_node or current is not None or not stack:
                raise ValueError('Unexpected comma')
            expect_node = True
        elif token == ':':
            if expect_node or current is not None:
                raise ValueError('Branch length before label')
            skip_length = True
        elif token == ';':
            if expect_node or current is not None or stack:
                raise ValueError('Incomplete Newick tree')
            ended = True
        else:
            if expect_node:
                current = (index, stack[-1][0] if stack else -1, len(stack), True)
                index += 1
            elif current is None:
                raise ValueError('Duplicate Newick label')
            label = token[1:-1].replace("''", "'") if token.startswith("'") else token
            if not label:
                raise ValueError('Missing source identifier')
            i, parent, depth, terminal = current
            yield i, parent, label, depth, terminal
            current = None; expect_node = False
    if end != len(text) or not ended or skip_length:
        raise ValueError('Unterminated Newick tree')


def download(url, path):
    if path.exists():
        return
    partial = path.with_suffix(path.suffix + '.partial')
    with requests.get(url, stream=True, timeout=(20, 180)) as response:
        response.raise_for_status()
        with partial.open('wb') as f:
            for chunk in response.iter_content(1024 * 1024):
                f.write(chunk)
    partial.replace(path)


def run(offline=False):
    folder = ROOT / '.opentree' / RELEASE
    folder.mkdir(parents=True, exist_ok=True)
    archive = folder / f'{RELEASE}_tree.tgz'
    if not offline:
        download(f'{BASE}/{archive.name}', archive)
        for filename, remote in [('config.json', 'config.json'), ('input_output_stats.json', 'labelled_supertree/input_output_stats.json')]:
            download(f'{BASE}/output/{remote}', folder / filename)
    # Read only the two expected archive members; never extract arbitrary paths.
    with tarfile.open(archive) as tar:
        for name in ['labelled_supertree.tre', 'labelled_supertree_ottnames.tre']:
            destination = folder / name
            if not destination.exists():
                with tar.extractfile(f'{RELEASE}_tree/labelled_supertree/{name}') as source, destination.open('wb') as output:
                    shutil.copyfileobj(source, output)
    config = json.loads((folder / 'config.json').read_text())
    assert config['synth_id'] == RELEASE and config['root_ott_id'] == '93302'
    ids_file, names_file = folder / 'labelled_supertree.tre', folder / 'labelled_supertree_ottnames.tre'
    parents, offsets = array('i'), array('I')
    ids, counts, landmarks = set(), dict(nodes=0, tips=0, named=0, maxDepth=0), {}
    wanted = {'Eukaryota', 'Archaea', 'Bacteria', 'Fungi', 'Opisthokonta', 'Viridiplantae', 'Metazoa',
              'Euryarchaeota', 'Crenarchaeota', 'Proteobacteria', 'Firmicutes', 'Actinobacteria', 'Cyanobacteria',
              'Methanobacteriati', 'Thermoproteati', 'Bacillati', 'Pseudomonadati', 'Homo sapiens', 'Aves'}
    pointer = ROOT / 'data/processed/opentree/life/provenance.json'
    previous = json.loads(pointer.read_text()) if pointer.exists() else None
    source_hashes = {p.name: sha(p) for p in [archive, ids_file, names_file, folder / 'config.json', folder / 'input_output_stats.json']}
    if previous and previous['synthId'] == RELEASE:
        assert previous['sourceHashes'] == source_hashes, 'Pinned release content changed'
    labels_path = folder / 'labels.utf8'
    with labels_path.with_suffix('.next').open('wb') as labels:
        for left, right in zip_longest(parse(ids_file.read_text(encoding='utf-8')), parse(names_file.read_text(encoding='utf-8'))):
            if left is None or right is None:
                raise ValueError('Release representations differ in node count')
            i, parent, node_id, depth, terminal = left
            j, other_parent, label, other_depth, other_terminal = right
            if (i, parent, depth, terminal) != (j, other_parent, other_depth, other_terminal) or source_id(label) != node_id:
                raise ValueError(f'Release name/topology mismatch at {i}')
            if node_id in ids:
                raise ValueError(f'Duplicate source identifier {node_id}')
            ids.add(node_id)
            while len(parents) <= i:
                parents.append(-1); offsets.extend((0, 0))
            parents[i] = parent
            raw = label.encode('utf-8'); offsets[i*2] = labels.tell(); offsets[i*2+1] = len(raw); labels.write(raw)
            counts['nodes'] += 1; counts['tips'] += terminal
            counts['named'] += node_id.startswith('ott'); counts['maxDepth'] = max(counts['maxDepth'], depth)
            name_match = OTT.fullmatch(label)
            name = name_match[1].replace('_', ' ') if name_match else ''
            if name in wanted:
                landmarks[name] = dict(index=i, id=node_id, depth=depth)
            if i == 0:
                assert node_id == 'ott93302'
            if counts['nodes'] % 500000 == 0:
                print(f"Validated {counts['nodes']:,} source nodes", flush=True)
    expected_tips = json.loads((folder / 'input_output_stats.json').read_text())['input']['num_taxonomy_leaves']
    assert counts['tips'] == expected_tips and counts['nodes'] == len(parents)
    labels_path.with_suffix('.next').replace(labels_path)
    if sys.byteorder != 'little':
        parents.byteswap(); offsets.byteswap()
    for filename, value in [('parents.i32', parents), ('labels.u32', offsets)]:
        with (folder / filename).open('wb') as f:
            value.tofile(f)
    artifact_hashes = {name: sha(folder / name) for name in ['parents.i32', 'labels.u32', 'labels.utf8']}
    provenance = dict(provider='Open Tree of Life', sourceUrl=f'{BASE}/{archive.name}', synthId=RELEASE,
        taxonomyVersion='3.7draft3', synthesisCreated='2025-12-20 01:09:33', rootOttId=93302,
        title='Tree of Life', fetchedAt=previous['fetchedAt'] if previous else datetime.now(timezone.utc).isoformat(),
        snapshotPath=folder.relative_to(ROOT).as_posix(), newickSha256=source_hashes[names_file.name],
        nodesSha256=artifact_hashes['parents.i32'], supportingStudies=[], sourceHashes=source_hashes,
        artifactHashes=artifact_hashes, counts=counts, landmarks=landmarks,
        validation='Every source ID, label and parent edge matched between both official Newick representations; source tip count matched.')
    pointer.parent.mkdir(parents=True, exist_ok=True)
    pointer.write_text(json.dumps(provenance, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps(dict(counts=counts, landmarks=landmarks), indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true')
    run(parser.parse_args().offline)
