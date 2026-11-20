"""Ray-integrate the fair-weather cloud bank into a directional lookup atlas.
Uses the same periodic footprint as src/clouds.ts so its shadows stay under the clouds.
Run with pipeline/.venv/bin/python assets/sky/clouds.py.
"""
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates, shift

N, SLICES, BORDER = 224, 40, 3
AZIMUTHS, ELEVATIONS, SPAN = 12, 7, 2400
BOTTOM, DEPTH, SHADOW_HEIGHT = 930, 230, 1100
u, v = np.meshgrid(np.arange(N) / N, np.arange(N) / N)

def shadow_octave(cells, seed):
    # The game's LCG and cubic interpolation, in the same lattice order.
    a = np.empty(cells * cells)
    for i in range(a.size):
        seed = (seed * 1664525 + 1013904223) & 0xffffffff
        a[i] = seed / 4294967296
    a = a.reshape(cells, cells)
    x, y = u * cells, v * cells
    i, j = x.astype(int), y.astype(int)
    sx, sy = x - i, y - j
    sx, sy = sx*sx*(3-2*sx), sy*sy*(3-2*sy)
    return ((1-sx)*a[j,i] + sx*a[j,(i+1)%cells])*(1-sy) + ((1-sx)*a[(j+1)%cells,i] + sx*a[(j+1)%cells,(i+1)%cells])*sy

broad = sum(w * shadow_octave(c,s) for c,w,s in [(7,.55,3),(15,.30,7),(31,.15,13)])
rank = np.empty(N*N, dtype=float)
rank[np.argsort(broad, axis=None)] = np.linspace(0, 1, N*N)
rank = rank.reshape(N,N)
rng=np.random.default_rng(8407)
def noise(cells):
    a = rng.uniform(-1,1,(cells,cells,cells))
    def at(x,y,h):
        z=np.broadcast_to((.21+h*.11)*cells,x.shape)
        return map_coordinates(a,[z,y*cells,x*cells],order=1,mode='grid-wrap')
    return at
coarse, mid, small, fine = [noise(n) for n in (9,23,47,83)]
warp_x, warp_y = shadow_octave(13,27)-.5, shadow_octave(12,41)-.5
vol=[]
for k in range(SLICES):
    h=(k+.5)/SLICES
    x=u + .025*warp_x + h*.017; y=v + .025*warp_y-h*.011
    # Updraughts have a common condensation level and grow higher at the centre
    # of a bank. Smaller lobes and eroded edges break up the otherwise smooth cap.
    mass = (rank - .625)*2.36 + .25*coarse(x,y,h) + .19*mid(x,y,h) + .09*small(x,y,h) + .055*fine(x,y,h)
    mass -= .10 + .94*max(0,h-.23)**1.5
    base = np.clip((h + .055*mid(x+.31,y,h)-.028)*8,0,1)
    vol.append(np.clip(mass*1.64,0,1)*base)
volume=np.asarray(vol, dtype=np.float32)
dz=DEPTH/SLICES

def slide(a, dx, dy):
    # Sample at (x+dx,y+dy). dx/dy are metres of horizontal displacement.
    return shift(a, (-dy*N/SPAN,-dx*N/SPAN), order=1, mode='grid-wrap', prefilter=False)

# Illumination looking out of the cloud in four compass directions. The path to
# the sun is propagated down the volume; backlit edges still get diffuse skylight.
sun=[]
for dx,dy in [(1,0),(-1,0),(0,1),(0,-1),(0,0)]:
    light=np.empty_like(volume);tau=np.zeros_like(volume[0])
    for k in reversed(range(SLICES)):
        lateral=1.35 if dx or dy else 0
        tau=slide(tau,dx*lateral*dz,dy*lateral*dz)
        mass=volume[k]*dz*np.hypot(lateral,1)
        light[k]=np.exp(-.019*(tau+.5*mass))
        tau+=mass
    sun.append(light)
base=.21*sun[4]+.1975*(sun[0]+sun[1]+sun[2]+sun[3])
direction_x=(sun[0]-sun[1])*.56
direction_z=(sun[2]-sun[3])*.56
tile=N+BORDER*2
atlas=np.empty((ELEVATIONS*tile,AZIMUTHS*tile,4),dtype='uint8')
for row in range(ELEVATIONS):
    elev=.10+.15*row
    slope=np.sqrt(max(0,1-elev*elev))/elev
    for col in range(AZIMUTHS):
        angle=2*np.pi*col/AZIMUTHS
        dx,dz_view=np.cos(angle)*slope,np.sin(angle)*slope
        through=np.ones_like(volume[0])
        light=np.zeros_like(through);cx=light.copy();cz=light.copy()
        for k in range(SLICES):
            offset=BOTTOM+(k+.5)*dz-SHADOW_HEIGHT
            sx,sz=dx*offset,dz_view*offset
            rho=slide(volume[k],sx,sz)
            alpha=1-np.exp(-rho*dz*.024/elev)
            weight=alpha*through
            light+=weight*slide(base[k],sx,sz)
            cx+=weight*slide(direction_x[k],sx,sz)
            cz+=weight*slide(direction_z[k],sx,sz)
            through*=1-alpha
        pixels=np.stack([1-through,light,.5+.74*cx,.5+.74*cz],axis=-1)
        # Directional terms are smooth and weak. Quantising them saves most of
        # the otherwise lossless alpha plane without sacrificing the outline.
        pixels[...,2:]=.5+np.round((pixels[...,2:]-.5)*48)/48
        pixels=np.pad(pixels,((BORDER,BORDER),(BORDER,BORDER),(0,0)),mode='wrap')
        atlas[row*tile:(row+1)*tile,col*tile:(col+1)*tile]=np.uint8(np.clip(pixels,0,1)*255+.5)
out=Path(__file__).resolve().parents[2]/'public'/'cloud-bank.webp'
pending=out.with_suffix('.tmp')
Image.fromarray(atlas).save(pending,format='WEBP',quality=89,method=5,exact=True)
pending.replace(out)
print(out,out.stat().st_size)
