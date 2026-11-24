"""Pack the Charles Bridge wall, its coping and a neutral sample for the deck.

Run with pipeline/.venv/bin/python assets/ground/bridge.py. The two source maps
are Rob Tuytel's CC0 Large Sandstone Blocks scan for Poly Haven. The game samples
one small colour atlas; the restrained cavity shading is baked here.
"""
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "pipeline/.cache/bridge-stone"
BASE = "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/large_sandstone_blocks/"
W, H = 1024, 512


def source(kind):
    name = f"large_sandstone_blocks_{kind}_1k.jpg"
    path = CACHE / name
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        request = Request(BASE + name, headers={"User-Agent": "StreetsOfPrague/1.0"})
        with urlopen(request, timeout=45) as response:
            data = response.read()
        Image.open(BytesIO(data)).verify()
        path.write_bytes(data)
    return Image.open(path)


def colour_map():
    scan = np.asarray(source("diff").convert("RGB"), dtype=float)
    cavity = np.asarray(source("ao").convert("L"), dtype=float) / 255
    height = scan.shape[0]
    # The scan has projecting architectural mouldings at top and bottom.
    # Use the ashlar courses between them for the bridge wall.
    lo, hi = round(height * .13), round(height * .91)
    scan, cavity = scan[lo:hi], cavity[lo:hi]
    lum = scan @ np.array([.24, .59, .17])
    median = np.median(lum)
    value = np.clip(148 + (lum-median)*1.02, 81, 203) * (.76 + .24*cavity)
    wall = value[:, :, None] * np.array([1.025, 1.00, .934]) + (scan-lum[:, :, None])*.42
    return Image.fromarray(np.uint8(np.clip(wall, 0, 255)))


def main():
    stone = colour_map()
    atlas = np.empty((H,W,3), dtype=np.uint8)
    # (0,0) in mesh UVs belongs to the unmodified slab, including its plain deck.
    atlas[:] = [142,139,132]
    wall = np.asarray(stone.resize((W//2,356), Image.Resampling.LANCZOS))
    rows = np.concatenate([wall, wall[:, ::-1]], axis=1).astype(float)
    y,x = np.mgrid[:356,:W]
    fade = 2.6*np.sin(x*2*np.pi/W + y/160) + 2.1*np.sin(x*6*np.pi/W-y/81)
    rows = np.uint8(np.clip(rows + fade[:,:,None],0,255))
    atlas[121:477] = rows
    atlas[115:121] = rows[0]; atlas[477:485] = rows[-1]

    # The coping stones span the parapet. Their joints cross the top and turn
    # down its lip. Sample the interior of a block so it has no upright joints
    # or architectural mouldings running lengthwise along the top.
    block = stone.crop((round(stone.width*.37),round(stone.height*.44),
                        round(stone.width*.50),round(stone.height*.59)))
    block = np.asarray(block.resize((180,105), Image.Resampling.LANCZOS)).astype(float)
    rng = np.random.default_rng(1677)
    edges = [0,143,299,461,590,752,889,W]
    cap = np.empty((105,W,3))
    for i,(a,b) in enumerate(zip(edges,edges[1:])):
        sample = np.roll(block, rng.integers(0,80), axis=1)
        if i%2: sample = sample[:,::-1]
        patch = Image.fromarray(np.uint8(sample)).resize((b-a,105),Image.Resampling.LANCZOS)
        cap[:,a:b] = np.asarray(patch)*rng.uniform(.95,1.075)+5
    yy,xx = np.mgrid[:105,:W]
    grain = gaussian_filter(rng.normal(size=(105,W)), (.7,1.2),mode='wrap')
    jitter = 1.2*np.sin(yy/24)+.45*np.sin(yy/5)
    inset = np.min([np.abs((xx-e-jitter+W/2)%W-W/2) for e in edges[:-1]],axis=0)
    joint = np.exp(-(inset/1.35)**2)
    cap += (grain*4 - 35*joint + 6*np.exp(-((inset-2.3)/1.3)**2))[:,:,None]
    atlas[4:109] = np.uint8(np.clip(cap,0,255))
    # The face of that same coping course directly below the top edge.
    lip = cap[34:56].copy()
    lip += np.linspace(2,-8,22)[:,None,None]
    atlas[121:143] = np.uint8(np.clip(lip,0,255))
    atlas[143:146] = np.uint8(np.clip(lip[-1] - 20,0,255))
    atlas[115:121] = atlas[121]
    out = ROOT / "public/charles-sandstone.webp"
    Image.fromarray(atlas).save(out,quality=88,method=6)
    print(f"{out.name}: {out.stat().st_size:,} bytes, {sha256(out.read_bytes()).hexdigest()[:12]}")


if __name__ == "__main__":
    main()
