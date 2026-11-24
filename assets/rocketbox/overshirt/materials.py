"""Prepare the close-range material maps from the two editable ImageGen atlases."""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, gaussian_filter, map_coordinates

HERE = Path(__file__).resolve().parent
OUT = Path(sys.argv[1])
LANCZOS = Image.Resampling.LANCZOS


def pad_islands(rgb):
    """Extend colour into empty UV gutters before building the mip chain."""
    empty = np.max(rgb, axis=2) < 12
    dist, indices = distance_transform_edt(empty, return_indices=True)
    mask = empty & (dist < rgb.shape[0] * .027)
    rgb[mask] = rgb[indices[0][mask], indices[1][mask]]
    return rgb


def compress(name, rgb, linear=False):
    path = OUT / (name + ".png")
    Image.fromarray(np.uint8(np.clip(rgb, 0, 255))).save(path)
    flags = ["-linear"] if linear else []
    subprocess.run(["basisu", "-ktx2", "-mipmap", "-max_threads", "4", "-q", "220",
                    *flags, "-file", str(path), "-output_file", str(path.with_suffix(".ktx2"))],
                   check=True, stdout=subprocess.DEVNULL)


def outfit():
    size = 2048
    rgb = np.array(Image.open(HERE / "outfit.webp").convert("RGB").resize((size, size), LANCZOS))
    y, x = np.indices((size, size), dtype=np.float32)
    u, v = x / size, y / size
    cloth = v < .848
    # Woven diagonals in the material response break up the broad painted folds at eye height.
    weave = np.sin((x + 2*y) * (2*np.pi/7)) * np.cos((2*x-y) * (2*np.pi/11))
    colour = pad_islands(rgb).astype(np.float32)
    colour += (cloth * weave * .90)[:, :, None]
    # Shoe sidewalls use a dedicated strip in the empty space between the shoe islands.
    sole = (u > .477) & (u < .523) & (v > .927) & (v < .995)
    colour[sole] = np.stack([184 + np.cos(y*.72)*2, 177 + np.cos(y*.72)*2, 159 + np.cos(y*.72)*2],axis=-1)[sole]
    compress("body", colour)
    lum = colour.mean(axis=2)
    relief = gaussian_filter(lum, 1.4) - gaussian_filter(lum, 10.)
    relief *= .035
    relief += weave * cloth * .085
    dy, dx = np.gradient(relief)
    n = np.stack((-dx, dy, np.ones_like(dx)), axis=-1)
    n /= np.linalg.norm(n, axis=2)[:, :, None]
    compress("body-normal", Image.fromarray(np.uint8((n*.5+.5)*255)).resize((1024,1024), LANCZOS), True)


def face():
    size = 1280
    src = np.array(Image.open(HERE / "face.webp").convert("RGB").resize((size, size), LANCZOS))
    y, x = np.indices((size, size), dtype=np.float32)
    u, v = x/size, y/size
    # Measured on the donor's UVs: align the upper lip with the mouth split and the
    # nostrils with the original relief. The eyelids and hairline already match.
    dv = .0085*np.exp(-((u-.5)/.091)**2-((v-.405)/.055)**2)
    dv += .0025*np.exp(-((u-.5)/.047)**2-((v-.350)/.023)**2)
    face = np.stack([map_coordinates(channel, [y+dv*size, x], order=1, mode="nearest")
                     for channel in src.transpose(2,0,1)], axis=2)
    compress("head", pad_islands(face))


outfit()
face()
