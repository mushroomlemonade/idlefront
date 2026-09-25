"""A bounded test: reaching Georgian Bay via the other Great Lakes is not a pass."""
import importlib.util
import json
from pathlib import Path
import sys
spec = importlib.util.spec_from_file_location("verify", Path(__file__).with_name("verify-hd-earth.py"))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)
import numpy as np
root = Path(sys.argv[1])
manifests = list((root / 'maps').glob('*/manifest.json')) or list((root / 'final/maps').glob('*/manifest.json'))
if len(manifests) != 1: raise ValueError('Expected exactly one candidate map')
manifest = json.loads(manifests[0].read_text(encoding='utf-8'))
w, h = manifest["map"]["width"], manifest["map"]["height"]
terrain = np.memmap(next(root.glob("earth-*-linear.bin")), dtype=np.uint8, mode="r", shape=(h, w))
passed = verify.route(terrain, w / 4108,
    (-77.575, 44.10), (-79.77, 44.81), (-80.0, 43.95, -77.4, 45.0))
report = {
    "route": "Trent–Severn: Trenton to Port Severn",
    "continuousFullResolutionWater": bool(passed),
    "bounds": [-80.0, 43.95, -77.4, 45.0],
    "status": "Needs production route validation" if passed else "Not yet navigable in this candidate",
    "note": "Do not invent a straight canal or count the long Great Lakes detour as success.",
    "reference": "https://parks.canada.ca/lhn-nhs/on/trentsevern",
}
(root / "trent-severn-validation.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
