"""Bake four street-level fence finishes over a 2.4 × 1.2 m repeat.

Run with pipeline/.venv/bin/python assets/furniture/fences.py.
The UVs in src/map/fences.ts leave three percent clear at each end of a row.
"""
from math import cos, pi, sin
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt

PUBLIC = Path(__file__).resolve().parents[2] / "public"
W, H = 768, 384
S = 2
WIDTH, HEIGHT = 2.4, 1.2
PX = W * S / WIDTH


def xy(x, z):
    return round(x * PX), round((.97 - .94 * z / HEIGHT) * H * S)


def line(draw, points, width, colour):
    draw.line([xy(x, z) for x, z in points], fill=colour, width=max(1, round(width * PX)))


def rect(draw, left, bottom, right, top, colour):
    x, y = xy(left, top)
    u, v = xy(right, bottom)
    draw.rectangle((x, y, u, v), fill=colour)


def posts(draw, colour, width, height, round_tube=False):
    for x in (0, WIDTH):
        for i in range(24):
            u = i / 23
            light = .65 + .48 * sin(pi * (u ** .72)) if round_tube else (.81 if u > .74 else 1.04)
            rgb = tuple(round(c * light) for c in colour)
            rect(draw, x + (u - .5) * width, -.02, x + (u - .5 + 1/23) * width, height, rgb)
        rect(draw, x-width*.57, height-.014, x+width*.57, height-.004, '#39443e')
        rect(draw, x-width*.52, height-.004, x+width*.52, height+.004, '#89908a')


def chain(draw):
    # 53 mm links on the diagonal. Twist each strand slightly as it passes
    # its neighbour, with a narrow highlight on the crown of the wire.
    pitch = .075
    for side, dark, lit in [(-1, '#58645d', '#939b92'), (1, '#505e58', '#89978c')]:
        for i in range(-20, 53):
            points = []
            for j in range(201):
                z = .045 + j * 1.08 / 200
                x = i*pitch + side*z + .0026*sin(TAU*z/pitch)
                sag = .014*(1-cos(TAU*x/WIDTH))
                points.append((x,z-sag))
            line(draw, points, .0041, dark)
            line(draw, [(x-.0009,z) for x,z in points], .0015, lit)
    for z in (.10,.596,1.131):
        points = [(i*WIDTH/64,z-.012*(1-cos(TAU*i/64))) for i in range(65)]
        line(draw, points, .0046, '#646e65')
    posts(draw,(74,89,77),.047,1.177,True)
    for x in (0, WIDTH):
        for z in (.115, .596, 1.124):
            rect(draw,x-.027,z-.006,x+.027,z+.006,'#646f65')
            line(draw,[(x-.023,z+.005),(x+.023,z+.005)],.002,'#a1aaa0')


def boards(img, draw):
    for z in (.224,.891):
        rect(draw,0,z-.039,WIDTH,z+.039,'#665742')
        rect(draw,0,z+.035,WIDTH,z+.039,'#95806a')
    grain = np.asarray(Image.open(PUBLIC/'furniture-surfaces.webp').convert('RGB'))[:127,:,:3].mean(2)
    rng = np.random.default_rng(738)
    for i in range(20):
        x, end = i*.12+.004, (i+1)*.12-.004
        high = 1.145+rng.uniform(-.012,.012)
        x0,y0 = xy(x,high); x1,y1 = xy(end,.036)
        heights = np.linspace(0,511,y1-y0).astype(int)
        widths = (np.linspace(0,32,x1-x0).astype(int)+i*15)%127
        stripe = grain[widths[None,:],heights[:,None]] / 224
        bleach = rng.uniform(.86,1.13)
        pixels = np.uint8(np.clip(stripe[:,:,None] * np.array([140,120,95]) * bleach,0,255))
        img.paste(Image.fromarray(pixels).convert('RGBA'),(x0,y0))
        line(draw,[(x,high),(end,high)], .005,'#b09a79')
        line(draw,[(end,.036),(end,high)], .005,'#685849')
        for z in (.224,.891):
            for px in (x+.023,end-.023):
                rect(draw,px-.003,z-.003,px+.003,z+.003,'#605b51')


def iron(draw):
    for z in (.19,1.055):
        rect(draw,0,z-.018,WIDTH,z+.018,'#46534e')
        rect(draw,0,z+.009,WIDTH,z+.018,'#818980')
    for i in range(20):
        x=(i+.5)*.12
        rect(draw,x-.008,.062,x+.008,1.139,'#45504e')
        rect(draw,x-.008,.062,x-.003,1.139,'#7b857f')
        rect(draw,x-.012,1.096,x+.012,1.107,'#5d6964')
        draw.polygon([xy(x-.011,1.139),xy(x,1.158),xy(x+.011,1.139)],fill='#68746e')
    posts(draw,(83,94,88),.056,1.189)


def gate(draw):
    # Morávkova's horizontal, folded steel slats have a highlight on the lip
    # and a shadow across the return, with a narrow view through each slot.
    for i in range(11):
        z=.041+i*.105
        rect(draw,0,z,WIDTH,z+.088,'#494449')
        rect(draw,0,z,WIDTH,z+.011,'#302d30')
        rect(draw,0,z+.076,WIDTH,z+.085,'#635b60')
        rect(draw,0,z+.085,WIDTH,z+.089,'#7a7173')
    posts(draw,(68,64,67),.071,1.19)


TAU = 2*pi
atlas = Image.new('RGBA',(W,H*4))
for row,style in enumerate([chain,boards,iron,gate]):
    img = Image.new('RGBA',(W*S,H*S))
    draw = ImageDraw.Draw(img)
    if style is boards:
        boards(img,draw)
    else:
        style(draw)
    pixels = np.array(img.resize((W,H),Image.Resampling.LANCZOS))
    # Repeat neutral edge colours through the clear texels for clean mipmaps.
    empty = pixels[:,:,3] < 8
    iy,ix = distance_transform_edt(empty,return_distances=False,return_indices=True)
    pixels[empty,:3] = pixels[iy[empty],ix[empty],:3]
    atlas.paste(Image.fromarray(pixels),(0,(3-row)*H))
atlas.save(PUBLIC/'street-fences.webp',quality=88,method=6,exact=True)
