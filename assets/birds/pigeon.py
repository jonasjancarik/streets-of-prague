"""Build the close rock pigeon. Run with blender -b -P assets/birds/pigeon.py.

Metres, facing +X. The head pivots inside the breast and the flight feathers
overlap from the shoulder out. Parts are drawn in batches in src/streetBirds.ts.
Only the temporary scene and meshes created here are used or removed.
"""
from math import cos, pi, sin
from pathlib import Path

import bpy
from mathutils import Vector

OUT = Path(__file__).resolve().parents[2] / "public" / "street-pigeon.glb"
TAU = 2 * pi


class Part:
    def __init__(self):
        self.vertices, self.faces, self.colours = [], [], []

    def bands(self, rings, colours, flip=False):
        """A succession of closed rings, each given in the same order."""
        start = len(self.vertices)
        n = len(rings[0])
        for row in rings:
            self.vertices.extend(row)
        for i in range(len(rings)-1):
            for j in range(n):
                a, b = start + i*n + j, start + i*n + (j+1) % n
                face = (a, b, b+n, a+n)
                self.faces.append(face[::-1] if flip else face)
                self.colours.append(colours(i, j))
        for ids, index in [(range(n-1, -1, -1), 0), (range(n), len(rings)-1)]:
            face = tuple(start + index*n + j for j in ids)
            self.faces.append(face[::-1] if flip else face)
            self.colours.append(colours(min(index,len(rings)-2), 0))

    def loft(self, levels, paint, n=12):
        # Horizontal ellipses; small changes in centre describe breast, crop and nape.
        self.bands([[(x+rx*cos(j*TAU/n), y+ry*sin(j*TAU/n), z) for j in range(n)]
                    for x, y, z, rx, ry in levels], paint)

    def ellipsoid(self, c, radii, colour, n=8):
        x,y,z = c
        rx,ry,rz = radii
        self.loft([(x,y,z+rz*sin(a),rx*cos(a),ry*cos(a)) for a in (-1.46,-.55,.48,1.46)],
                  lambda i,j: colour, n)

    def tube(self, a, b, r0, r1, colour, n=6):
        delta = (Vector(b)-Vector(a)).normalized()
        u = delta.orthogonal().normalized()
        v = delta.cross(u)
        self.bands([[tuple(Vector(at)+r*(u*cos(j*TAU/n)+v*sin(j*TAU/n))) for j in range(n)]
                    for at,r in [(a,r0),(b,r1)]], lambda i,j: colour)

    def mesh(self, scene, name, pivot=(0,0,0)):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([tuple(v[i]-pivot[i] for i in range(3)) for v in self.vertices], [], self.faces)
        rgb = mesh.color_attributes.new(name="Plumage", type='BYTE_COLOR', domain='CORNER')
        for p,c in zip(mesh.polygons,self.colours):
            p.use_smooth = True
            colour = tuple(int(c[i:i+2],16)/255 for i in (0,2,4)) + (1,)
            for loop in p.loop_indices:
                rgb.data[loop].color_srgb = colour
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        scene.collection.objects.link(obj)
        return obj


def torso(part):
    levels = [(-.004, .052, .022, .026), (-.008,.064,.065,.042),
              (-.019,.087,.095,.054),(-.019,.115,.101,.057),
              (-.009,.137,.095,.053),(.005,.156,.073,.046),
              (.028,.170,.047,.039),(.035,.177,.027,.029)]
    shades = ['656774','787d87','9297a0','979ea6','9299a1','747e88','626d78']
    part.loft([(x,0,z,rx,ry) for x,z,rx,ry in levels],lambda i,j:shades[i])
    # The tail lies beyond the wing tips. Narrow feather ends make a scalloped
    # outline; their terminal band is almost black, with a lighter worn edge.
    for k in range(-2,3):
        root_y, tip_y = k*.0045, k*.013
        end = -.192 + abs(k)*.0023
        rings = []
        for t,w in [(0,.0055),(.72,.0082),(.95,.0078),(1,.0042)]:
            x = -.068 + t*(end+.068)
            y = root_y + t*(tip_y-root_y)
            z = .118 - .043*t - abs(k)*.0009
            rings.append([(x,y+w,z),(x,y,z+.0018),(x,y-w,z),(x,y,z-.0009)])
        part.bands(rings,lambda i,j:['777d87','474b56','747984'][i], flip=True)


