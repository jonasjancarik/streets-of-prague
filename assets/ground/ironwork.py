"""Bake colour and tangent-space normals for four original Prague ironwork finishes.

Run with the pipeline Python. The top row holds two cast lids. The lower row
contains the drain casting and the small underground-hydrant access plate.
The surveyed utility data gives the location and kind, not the individual casting.
"""
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SIZE = 512
rng = np.random.default_rng(57)
font = ROOT / "trailer/media/BebasNeue-Regular.ttf"
diffuse = Image.new("RGB", (2 * SIZE, 2 * SIZE))
normals = diffuse.copy()

def arc_letters(draw_on, text, radius, size, centre, sweep):
    face = ImageFont.truetype(str(font), size)
    for i, char in enumerate(text):
        angle = centre - sweep / 2 + i * sweep / max(1, len(text) - 1)
        a = math.radians(angle)
        stamp = Image.new("L", (size * 2, size * 2))
        ImageDraw.Draw(stamp).text((size, size), char, font=face, fill=255, anchor="mm")
        stamp = stamp.rotate(-angle, Image.Resampling.BICUBIC)
        draw_on.paste(180, (round(256 + radius * math.sin(a) - size), round(256 - radius * math.cos(a) - size)), stamp)

def point(r, angle):
    a = math.radians(angle)
    return (256 + r * math.cos(a), 256 + r * math.sin(a))

def ring(d, r, value, width):
    d.ellipse((256-r, 256-r, 256+r, 256+r), outline=value, width=width)

for kind in range(4):
    h = Image.new("L", (SIZE, SIZE), 83)
    d = ImageDraw.Draw(h)
    if kind < 2:
        for r, value, width in [(251,130,4),(243,58,4),(232,29,9),(221,155,3),(212,117,4)]:
            ring(d,r,value,width)
        if kind == 0:
            for r in [111,160,202]:
                ring(d,r,153,5)
            for i in range(32):
                a = i * 360 / 32
                d.line((point(167,a),point(196,a+3)),fill=168,width=7)
                d.line((point(119,a+3),point(151,a+6)),fill=149,width=6)
            # Three crenellated towers and the gate, drawn for the game.
            for x,y,w in [(223,226,24),(253,211,30),(288,226,24)]:
                d.rectangle((x-w/2,y,x+w/2,293), fill=152)
                for j in range(3):
                    d.rectangle((x-w/2+j*w/3,y-7,x-w/2+j*w/3+w/6,y+2), fill=169)
                d.rectangle((x-2,y+12,x+2,y+21),fill=58)
            d.rectangle((204,268,308,300),fill=145)
            d.rounded_rectangle((245,276,268,311),radius=11,fill=72)
            arc_letters(h,"PRAHA",85,29,0,85)
        else:
            for j in range(-7,8):
                for i in range(-7,8):
                    x,y=256+30*i+(j%2)*15,256+24*j
                    if math.hypot(x-256,y-256)>197: continue
                    a = 1 if (i+j)%2 else -1
                    d.line((x-9,y-6*a,x+9,y+6*a),fill=155,width=6)
            d.rounded_rectangle((205,233,307,279),radius=4,fill=78,outline=162,width=3)
            d.text((256,255),"PRAHA",font=ImageFont.truetype(str(font),29),fill=182,anchor="mm")
        for angle in [0,120,240]:
            x,y=point(186,angle+11)
            d.rounded_rectangle((x-11,y-6,x+11,y+6),radius=4,fill=20,outline=106,width=2)
    elif kind == 2:
        # The depth between the bars is geometry. Leave casting grit on the iron.
        for inset,value,width in [(3,160,9),(15,67,3),(21,120,4),(39,28,6)]:
            d.rounded_rectangle((inset,inset,511-inset,511-inset),radius=7,outline=value,width=width)
        for x in [25,487]:
            for y in [25,487]:
                d.ellipse((x-7,y-7,x+7,y+7),fill=159,outline=55,width=2)
                d.line((x-4,y+2,x+4,y-2),fill=67,width=2)
        # A dark part under the grate, sampled by its recessed bed.
        d.rectangle((230,230,240,240),fill=5)
    else:
        for inset,value,width in [(8,152,5),(23,30,12),(40,158,5),(64,132,4)]:
            d.ellipse((inset,inset,511-inset,511-inset),outline=value,width=width)
        for j in range(-3,4):
            for i in range(-4,5):
                x,y=256+33*i,256+38*j
                if math.hypot(x-256,y-256)<170: d.ellipse((x-3,y-3,x+3,y+3),fill=132)
        d.rounded_rectangle((184,166,328,346),radius=11,fill=84,outline=147,width=5)
        d.text((256,252),"H",font=ImageFont.truetype(str(font),155),fill=183,anchor="mm")
        d.rounded_rectangle((233,385,280,406),radius=7,fill=14,outline=91,width=3)
    height = np.asarray(h.filter(ImageFilter.GaussianBlur(1.1)),dtype=float)
    coarse = np.asarray(Image.fromarray(rng.integers(0,256,(24,24),dtype=np.uint8)).resize((SIZE,SIZE),Image.Resampling.BICUBIC),dtype=float)/255
    grit = rng.normal(0,1,(SIZE,SIZE))
    cavities = np.clip((78-height)/56,0,1)
    wear = np.clip((height-90)/80,0,1)
    value = (69 + 15*coarse + 61*wear + 6*grit) * (1-.74*cavities)
    rust = np.maximum(coarse-.47,0)*(1-wear)*28
    rgb = np.stack([value+rust+3, value+rust*.19, value-rust*.32],axis=-1)
    relief = height + grit * 2.3
    dy,dx=np.gradient(relief)
    n=np.stack([-dx*.077,dy*.077,np.ones_like(dx)],axis=-1)
    n/=np.linalg.norm(n,axis=-1,keepdims=True)
    at=((kind%2)*SIZE,(kind//2)*SIZE)
    diffuse.paste(Image.fromarray(np.uint8(np.clip(rgb,0,255))),at)
    normals.paste(Image.fromarray(np.uint8(np.clip(n*127.5+127.5,0,255))),at)

for image,name in [(diffuse,"ironwork"),(normals,"ironwork-normal")]:
    path=ROOT/"public"/(name+".webp")
    side = 768 if name == "ironwork" else 512
    image.resize((side, side), Image.Resampling.LANCZOS).save(path,quality=88,method=6)
    print(path.name,path.stat().st_size)
