"""Verify paged hashes, spawns and local full/LOD water passage connectivity."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.data/map-tools'))
import cv2
import numpy as np
from PIL import Image, ImageDraw
cv2.setNumThreads(1)

ROUTES = {
    'St Lawrence': ((-76.45, 44.20), (-71.20, 46.80), (-77, 43.8, -70.5, 47.2)),
    'Panama Canal': ((-79.53, 8.90), (-79.93, 9.40), (-80.12, 8.80, -79.40, 9.50)),
    'Suez Canal': ((32.56, 29.88), (32.30, 31.30), (32.15, 29.75, 32.70, 31.40)),
    'Gibraltar': ((-5.75, 35.98), (-5.20, 35.98), (-5.9, 35.7, -5.0, 36.2)),
    'Bosphorus': ((28.98, 40.99), (29.17, 41.25), (28.85, 40.9, 29.3, 41.35)),
    'Dover Strait': ((1.1, 50.7), (1.7, 51.3), (0.9, 50.5, 2.1, 51.5)),
    'Mississippi lower reach': ((-91.18, 30.46), (-89.26, 29.12), (-92, 28.9, -89, 30.7)),
    'Rhine lower reach': ((6.76, 51.44), (4.12, 51.98), (3.8, 51.1, 7, 52.2)),
    'Amazon lower reach': ((-55.5, -1.95), (-50.5, 0.5), (-56, -3, -49.5, 1)),
    'Dardanelles': ((26.15, 40.0), (26.70, 40.40), (26.0, 39.9, 26.9, 40.6)),
}


def xy(lon, lat, scale):
    return round(((lon + 169) % 360) / 360 * 4110 * scale), round((85-lat) / 165 * 1948 * scale)


def route(terrain, scale, start, end, bounds):
    west, south, east, north = bounds
    x0, y0 = xy(west, north, scale)
    x1, y1 = xy(east, south, scale)
    water = ((terrain[y0:y1+1, x0:x1+1] & 128) == 0).astype(np.uint8)
    _, labels = cv2.connectedComponents(water, connectivity=4)
    def label(point):
        x, y = xy(*point, scale)
        x, y = x-x0, y-y0
        candidates = []
        radius = max(2, round(3 * scale))
        for yy in range(max(0, y-radius), min(len(labels), y+radius+1)):
            for xx in range(max(0, x-radius), min(labels.shape[1], x+radius+1)):
                if labels[yy, xx]:
                    candidates.append(((xx-x)**2 + (yy-y)**2, int(labels[yy, xx])))
        return min(candidates)[1] if candidates else None
    a, b = label(start), label(end)
    if a is None or a != b:
        print('  disconnected endpoints', start, end, 'labels', a, b)
    return a is not None and a == b


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root')
    args = parser.parse_args()
    root = Path(args.root)
    result = {}
    for directory in (root / 'maps').iterdir():
        manifest = json.loads((directory / 'manifest.json').read_text())
        meta = manifest['map']
        w, h = meta['width'], meta['height']
        scale = w / 4108
        terrain = np.empty((h, w), dtype=np.uint8)
        for page in meta['pages']:
            data = (directory / page['path']).read_bytes()
            assert len(data) == page['width'] * page['height'] == page['byte_length']
            assert hashlib.sha256(data).hexdigest() == page['sha256']
            x, y = page['x'] * meta['page_size'], page['y'] * meta['page_size']
            terrain[y:y+page['height'], x:x+page['width']] = np.frombuffer(data, dtype=np.uint8).reshape(page['height'], page['width'])
        assert int(np.count_nonzero(terrain & 128)) == meta['num_land_tiles']
        for nation in manifest['nations']:
            x, y = nation['coordinates']
            assert terrain[y, x] & 128, nation['name']
        report = {}
        for name, (start, end, bounds) in ROUTES.items():
            west, south, east, north = bounds
            x0,y0 = xy(west,north,scale)
            x1,y1 = xy(east,south,scale)
            local = terrain[y0:y1+1,x0:x1+1]
            _, labels = cv2.connectedComponents(((local & 128)==0).astype(np.uint8), connectivity=4)
            rgb = np.full((*local.shape,3), 195, dtype=np.uint8)
            for index in range(1, int(labels.max())+1):
                rgb[labels==index] = ((index*47)%140, (index*71)%140, 90+(index*37)%165)
            im = Image.fromarray(rgb).resize((local.shape[1]*8,local.shape[0]*8),Image.Resampling.NEAREST)
            draw=ImageDraw.Draw(im)
            for p in (start,end):
                x,y=xy(*p,scale); x=(x-x0)*8; y=(y-y0)*8
                draw.ellipse((x-5,y-5,x+5,y+5),outline='red',width=2)
            im.save(root / f'route-{int(scale*scale)}x-{name.replace(" ","-")}.png')
        for lod, divisor in [('map', 1), ('map4x', 2)]:
            grid = terrain if divisor == 1 else np.fromfile(directory / 'map4x.bin', dtype=np.uint8).reshape(h//2, w//2)
            report[lod] = {name: route(grid, scale/divisor, *values) for name, values in ROUTES.items()}
        result[manifest['id']] = report
        print(manifest['id'], json.dumps(report, indent=2), flush=True)
    (root / 'waterway-validation.json').write_text(json.dumps(result, indent=2) + '\n')
    if not all(ok for report in result.values() for lod in report.values() for ok in lod.values()):
        raise SystemExit('Some geographic passages need correction; candidates are not release-ready.')


if __name__ == '__main__':
    main()
