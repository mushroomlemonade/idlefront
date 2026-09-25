"""Build isolated HD terrain candidates, then use the existing paged exporter.

Dependencies: numpy, Pillow, scipy, opencv-python-headless. Offline inputs live
in .data/map-sources; URLs and hashes are embedded in each output's provenance.
No active map assets, server processes, or gameplay configuration are touched.
"""
import argparse
import gc
import hashlib
import json
import math
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.data/map-tools'))
import cv2
import numpy as np
from PIL import Image, ImageDraw

cv2.setNumThreads(1)  # Keep the ongoing playtest's CPU available.
Image.MAX_IMAGE_PIXELS = None
SOURCES = ROOT / '.data/map-sources'
URLS = {
    'original-source-response': 'https://drive.google.com/file/d/1W2oMPj1L5zWRyPhh8LfmnY3_kve-FBR2/view',
    'rivers.geojson': 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_rivers_lake_centerlines.geojson',
    'lakes.geojson': 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_lakes.geojson',
}
PIXEL_URLS = {
    'land.geojson': 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson',
    'rivers-north-america.geojson': 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_rivers_north_america.geojson',
}


def vector_land(scale, window=None, grid_dimensions=None):
    """Rasterize geographic polygons anew, preserving holes and Pacific wrap."""
    width, height = grid_dimensions or dimensions(scale)
    x0, y0, x1, y1 = window or (0, 0, width, height)
    land = np.zeros((y1-y0, x1-x0), dtype=np.uint8)
    period = width * 4110 / 4108
    features = json.loads((SOURCES / 'land.geojson').read_text(encoding='utf-8'))['features']
    for feature in features:
        geometry = feature['geometry']
        polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
        for polygon in polygons:
            rings = []
            for ring in polygon:
                pts = np.array([(((p[0]+169)%360)/360*period, (85-p[1])/165*height) for p in ring])
                pts[:, 0] = np.unwrap(pts[:, 0], period=period)
                if rings:
                    pts[:, 0] += round((rings[0][:, 0].mean() - pts[:, 0].mean()) / period) * period
                rings.append(pts)
            for shift in [-period, 0, period]:
                shifted = [np.rint(p + [shift-x0, -y0]).astype(np.int32) for p in rings]
                if shifted[0][:, 0].max() < 0 or shifted[0][:, 0].min() >= x1-x0:
                    continue
                cv2.fillPoly(land, shifted, 1)
    return land


def dimensions(scale):
    return round(4108 * scale / 4) * 4, round(1948 * scale / 4) * 4


def project(lon, lat, scale):
    # Align the master with the existing 4110px source image (the Go generator
    # crops its last 2 columns). Approximate registration: 11deg Pacific shift,
    # latitude crop 85N..80S. This is a new asset version, not replay compatible.
    width, height = dimensions(scale)
    return ((lon + 169) % 360) / 360 * (4110 / 4108) * width, (85 - lat) / 165 * height


def hydrography(land, scale, pixel_perfect=False):
    mask = np.zeros_like(land, dtype=np.uint8)
    lakes = json.loads((SOURCES / 'lakes.geojson').read_text(encoding='utf-8'))['features']
    rivers = json.loads((SOURCES / 'rivers.geojson').read_text(encoding='utf-8'))['features']
    if pixel_perfect:
        # Supplement only the requested Ontario waterways, not every small
        # continental stream. Never invent connectors between river endpoints.
        supplement = json.loads((SOURCES / 'rivers-north-america.geojson').read_text(encoding='utf-8'))['features']
        rivers += [f for f in supplement if f['properties'].get('name') in ('Trent', 'Severn', 'Otonabee')]
    def points(coords):
        return np.rint([project(*p[:2], scale) for p in coords]).astype(np.int32)
    for feature in lakes:
        geom = feature['geometry']
        if not geom:
            continue
        polygons = [geom['coordinates']] if geom['type'] == 'Polygon' else geom['coordinates']
        for polygon in polygons:
            exterior = points(polygon[0])
            if np.ptp(exterior[:, 0]) > land.shape[1] / 2:
                continue  # Never draw an antimeridian-spanning chord.
            cv2.fillPoly(mask, [exterior], 1)
            for hole in polygon[1:]:
                cv2.fillPoly(mask, [points(hole)], 0)
    river_count = 0
    for feature in rivers:
        props, geom = feature['properties'], feature['geometry']
        if not geom or (int(props.get('scalerank', 99)) > 6 and not (pixel_perfect and props.get('name') in ('Trent', 'Severn', 'Otonabee'))):
            continue
        lines = [geom['coordinates']] if geom['type'] == 'LineString' else geom['coordinates']
        for line in lines:
            pts = points(line)
            # Two-tile channels, not 3x/4x enlarged strokes. This width is a
            # navigability concession, not a claim of accurate river widths.
            breaks = np.where(np.abs(np.diff(pts[:, 0])) > land.shape[1] / 2)[0] + 1
            for segment in np.split(pts, breaks):
                if len(segment) > 1:
                    cv2.polylines(mask, [segment], False, 1, thickness=2, lineType=cv2.LINE_8)
            river_count += 1
    passages = json.loads((ROOT / 'scripts/earth-navigation-passages.json').read_text(encoding='utf-8'))
    for passage in passages['passages']:
        cv2.polylines(mask, [points(passage['coordinates'])], False, 1, thickness=2, lineType=cv2.LINE_8)
    land[mask != 0] = 0
    if pixel_perfect:
        # Preserve islands and banks: line rasterization already supplies a
        # connected minimum-width route; closing can swallow tight dry bends.
        return river_count
    # Join one-tile raster cracks only alongside documented river/canal lines.
    # Do not globally erode coasts or invent channels across unrelated land.
    water = (land == 0).astype(np.uint8)
    corridor = cv2.dilate(mask, np.ones((5, 5), dtype=np.uint8))
    closed = cv2.morphologyEx(water, cv2.MORPH_CLOSE, np.ones((3, 3), dtype=np.uint8))
    land[(corridor != 0) & (closed != 0)] = 0
    return river_count


