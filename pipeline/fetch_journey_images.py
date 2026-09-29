"""Fetch curated, license-checked Journey media from Wikimedia Commons.

The explicit title map makes updates reviewable and reproducible. The generated
metadata is merged into authored Journey JSON by build_journeys.py.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
from html import unescape
import json
from pathlib import Path
import re
import time
from urllib.parse import quote

from PIL import Image
import requests


ROOT = Path(__file__).resolve().parents[1]
MEDIA_FILE = ROOT / 'data/content/journey-media.json'
IMAGE_ROOT = ROOT / 'public/images/journeys'
API = 'https://commons.wikimedia.org/w/api.php'
USER_AGENT = 'TreeOfLifeExplorer/0.2 journey-media-curation'

MEDIA = {
    'vision-lancelet': ('vision', 'lancelet.webp', 'File:Branchiostoma lanceolatum.jpg'),
    'vision-tunicate': ('vision', 'tunicate.webp', 'File:Ciona intestinalis (Linnaeus, 1767) .jpg'),
    'vision-hagfish': ('vision', 'hagfish.webp', 'File:Eptatretus stoutii.jpg'),
    'vision-lamprey': ('vision', 'lamprey.webp', 'File:Petromyzon marinus 187530670.jpg'),
    'vision-zebrafish': ('vision', 'zebrafish.webp', 'File:Zebrafisch.jpg'),
    'vision-frog': ('vision', 'frog.webp', 'File:Xenopus laevis 02.jpg'),
    'vision-mouse': ('vision', 'mouse.webp', 'File:House mouse (Mus musculus) 2808.jpg'),
    'vision-human': ('vision', 'human-eye.webp', 'File:Eye iris.jpg'),
    'bipedalism-chimpanzee': ('bipedalism', 'chimpanzee.webp',
                              'File:016 Alpha male chimpanzee walking at Kibale forest National Park Photo by Giles Laurent.jpg'),
    'bipedalism-sahelanthropus': ('bipedalism', 'sahelanthropus.webp',
                                  'File:Sahelanthropus tchadensis - TM 266-01-060-1.jpg'),
    'bipedalism-ardipithecus': ('bipedalism', 'ardipithecus.webp', 'File:Ardi.jpg'),
    'bipedalism-afarensis': ('bipedalism', 'afarensis.webp', 'File:Australopithecus afarensis, "Lucy".jpg'),
    'bipedalism-habilis': ('bipedalism', 'habilis.webp', 'File:Homo Habilis-MGL 95213-P5030045-black.jpg'),
    'bipedalism-erectus': ('bipedalism', 'erectus.webp', 'File:Turkana Boy.jpg'),
    'bipedalism-neanderthal': ('bipedalism', 'neanderthal.webp', 'File:La Ferrassie 1 MdlH 1 2018-10-20.jpg'),
    'bipedalism-human': ('bipedalism', 'human-walking.webp', 'File:People walking on the street in Nairobi, Kenya.jpg'),
}

GBIF_MEDIA = {
    'vision-lamprey': ('https://inaturalist-open-data.s3.amazonaws.com/photos/645127470/original.jpg',
                       'Michelle Campbell', 'CC0', 6236548312),
    'vision-lancelet': ('https://inaturalist-open-data.s3.amazonaws.com/photos/630426340/original.jpg',
                        'Adi Peter', 'CC BY 4.0', 6452655365),
    'vision-mouse': ('https://inaturalist-open-data.s3.amazonaws.com/photos/605667472/original.jpg',
                     'mbyhower', 'CC BY 4.0', 5938469279),
    'vision-tunicate': ('https://inaturalist-open-data.s3.amazonaws.com/photos/604551440/original.jpg',
                        'Blake Ross', 'CC BY 4.0', 5938054000),
    'vision-zebrafish': ('https://inaturalist-open-data.s3.amazonaws.com/photos/705130967/original.jpg',
                         'Rainer Breitling', 'CC BY 4.0', 6470087815),
}


def plain(value: str) -> str:
    return re.sub(r'\s+', ' ', unescape(re.sub(r'<[^>]+>', '', value or ''))).strip()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def get(url: str, **kwargs) -> requests.Response:
    for attempt in range(7):
        response = requests.get(url, headers={'User-Agent': USER_AGENT}, timeout=90, **kwargs)
        if response.status_code != 429 and response.status_code < 500:
            response.raise_for_status()
            return response
        retry = response.headers.get('Retry-After')
        time.sleep(float(retry) if retry and retry.isdigit() else min(30, 2 ** attempt))
    response.raise_for_status()
    return response


def commons_info(title: str) -> dict:
    response = get(API, params={
        'action': 'query', 'format': 'json', 'formatversion': 2, 'titles': title,
        'prop': 'imageinfo', 'iiprop': 'url|extmetadata', 'iiurlwidth': 1400,
    })
    pages = response.json().get('query', {}).get('pages', [])
    if not pages or pages[0].get('missing') or not pages[0].get('imageinfo'):
        raise ValueError(f'Commons file was not found: {title}')
    return pages[0]['imageinfo'][0]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--only', action='append', choices=sorted(MEDIA), help='Fetch only this media ID')
    args = parser.parse_args()
    existing = json.loads(MEDIA_FILE.read_text(encoding='utf-8')) if MEDIA_FILE.exists() else {'format': 1, 'media': {}}
    selected = args.only or sorted(MEDIA)
    for media_id in selected:
        group, filename, title = MEDIA[media_id]
        if media_id in GBIF_MEDIA:
            source, credit, license_name, occurrence = GBIF_MEDIA[media_id]
            source_url = f'https://www.gbif.org/occurrence/{occurrence}'
            source_fields = {'gbifOccurrence': occurrence}
            source_label = f'GBIF occurrence {occurrence}'
        else:
            info = commons_info(title)
            metadata = info.get('extmetadata', {})
            license_name = plain(metadata.get('LicenseShortName', {}).get('value', ''))
            if not (license_name.startswith('CC ') or license_name == 'CC0' or 'public domain' in license_name.casefold()):
                raise ValueError(f'{title} has an unsupported license: {license_name}')
            source = info.get('thumburl') or info['url']
            credit = plain(metadata.get('Artist', {}).get('value', 'Unknown contributor'))
            source_url = f'https://commons.wikimedia.org/wiki/{quote(title.replace(" ", "_"), safe=":()_,.-")}'
            source_fields = {'commonsTitle': title}
            source_label = title
        response = get(source)
        destination = IMAGE_ROOT / group / filename
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix('.download')
        temporary.write_bytes(response.content)
        with Image.open(temporary) as image:
            image.thumbnail((1400, 900), Image.Resampling.LANCZOS)
            if image.mode not in ('RGB', 'RGBA'):
                image = image.convert('RGB')
            image.save(destination, 'WEBP', quality=82, method=6)
        temporary.unlink()
        existing['media'][media_id] = {
            'src': destination.relative_to(ROOT / 'public').as_posix(),
            'credit': credit,
            'license': license_name,
            'sourceUrl': source_url,
            **source_fields,
            'sha256': sha256(destination),
            'retrievedAt': datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        }
        MEDIA_FILE.parent.mkdir(parents=True, exist_ok=True)
        MEDIA_FILE.write_text(json.dumps(existing, ensure_ascii=False, sort_keys=True, indent=2) + '\n', encoding='utf-8')
        print(f'{media_id}: {source_label} ({license_name})')
        time.sleep(0.6)


if __name__ == '__main__':
    main()
