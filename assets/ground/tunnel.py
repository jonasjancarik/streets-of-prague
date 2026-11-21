"""Original repeating ceramic wall and shuttered concrete soffit for street-level road tunnels."""
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

out = Path(__file__).resolve().parents[2]/"public"
W,H=1024,768
rng=np.random.default_rng(2579)
py,px=np.indices((H,W))
x=(px+.5)/W
y=1-(py+.5)/H

def noise(scale):
    n=gaussian_filter(rng.normal(size=(H,W)),scale,mode="wrap")
    return n/n.std()

def edge(t):
    return np.minimum(t%1,1-t%1)

def smooth(a,b,t):
    v=np.clip((t-a)/(b-a),0,1)
    return v*v*(3-2*v)

def mix(a,b,t):
    return a+(b-a)*t[...,None]

def save(name,a):
    path=out/f"tunnel-{name}.webp"
    Image.fromarray(np.uint8(np.clip(a,0,255))).save(path,quality=87,method=6)
    print(path.name,path.stat().st_size)

# Wall texture repeats every 4.8 m, with a darker kickboard and glaze on the ceramic faces.
gx,gy=x*12,y*22
cell=rng.uniform(.91,1.06,(22,12))[np.floor(gy).astype(int)%22,np.floor(gx).astype(int)%12]
quartz=noise(.6)
tiles=np.array([119,125,122])[None,None,:]*cell[...,None]
tiles=mix(tiles,np.array([91,96,90]),smooth(.004,.025,.04-np.minimum(edge(gx),edge(gy))))
tiles*= (1+.018*quartz+.030*noise(4))[...,None]
wall=mix(tiles,np.array([48,53,54]),1-smooth(.10,.115,y))
wall=mix(wall,np.array([77,90,90]),1-smooth(.016,.024,abs(y-.40)))
concrete=np.array([75,72,66])[None,None,:]*(1+.041*noise(16)+.022*quartz)[...,None]
wall=mix(wall,concrete,smooth(.51,.52,y))
# Recessed horizontal service conduit and small reflectors, well below head height.
wall*= (1-.38*np.exp(-((y-.123)/.006)**2)-.23*np.exp(-((y-.527)/.006)**2))[...,None]
marker=(abs(x-.45)<.012)&(abs(y-.225)<.013)
wall[marker]=[179,157,101]
pool=.72+.26*np.cos((x-.47)*2*np.pi)**2
wall*= (pool*(.86+.14*y))[...,None]
save("wall",wall)

# Cast formwork, cable runs and two shallow recessed linear light housings.
soffit=np.array([62,61,58])[None,None,:]*(1+.043*noise(21)+.030*noise(3)+.023*quartz)[...,None]
seam=np.minimum(edge(x*4),edge(y*5))
soffit*= (.75+.25*smooth(.0008,.010,seam))[...,None]
for row in [.205,.795]:
    soffit*= (1-.33*np.exp(-((y-row-.038)/.0022)**2))[...,None]
    glow=np.exp(-(((x-.5)/.20)**2+((y-row)/.060)**2))
    soffit+=glow[...,None]*np.array([18,17,12])
    housing=(abs(x-.5)<.112)&(abs(y-row)<.026)
    soffit[housing]=[33,35,32]
    frame=(abs(x-.5)<.107)&(abs(y-row)<.023)
    soffit[frame]=[91,92,83]
    glass=(abs(x-.5)<.102)&(abs(y-row)<.018)
    soffit[glass]=[219,216,187]
    louvre=glass & (edge((x-.398)*53)<.055)
    soffit[louvre]=[146,145,125]
save("soffit",soffit)