def pack(land, blue):
    # Same terrain-byte contract as map-generator/map_generator.go:
    # land 0x80, shoreline 0x40, largest water body/ocean 0x20, magnitude 0..30.
    terrain = (np.clip(blue.astype(np.int16), 140, 200) - 139) // 2
    terrain = terrain.astype(np.uint8)
    terrain[land == 0] = 0
    terrain[land != 0] |= 128
    del blue
    water = (land == 0).astype(np.uint8)
    print('  labeling water bodies', flush=True)
    count, labels = cv2.connectedComponents(water, connectivity=4)
    sizes = np.bincount(labels.ravel())
    sizes[0] = 0
    ocean_id = int(sizes.argmax())
    terrain[labels == ocean_id] |= 32
    ocean_size = int(sizes[ocean_id])
    del labels, sizes
    print('  computing shoreline and water depth', flush=True)
    depth = cv2.distanceTransform(water, cv2.DIST_L1, 3)
    # Upstream BFS seeds shore-water at zero, then packs ceil(distance/2).
    for y in range(0, len(land), 128):
        t = terrain[y:y+128]
        d = np.minimum(np.ceil(np.maximum(depth[y:y+128] - 1, 0) / 2), 31).astype(np.uint8)
        t |= d
    del depth, water
    shore = np.zeros_like(land, dtype=bool)
    edges = land[:, 1:] != land[:, :-1]
    shore[:, 1:] |= edges
    shore[:, :-1] |= edges
    edges = land[1:, :] != land[:-1, :]
    shore[1:, :] |= edges
    shore[:-1, :] |= edges
    terrain[shore] |= 64
    return terrain, {'water_components': count - 1, 'ocean_tiles': ocean_size}


def preview(terrain):
    mag = terrain & 31
    rgb = np.empty((*terrain.shape, 3), dtype=np.uint8)
    water = (terrain & 128) == 0
    rgb[:] = (190, 211, 149)
    rgb[mag >= 10] = (217, 203, 164)
    rgb[mag >= 20] = (232, 231, 216)
    rgb[water] = (31, 61, 83)
    rgb[water & ((terrain & 64) != 0)] = (84, 123, 139)
    return Image.fromarray(rgb)


def previous_crop(scale, x, y):
    directory = ROOT / 'resources/maps' / ('expandedgiantworldlarge' if scale == 3 else 'expandedgiantworldultra')
    metadata = json.loads((directory / 'manifest.json').read_text())['map']
    crop = np.empty((384, 512), dtype=np.uint8)
    for page in metadata['pages']:
        px, py = page['x'] * metadata['page_size'], page['y'] * metadata['page_size']
        left, top = max(x, px), max(y, py)
        right, bottom = min(x+512, px+page['width']), min(y+384, py+page['height'])
        if left >= right or top >= bottom:
            continue
        data = np.fromfile(directory / page['path'], dtype=np.uint8).reshape(page['height'], page['width'])
        crop[top-y:bottom-y, left-x:right-x] = data[top-py:bottom-py, left-px:right-px]
    return crop


