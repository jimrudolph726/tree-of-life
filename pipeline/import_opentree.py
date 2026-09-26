"""Fetch a version-checked OpenTree subtree and preserve its scientific provenance.

Default: Aves. Network access is used only by this explicit import command.
Existing immutable snapshots can be processed and audited offline with --offline.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
from io import StringIO
import json
from pathlib import Path
import re

from Bio import Phylo
import requests

ROOT = Path(__file__).resolve().parents[1]
API = "https://api.opentreeoflife.org/v3/"
OTT = re.compile(r"^(.*)[_ ]ott(\d+)$")
STRUCTURAL = re.compile(r"^mrcaott\d+ott\d+$")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def parse_newick(text):
    tree = Phylo.read(StringIO(text), "newick")
    nodes, by_object = [], {}
    pending = [(tree.root, None, 0)]
    while pending:
        clade, parent, depth = pending.pop()
        label = clade.name or ""
        match = OTT.fullmatch(label)
        if match:
            name, ott_id = match.group(1).replace("_", " "), int(match.group(2))
            node_id, structural = f"ott{ott_id}", False
        elif STRUCTURAL.fullmatch(label):
            name, ott_id, node_id, structural = "Unnamed clade", None, label, True
        else:
            name, ott_id = label.replace("_", " ") or "Unnamed clade", None
            node_id, structural = f"unlabelled-{len(nodes)}", not bool(label)
        node = dict(id=node_id, parentId=parent, scientificName=name, ottId=ott_id,
                    sourceLabel=label, depth=depth, isTerminal=not clade.clades, isSyntheticNode=structural)
        nodes.append(node)
        by_object[id(clade)] = node
        pending.extend((ch, node_id, depth + 1) for ch in reversed(clade.clades))
    ids = {n["id"] for n in nodes}
    if len(ids) != len(nodes):
        raise ValueError("Duplicate source identifiers")
    # Independently compare every parsed source edge and label to the export.
    stack, edge_count = [tree.root], 0
    while stack:
        clade = stack.pop()
        node = by_object[id(clade)]
        assert node["sourceLabel"] == (clade.name or "")
        assert node["isTerminal"] == (len(clade.clades) == 0)
        for child in clade.clades:
            assert by_object[id(child)]["parentId"] == node["id"]
            edge_count += 1
        stack.extend(clade.clades)
    assert edge_count == len(nodes) - 1
    return nodes


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")


def post(endpoint, payload):
    response = requests.post(API + endpoint, json=payload, timeout=(15, 180))
    response.raise_for_status()
    return response.json()


def run(slug="aves", ott_id=81461, offline=False):
    if not re.fullmatch(r"[a-z][a-z0-9-]*", slug):
        raise ValueError("Invalid dataset slug")
    output = ROOT / "data/processed/opentree" / slug
    pointer = output / "provenance.json"
    if offline:
        metadata = json.loads(pointer.read_text(encoding="utf-8"))
        snapshot = ROOT / metadata["snapshotPath"]
        before = json.loads((snapshot / "about.json").read_text(encoding="utf-8"))
        info = json.loads((snapshot / "root-info.json").read_text(encoding="utf-8"))
        response = json.loads((snapshot / "subtree.json").read_text(encoding="utf-8"))
    else:
        before = post("tree_of_life/about", {})
        info = post("tree_of_life/node_info", {"ott_id": ott_id})
        if info["num_tips"] > 25000:
            raise ValueError("Subtree exceeds the documented API limit; use a release download instead")
        response = post("tree_of_life/subtree", {"ott_id": ott_id, "format": "newick", "label_format": "name_and_id"})
        after = post("tree_of_life/about", {})
        if before["synth_id"] != after["synth_id"] or info.get("synth_id") != before["synth_id"]:
            raise ValueError("Synthesis changed during download; retry the import")
        snapshot = ROOT / "data/raw/opentree" / slug / before["synth_id"]
        snapshot.mkdir(parents=True, exist_ok=True)
        for filename, value in [("about.json", before), ("root-info.json", info), ("subtree.json", response)]:
            path = snapshot / filename
            if path.exists() and json.loads(path.read_text(encoding="utf-8")) != value:
                raise ValueError(f"Refusing to overwrite changed immutable snapshot: {path}")
            write_json(path, value)
        (snapshot / "tree.newick").write_text(response["newick"], encoding="utf-8", newline="\n")
    text = response["newick"]
    assert info["synth_id"] == before["synth_id"], "Source synthesis mismatch"
    assert (snapshot / "tree.newick").read_bytes() == text.encode(), "Archived Newick mismatch"
    nodes = parse_newick(text)
    assert nodes[0]["id"] == f"ott{ott_id}"
    assert nodes[0]["scientificName"] == info["taxon"]["name"]
    tips = sum(n["isTerminal"] for n in nodes)
    assert tips == info["num_tips"], "Source tip count mismatch"
    index = {n["id"]: n for n in nodes}
    named_tips = [n for n in nodes if n["isTerminal"] and n["ottId"]]
    samples = [max(named_tips, key=lambda n: n["depth"]), named_tips[0], named_tips[len(named_tips)//2]]
    samples = list({n["id"]: n for n in samples}.values())
    lineage_checks = []
    for sample in samples:
        path = snapshot / f"lineage-{sample['id']}.json"
        if offline:
            remote = json.loads(path.read_text(encoding="utf-8"))
        else:
            remote = post("tree_of_life/node_info", {"ott_id": sample["ottId"], "include_lineage": True})
            write_json(path, remote)
        assert remote["synth_id"] == before["synth_id"], "Lineage synthesis mismatch"
        expected = []
        for ancestor in remote["lineage"]:
            expected.append(ancestor["node_id"])
            if ancestor["node_id"] == nodes[0]["id"]:
                break
        actual, parent = [], sample["parentId"]
        while parent:
            actual.append(parent)
            parent = index[parent]["parentId"]
        # name_and_id omits identifiers on unnamed branching points. Compare
        # every named ancestor AND the position/count of unnamed ancestors;
        # local anonymous IDs are deliberately never claimed as OpenTree IDs.
        assert len(actual) == len(expected), f"Source ancestry depth mismatch: {sample['id']}"
        for local, source in zip(actual, expected):
            assert local == source or (index[local]["isSyntheticNode"] and not index[local]["sourceLabel"]
                                       and STRUCTURAL.fullmatch(source)), f"Source ancestry mismatch: {sample['id']}"
        assert sample["scientificName"] == remote["taxon"]["name"]
        lineage_checks.append(dict(id=sample["id"], name=sample["scientificName"], depth=sample["depth"],
                                   namedAncestorsAndStructuralPositionsMatched=True))
    output.mkdir(parents=True, exist_ok=True)
    node_file = output / "nodes.json"
    if offline:
        expected_bytes = json.dumps(nodes, ensure_ascii=False, indent=2).encode("utf-8")
        assert node_file.read_bytes() == expected_bytes, "Processed nodes differ from the archived source"
    else:
        write_json(node_file, nodes)
    counts = Counter(n["parentId"] for n in nodes if n["parentId"])
    provenance = dict(provider="Open Tree of Life", sourceUrl=API + "tree_of_life/subtree",
                      synthId=before["synth_id"], taxonomyVersion=before.get("taxonomy_version", before.get("taxonomy")),
                      synthesisCreated=before["date_created"], rootOttId=ott_id, title=info["taxon"]["name"],
                      fetchedAt=metadata["fetchedAt"] if offline else datetime.now(timezone.utc).isoformat(),
                      snapshotPath=snapshot.relative_to(ROOT).as_posix(), newickSha256=digest(text.encode()),
                      nodesSha256=digest(node_file.read_bytes()), supportingStudies=response.get("supporting_studies", []))
    if offline:
        assert provenance == metadata, "Snapshot or processed data changed"
    else:
        write_json(pointer, provenance)
    report = dict(dataset=slug, source=provenance, nodeCount=len(nodes), edgeCount=len(nodes)-1,
                  tipCount=tips, namedCount=sum(not n["isSyntheticNode"] for n in nodes),
                  maxDepth=max(n["depth"] for n in nodes), maxChildren=max(counts.values(), default=0),
                  allSourceEdgesAndLabelsMatched=True, sourceTipCountMatched=True, apiLineageChecks=lineage_checks)
    write_json(ROOT / "benchmarks/results" / f"{slug}-source-validation.json", report)
    print(json.dumps({k:v for k,v in report.items() if k != "source"}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slug", default="aves")
    parser.add_argument("--ott-id", type=int, default=81461)
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    run(args.slug, args.ott_id, args.offline)
