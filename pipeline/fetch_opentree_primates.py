from pathlib import Path
import json

import requests


API_URL = "https://api.opentreeoflife.org/v3/tree_of_life/subtree"

# Open Tree Taxonomy ID for Primates
PRIMATES_OTT_ID = 913935


ROOT_DIR = Path(__file__).resolve().parents[1]

OUTPUT_DIR = (
    ROOT_DIR
    / "data"
    / "raw"
    / "opentree"
)

OUTPUT_DIR.mkdir(
    parents=True,
    exist_ok=True,
)


payload = {
    "ott_id": PRIMATES_OTT_ID,
    "format": "newick",
    "label_format": "name_and_id",
}


print("Requesting Primates subtree from Open Tree of Life...")


response = requests.post(
    API_URL,
    json=payload,
    timeout=60,
)

response.raise_for_status()

data = response.json()


json_path = OUTPUT_DIR / "primates.json"

with json_path.open(
    "w",
    encoding="utf-8",
) as file:
    json.dump(
        data,
        file,
        indent=2,
    )


newick = data.get("newick")

if not newick:
    raise RuntimeError(
        "OpenTree response did not contain a Newick tree."
    )


newick_path = (
    OUTPUT_DIR
    / "primates.newick"
)

newick_path.write_text(
    newick,
    encoding="utf-8",
)


print()
print("Success!")
print(f"JSON:   {json_path}")
print(f"Newick: {newick_path}")
print()
print(
    f"Newick length: {len(newick):,} characters"
)