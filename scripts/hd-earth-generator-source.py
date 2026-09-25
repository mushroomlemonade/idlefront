"""Encode the installed candidate as a standard upstream generator input PNG."""
from pathlib import Path
import argparse
import json
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--raw', default='.data/earth-hd-v1-final/earth-3x-linear.bin')
parser.add_argument('--map', default='expandedgiantworldlargehdv1')
parser.add_argument('--name')
args = parser.parse_args()
manifest = json.loads((root / 'resources/maps' / args.map / 'manifest.json').read_text())
packed = np.fromfile(root / args.raw, dtype=np.uint8).reshape(manifest['map']['height'], manifest['map']['width'])
blue = np.minimum(140 + (packed & 31).astype(np.uint16) * 2, 200).astype(np.uint8)
blue[(packed & 128) == 0] = 106
destination = root / 'map-generator/assets/maps' / args.map
destination.mkdir(parents=True, exist_ok=True)
Image.fromarray(blue).save(destination / 'image.png', compress_level=6)
(destination / 'info.json').write_text(json.dumps({
    'id': manifest['id'], 'name': args.name or ('UHD Earth 27x v1' if args.map == 'expandedgiantworlduhd27v1' else 'Expanded Earth XL HD v1'),
    'translation_key': 'map.' + args.map, 'categories': ['world'],
    'multiplayer_frequency': 0, 'nations': manifest['nations']
}, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