def comparisons(terrain, scale, output):
    if scale > 4:
        for name, lon, lat in [('trent-severn', -78.7, 44.6), ('panama', -79.7, 9.1), ('britain', -4, 55)]:
            x, y = map(round, project(lon, lat, scale))
            preview(terrain[y-192:y+192, x-256:x+256]).save(output / f'uhd-27x-{name}.png')
        return
    for name, lon, lat in [('britain', -4, 55), ('great-lakes', -84, 45), ('greece', 24, 38)]:
        cx, cy = map(int, project(lon, lat, scale))
        x, y = max(0, cx-256), max(0, cy-192)
        before = previous_crop(scale, x, y)
        canvas = Image.new('RGB', (1024, 418), (20, 27, 32))
        canvas.paste(preview(before), (0, 34))
        canvas.paste(preview(terrain[y:y+384, x:x+512]), (512, 34))
        draw = ImageDraw.Draw(canvas)
        draw.text((12, 10), f'{scale*scale}x: current shipped terrain', fill='white')
        draw.text((524, 10), 'HD master + vector waterways (native tiles)', fill='white')
        canvas.save(output / f'comparison-{scale*scale}x-{name}.png')


def build(scale, output, source_blue, provenance, pixel_perfect=False):
    width, height = dimensions(scale)
    print(f'Generating {width}x{height} from 21600x10800 master', flush=True)
    blue = np.empty((height, width), dtype=np.uint8)
    land = np.empty_like(blue)
    source_land = (source_blue != 106).astype(np.uint8) * 255
    xs = ((np.arange(width, dtype=np.float32) + .5) / (width / 4108) * (21600 / 4110) + 660 - .5) % 21600
    for y in range(0, height, 128):
        end = min(y + 128, height)
        ys = (np.arange(y, end, dtype=np.float32) + .5) / height * 9900 + 300 - .5
        mx = np.broadcast_to(xs, (end-y, width)).copy()
        my = np.broadcast_to(ys[:, None], mx.shape).copy()
        interpolation = cv2.INTER_NEAREST if pixel_perfect else cv2.INTER_LINEAR
        blue[y:end] = cv2.remap(source_blue, mx, my, interpolation, borderMode=cv2.BORDER_WRAP)
        land[y:end] = cv2.remap(source_land, mx, my, interpolation, borderMode=cv2.BORDER_WRAP) >= 128
    del source_land
    if pixel_perfect:
        land = vector_land(scale)
        # Bounded supersampling of the narrow St Lawrence coast. A tile with
        # any geographic water remains navigable; never connect via dry land.
        # This is an explicit <1-tile width concession, not surveyed widths.
        x0, y0 = map(math.floor, project(-77, 47.2, scale))
        x1, y1 = map(math.ceil, project(-70.5, 43.8, scale))
        factor = 32
        # Use an exact scaled grid, not independently rounded world sizes.
        detailed = vector_land(scale * factor, (x0*factor, y0*factor, x1*factor, y1*factor), (width*factor, height*factor))
        local = detailed.reshape(y1-y0, factor, x1-x0, factor).min(axis=(1, 3))
        del detailed
        land[y0:y1, x0:x1] = local
    rivers = hydrography(land, scale, pixel_perfect)
    if pixel_perfect:
        # Run AFTER river/lake composition: joining a line to a lake can
        # introduce a diagonal contact even when each input is connected.
        local = land[y0:y1, x0:x1]
        _, islands = cv2.connectedComponents(local, connectivity=4)
        mainland = np.unique(np.concatenate((islands[0], islands[-1], islands[:,0], islands[:,-1])))
        protected = (local != 0) & ~np.isin(islands, mainland)
        # Convert diagonal-only water contacts to a cardinal supercover. The
        # engine cannot sail between two dry corners even if a raster line
        # visually touches there. Prefer a bank cell; never erase an island.
        wet = local == 0
        diagonal = wet[:-1,:-1] & wet[1:,1:] & ~wet[:-1,1:] & ~wet[1:,:-1]
        yy, xx = np.where(diagonal)
        for y, x in zip(yy, xx):
            if not protected[y,x+1]: local[y,x+1] = 0
            elif not protected[y+1,x]: local[y+1,x] = 0
        diagonal = wet[:-1,1:] & wet[1:,:-1] & ~wet[:-1,:-1] & ~wet[1:,1:]
        yy, xx = np.where(diagonal)
        for y, x in zip(yy, xx):
            if not protected[y,x]: local[y,x] = 0
            elif not protected[y+1,x+1]: local[y+1,x+1] = 0
        land[y0:y1, x0:x1] = local
    terrain, stats = pack(land, blue)
    del blue, land
    raw = output / f'earth-{scale}x-linear.bin'
    terrain.tofile(raw)
    metadata = dict(provenance, scale=scale, width=width, height=height,
                    river_segments=rivers, terrain_sha256=hashlib.sha256(terrain).hexdigest(), **stats)
    Path(str(raw) + '.json').write_text(json.dumps(metadata, indent=2) + '\n')
    Path(str(raw) + '.NOTICE.md').write_text(
        ('# Pixel Earth candidate v1\n\n' if pixel_perfect else '# HD Earth candidate v1\n\n') +
        'Adapted from the high-resolution terrain master linked by OpenFront map-generator/README.md, '
        'and OpenFront nation metadata. OpenFront and its contributors retain attribution. '
        'Distributed under the repository LICENSE-ASSETS (CC BY-SA 4.0).\n\n'
        'Geographic geometry: Made with Natural Earth, version-pinned v5.1.2 repository data, public domain. '
        'https://www.naturalearthdata.com/about/terms-of-use/\n\n'
        'Changes: downsampled high-resolution master; registered crop; rasterized major rivers and lakes; '
        'recomputed shore/ocean/depth; adjusted water-bound nation spawns; paged output. '
        'Source URLs and SHA-256 fingerprints are in manifest.source. '
        'Rebuild with scripts/generate-hd-earth.py and scripts/generate-expanded-earth.mjs.\n')
    small = terrain[::max(1, width // 1600), ::max(1, width // 1600)]
    preview(small).save(str(raw) + '.webp', quality=92)
    # Native-resolution crops show actual tile detail, not a zoomed thumbnail.
    comparisons(terrain, scale, output)
    del terrain
    gc.collect()
    subprocess.run(['node', str(ROOT / 'scripts/generate-expanded-earth.mjs'),
                    *(['--pixel-terrain'] if pixel_perfect else []),
                    '--variant=uhd27' if scale > 4 else '--variant=large' if scale == 3 else '--variant=ultra',
                    f'--terrain-bin={raw}', f'--output-root={output / "maps"}'], cwd=ROOT, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-root', default='.data/earth-hd-v1')
    parser.add_argument('--scales', nargs='+', type=int, default=[3, 4], choices=[3, 4])
    parser.add_argument('--area27', action='store_true')
    parser.add_argument('--pixel-terrain', action='store_true', help='Fresh crisp terrain version; no coastal elevation interpolation or river-bank closing')
    parser.add_argument('--previews-only', action='store_true')
    args = parser.parse_args()
    if args.area27:
        args.scales = [math.sqrt(27)]
    if args.pixel_terrain and not args.area27:
        raise ValueError('Pixel terrain v1 is a versioned 27x-area candidate; use --area27')
    output = (ROOT / args.output_root).resolve()
    if args.previews_only:
        if ROOT not in output.parents:
            raise ValueError('Preview folder must be inside the repository')
        for scale in args.scales:
            width, height = dimensions(scale)
            terrain = np.fromfile(output / f'earth-{scale}x-linear.bin', dtype=np.uint8).reshape(height, width)
            comparisons(terrain, scale, output)
        return
    if ROOT not in output.parents or output.exists():
        raise ValueError('Choose a fresh isolated output directory inside the repo')
    output.mkdir(parents=True)
    sources = [{'file': name, 'url': url, 'sha256': hashlib.sha256((SOURCES/name).read_bytes()).hexdigest()} for name, url in {**URLS, **(PIXEL_URLS if args.pixel_terrain else {})}.items()]
    with Image.open(SOURCES / 'original-source-response') as master:
        if master.size != (21600, 10800):
            raise ValueError('Unexpected source dimensions')
        source_blue = np.array(master.getchannel('B'))
    provenance = {'generator': 'scripts/generate-hd-earth.py', 'sources': sources,
                  'pixel_terrain': args.pixel_terrain,
                  'sampling': 'new vector land raster; nearest source terrain classes; bounded 32x St Lawrence shoreline sampling; island-preserving cardinalization after river composition' if args.pixel_terrain else 'bilinear source with corridor closing',
                  'navigation_passages': json.loads((ROOT / 'scripts/earth-navigation-passages.json').read_text(encoding='utf-8')),
                  'master_resolution': [21600, 10800], 'projection': 'registered equirectangular crop; 85N to 80S, Pacific-shifted 11 degrees',
                  'status': 'candidate; not enabled for existing or new matches',
                  'river_policy': 'Natural Earth scalerank <= 6, two-tile minimum channels; geometry is generalized, not survey precision'}
    for scale in args.scales:
        build(scale, output, source_blue, provenance, args.pixel_terrain)


if __name__ == '__main__':
    main()