def head(part):
    levels = [(.033,.111,.033,.035),(.044,.137,.043,.043),(.050,.159,.041,.040),
              (.059,.181,.033,.031),(.065,.194,.031,.029),(.070,.207,.030,.028),
              (.071,.220,.024,.023),(.071,.227,.013,.015),(.071,.229,.003,.004)]
    def collar(i,j):
        side = abs(sin((j+.5)*TAU/12))
        if i in (1,2) and side > .45:
            return ('506d68' if i==2 else '676174') if side>.78 else '5b6271'
        return ['747a86','676a77','5d6975','66737e','707b87','717d89','75818a','77818a'][i]
    part.loft([(x,0,z,rx,ry) for x,z,rx,ry in levels],collar)
    part.tube((.091,0,.202),(.127,0,.197),.010,.002,'454b51',8)
    part.ellipsoid((.100,0,.208),(.013,.008,.0055),'c3beb2')
    for sign in (-1,1):
        y = sign*.0263
        # One shallow lens: orbital skin, amber iris, dark pupil.
        rings = [[(.077+r*cos(j*TAU/8),y+sign*d,.210+r*sin(j*TAU/8)) for j in range(8)]
                 for r,d in [(.0051,0),(.004,.0014),(.0023,.0019),(.0005,.0022)]]
        part.bands(rings,lambda i,j:['a98b79','b78552','272b2d'][i],flip=sign>0)


def feet(part, folded=False):
    for sign in (-1,1):
        y = sign*.019
        x = .008*sign
        ankle = (x-.049,y,.084) if folded else (x-.010,y,.009)
        part.tube((x+.002,y,.069),ankle,.0042,.0029,'a36e70')
        for toe in [-1,0,1,2]:
            off = -.017 if toe==2 else .026-max(0,abs(toe))*.007
            end = (ankle[0]+off, y+(0 if toe==2 else toe*.012), ankle[2]-.006)
            part.tube(ankle,end,.0023,.0007,'a66e70',5)


def wing(part, side, spread):
    # The same feather rows change direction at the wrist. On the folded wing,
    # dark bars cross the paler coverts, and the primaries end against the tail.
    rings = []
    stops = [(0,.014),(.13,.032),(.28,.040),(.40,.038),(.46,.036),
             (.54,.033),(.60,.030),(.71,.024),(.87,.014),(1,.0016)]
    for u,half in stops:
        if spread:
            x = .029 - .068*u - .082*u*u
            y = .027 + .281*u
            z = .144 + .021*sin(pi*u) - .006*u
            rings.append([(x+half*cos(j*TAU/8),side*y,z+.005*sin(j*TAU/8)) for j in range(8)])
        else:
            x = .060 - .231*u
            y = .038 + .017*sin(pi*u)-.016*u
            z = .134 - .044*u
            # Cross section wraps down the flank. Its upper edge rounds into the back.
            rings.append([(x,side*(y+.007*cos(j*TAU/8)-.012*sin(j*TAU/8)),
                           z+half*sin(j*TAU/8)) for j in range(8)])
    shades = ['858c96','989fa8','969ca6','4a4e58','8b929c','4b5059','757d87','565d68','444b55']
    part.bands(rings,lambda i,j:shades[i],flip=side>0)


def build():
    scene = bpy.data.scenes.new("Street pigeon export")
    owned = []
    try:
        standing, neck, flight = Part(), Part(), Part()
        torso(standing)
        feet(standing)
        for side in (-1,1):
            wing(standing,side,False)
        head(neck)
        owned.append(standing.mesh(scene,'Perched'))
        owned.append(neck.mesh(scene,'Head',(.037,0,.127)))
        torso(flight)
        head(flight)
        feet(flight,True)
        owned.append(flight.mesh(scene,'Flying'))
        for side,name in [(-1,'WingRight'),(1,'WingLeft')]:
            w = Part()
            wing(w,side,True)
            owned.append(w.mesh(scene,name,(.029,side*.027,.144)))
        with bpy.context.temp_override(scene=scene,view_layer=scene.view_layers[0]):
            result = bpy.ops.export_scene.gltf(filepath=str(OUT),export_format='GLB',
                use_active_scene=True,export_animations=False,export_materials='NONE',
                export_vertex_color='ACTIVE',export_active_vertex_color_when_no_material=True,
                export_texcoords=False,export_cameras=False,export_lights=False,export_extras=False)
            if result != {'FINISHED'}:
                raise RuntimeError(f'Pigeon export failed: {result}')
    finally:
        for obj in owned:
            mesh = obj.data
            bpy.data.objects.remove(obj,do_unlink=True)
            bpy.data.meshes.remove(mesh)
        bpy.data.scenes.remove(scene)


if __name__ == '__main__':
    build()
