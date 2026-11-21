"""Three Prague-style pavement layouts on the same 6 cm limestone cubes.

Bake the reflectance of plain, chequered and bordered paving into RGB; a second
map stores the horizontal normal and the stone's warm/cool variation. Both wrap.
"""
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

ROOT = Path(__file__).resolve().parents[2]
SIZE, CELLS = 1024, 32
rng = np.random.default_rng(261121)

def field(sigma):
    f = gaussian_filter(rng.normal(size=(SIZE, SIZE)), sigma, mode="wrap")
    return f / f.std()

def smooth(a, b, v):
    u = np.clip((v-a)/(b-a), 0, 1)
    return u*u*(3-2*u)

row, col = np.indices((SIZE, SIZE))
x = (col + .5) * CELLS / SIZE
y = (row + .5) * CELLS / SIZE
# Slight drift in a row and individual split edges. The tesserae still have
# four dressed sides, with irregular chipped corners and narrow mortar joints.
v = y + .048*field(28) + .035*field(5) + .017*field(1.9)
j = np.floor(v).astype(int) % CELLS
u = x + rng.uniform(-.16, .16, CELLS)[j] + .065*field(25) + .033*field(5) + .018*field(1.5)
i = np.floor(u).astype(int) % CELLS
fx, fy = u % 1 - .5, v % 1 - .5
stone = rng.random((CELLS,CELLS,6))[j,i]
edge = np.minimum(.5-np.abs(fx), .5-np.abs(fy))
diagonal = (.91-stone[...,0]*.12 - np.abs(fx) - np.abs(fy)) * .707
edge = np.minimum(edge, diagonal)
joint = smooth(.014,.056,edge)
top = smooth(.009,.095,edge)
grain, cloud = field(.55), field(5.2)
# Bright line in an occasional individual stone, along the mineral vein.
angle = stone[...,1] * np.pi
vein = np.abs(fx*np.cos(angle)+fy*np.sin(angle) + .04*cloud + stone[...,2]-.5)
vein = np.exp(-(vein/.030)**2) * (stone[...,5]>.71)
quartz = np.maximum(0, grain-1.25)
noise = 1 + grain*.035 + cloud*.043 + vein*.18 + quartz*.06
own = .91 + stone[...,3]*.20
pale = 1.13*own
dark = .47 + stone[...,3]*.13
across, along = (i+j)%16, (i-j)%16
checker = ((i+j)//8+(i-j)//8)%2==0
lattice = (across<2)|(along<2)|((np.abs(across-8)+np.abs(along-8))<2)
layouts = [np.where(stone[...,4]<.09, dark, 1.01*own),np.where(checker,dark,pale),np.where(lattice,dark,pale)]
out = np.stack([(.55+.035*cloud)*(1-joint) + a*noise*joint for a in layouts],axis=-1)
# Store the multiplier in [0, 1.60], leaving room for the pale crystals.
diffuse = Image.fromarray(np.uint8(np.clip(out/1.6,0,1)*255))
# About two millimetres of relief, with small differences in height between stones.
height = top*(.0015+.0014*stone[...,0]) + joint*(cloud*.00014+grain*.00009)
dx = (np.roll(height,-1,1)-np.roll(height,1,1)) / (2*1.92/SIZE)
dy = (np.roll(height,-1,0)-np.roll(height,1,0)) / (2*1.92/SIZE)
den = np.sqrt(1+dx*dx+dy*dy)
tint = np.clip(.5 + (stone[...,2]-.5)*.70 + cloud*.025 + vein*.09,0,1)
meta = Image.fromarray(np.uint8(255*np.stack([.5-.5*dx/den,.5+.5*dy/den,tint],axis=-1)))
for name, image, size in [('street-mosaic',diffuse,1024),('street-mosaic-relief',meta,768)]:
    path = ROOT/'public'/(name+'.webp')
    image.resize((size,size),Image.Resampling.LANCZOS).save(path,quality=91,method=6)
    print(path.name,path.stat().st_size)
