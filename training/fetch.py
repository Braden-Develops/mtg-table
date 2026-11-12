"""Download training material: card pictures from Scryfall and background photos (COCO val2017).

  python fetch.py cards 5000     # random card pictures -> cards/
  python fetch.py coco           # 5000 everyday photos -> bg/coco/
"""
import io
import json
import random
import sys
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).parent
UA = {'User-Agent': 'MTGTable-training/0.1 (private game table)', 'Accept': 'application/json'}


def get(url, timeout=120):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()


def cards(n):
    out = ROOT / 'cards'
    out.mkdir(exist_ok=True)
    bulk = ROOT / 'unique-artwork.jsonl.gz'
    if not bulk.exists():
        info = json.loads(get('https://api.scryfall.com/bulk-data'))
        uri = next(b['jsonl_download_uri'] for b in info['data'] if b['type'] == 'unique_artwork')
        print('downloading card list', uri)
        bulk.write_bytes(get(uri, 600))
    import gzip
    with gzip.open(bulk, 'rt', encoding='utf-8') as f:
        data = [json.loads(line) for line in f if line.strip()]
    pics = []
    for c in data:
        if 'paper' not in c.get('games', []) or c.get('lang') != 'en':
            continue
        if c.get('layout') in ('art_series', 'token', 'double_faced_token', 'emblem', 'vanguard', 'scheme', 'planar'):
            if c.get('layout') not in ('token', 'double_faced_token'):
                continue
        faces = [c] if 'image_uris' in c else [f for f in c.get('card_faces', []) if 'image_uris' in f]
        for i, f in enumerate(faces):
            pics.append((f"{c['id']}-{i}", f['image_uris']['normal']))
    random.Random(7).shuffle(pics)
    pics = pics[:n]

    def one(p):
        name, url = p
        dest = out / f'{name}.jpg'
        if dest.exists():
            return 0
        for attempt in range(3):
            try:
                dest.write_bytes(get(url, 60))
                time.sleep(0.02)
                return 1
            except Exception as err:  # noqa: BLE001
                time.sleep(2 + attempt * 3)
                last = err
        print('failed', name, last)
        return 0

    with ThreadPoolExecutor(10) as pool:
        done = sum(pool.map(one, pics))
    print('downloaded', done, 'of', len(pics), '->', out)


def coco():
    out = ROOT / 'bg' / 'coco'
    if out.exists() and len(list(out.glob('*.jpg'))) > 4000:
        print('already there')
        return
    out.mkdir(parents=True, exist_ok=True)
    print('downloading COCO val2017 (about 800 MB)')
    blob = get('http://images.cocodataset.org/zips/val2017.zip', 3600)
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        for name in z.namelist():
            if name.endswith('.jpg'):
                (out / Path(name).name).write_bytes(z.read(name))
    print('unpacked', len(list(out.glob('*.jpg'))), '->', out)


if __name__ == '__main__':
    if sys.argv[1] == 'cards':
        cards(int(sys.argv[2]) if len(sys.argv) > 2 else 5000)
    elif sys.argv[1] == 'coco':
        coco()
