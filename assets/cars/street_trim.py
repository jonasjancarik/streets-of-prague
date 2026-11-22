"""Close-view bumper mouldings, lamps and grilles for Streets of Prague cars.

The fittings trace the same outline as the body loft in build.py. Coordinates
are in metres, +x at the nose, +y on the driver's side and z up.
"""
import math

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree


class Panels:
    def __init__(self):
        self.points = []
        self.faces = []
        self.materials = []
        self.smooth = []

    def patch(self, material, cols, rows, position, outward, smooth=True):
        """A gridded panel with its front face towards the given direction."""
        start = len(self.points)
        for j in range(rows + 1):
            for i in range(cols + 1):
                self.points.append(Vector(position(i / cols, j / rows)))
        for j in range(rows):
            for i in range(cols):
                a = start + (cols + 1) * j + i
                b, c, d = a + 1, a + cols + 2, a + cols + 1
                # At the centre of an optic two corners coincide. The cross of
                # the diagonals still gives the winding of its nonzero triangle.
                n = (self.points[c] - self.points[a]).cross(self.points[d] - self.points[b])
                self.faces.append((a, b, c, d) if n.dot(outward) >= 0 else (a, d, c, b))
                self.materials.append(material)
                self.smooth.append(smooth)

    def build(self, name, material):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(self.points, [], self.faces)
        slots = list(dict.fromkeys(self.materials))
        for mat in slots:
            mesh.materials.append(material(mat))
        for face, mat, smooth in zip(mesh.polygons, self.materials, self.smooth):
            face.material_index = slots.index(mat)
            face.use_smooth = smooth
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj


def build_trim(name, shape, source, front_z, rear_z, material, materials):
    """Single badge-free front and rear assemblies, fitted to each car shell."""
    panels = Panels()
    formed = hasattr(source, "front_intakes")
    utility = name in ("van", "pickup")
    tall = name in ("suv", "van", "pickup")

    # Fit the hardware to the actual loft, including its roll into the bonnet.
    # The low-detail light blocks, tyres and bumpers must not be hit by these rays.
    source.bm.verts.index_update()
    verts = [v.co.copy() for v in source.bm.verts]
    faces = [[v.index for v in face.verts] for face in source.bm.faces
             if materials[face.material_index] in ("Paint", "Trim", "Blue", "Yellow")]
    skin = BVHTree.FromPolygons(verts, faces)
    head_mount = None

    def shell(end, side, u, z, proud):
        # The first part crosses the flat face. The rest turns round the
        # quarter ellipse into the wing, following the body generator.
        a, b = shape.nose if end > 0 else shape.tail
        edge = shape.half(end * shape.nb)
        straight = edge / (edge + math.pi * (a + b) / 4)
        angle = max(0., (u - straight) / (1 - straight)) * math.pi / 2
        x = end * (shape.nb - a * (1 - math.cos(angle)))
        y = edge * u / straight if u <= straight else shape.half(x)
        approximate = Vector((x, side * y, z))
        normal = Vector((end * math.cos(angle), side * math.sin(angle), .23)).normalized()
        ray = Vector((normal.x, normal.y, 0)).normalized() if formed else normal
        hit = skin.ray_cast(approximate + ray * .13, -ray, .36)[0]
        return (hit if hit is not None else approximate) + normal * proud

    def centre(end, half, bottom, top, mat, offset, taper=0):
        # A continuous inset or slat. Keep the mouth shaped at its ends.
        def pos(u, v):
            t = 2 * u - 1
            return (end * (shape.nb + offset), t * (half - taper * (1-v)),
                    bottom + v * (top-bottom) + .012 * t**4)
        panels.patch(mat, 12, 2, pos, Vector((end, 0, 0)))

    for end, height in ((1, front_z), (-1, rear_z)):
        # The bumper is painted through to the wheel arch. A narrower dark valance
        # runs along its lower edge, where a real moulding meets the undertray.
        low = shape.stations[0 if end > 0 else -1][3] + .006
        for side in (-1, 1):
            normal = Vector((end, side, .12))
            panels.patch("Trim" if formed else "RubStrip", 24, 2, lambda u, v: shell(end, side, u, low + v * .071, .012 if formed else .018), normal)
            if end > 0:
                first = .39 if utility else .41
                last = .92 if name == "hatch" else .97
                depth = .009
                # The inner edge meets the grille, the lens tapers upwards over
                # the outer wing. The glazing sits inside a black perimeter seal.
                def lens(u, v, offset):
                    reach = first + (last-first)*u
                    cap = height + (.050 if utility else .040) + (.13 if tall else .11)*u
                    thickness = (.196 if utility else .132) * (.82 + .20*math.sin(math.pi*u) - .32*u**4)
                    return shell(end, side, reach, cap - (1-v)*thickness, offset)
                panels.patch("RubStrip", 22, 5, lambda u,v: lens(u,v,depth), normal)
                # Return the perimeter into the painted wing. At a grazing angle
                # the far lamp is a fitted unit with a visible rim.
                for edge in (0., 1.):
                    panels.patch("RubStrip",18,1,lambda u,v:lens(u,edge,-.002+(depth+.002)*v),normal)
                    panels.patch("RubStrip",1,4,lambda u,v:lens(edge,v,-.002+(depth+.002)*u),normal)
                panels.patch("LensBed", 22, 5, lambda u,v: lens(.014+.967*u,.07+.86*v,depth+.005), normal)
                # Facets in the pressed reflector wells: they are dark around a
                # small lit centre and catch the light as the player walks past.
                if side == 1:
                    head_mount = list(lens(.38, .51, depth + .010))
                optics = ((.29, .235), (.67, .105)) if name in ("hatch","van") else ((.24,.177),(.59,.141))
                for mid, span in optics:
                    for k in range(12):
                        def facet(u,v):
                            angle = math.tau*(k+u)/12
                            r = .28+.69*v
                            return lens(mid+span*r*math.cos(angle), .52+.36*r*math.sin(angle),
                                        depth+.008+.011*v*v)
                        panels.patch(("Optic", "Metal", "LensBed", "Optic")[k%4],2,2,facet,normal,False)
                    def bulb(u,v):
                        a = math.tau*u
                        return lens(mid+span*.29*v*math.cos(a),.52+.36*.29*v*math.sin(a),depth+.022)
                    panels.patch("Lamp",12,2,bulb,normal)
                panels.patch("Lamp",18,1,lambda u,v:lens(.055+.72*u,.10+.061*v,depth+.010),normal)
                panels.patch("Indicator",5,2,lambda u,v:lens(.85+.094*u,.22+.53*v,depth+.011),normal)
            elif utility:
                # Tall rear combination light either side of a pair of van doors
                # or beside a pickup tailgate. Red surrounds a clear reverse lamp.
                def tail(u,v,offset):
                    return shell(end, side, .53+.23*u, height-.22+.48*v,offset)
                panels.patch("RubStrip",8,3,lambda u,v:tail(u,v,.024),normal)
                panels.patch("RedLens",8,3,lambda u,v:tail(.07+.86*u,.025+.95*v,.031),normal)
                for row in [.12,.69]:
                    panels.patch("Tail",6,1,lambda u,v:tail(.12+.74*u,row+.12*v,.036),normal)
                panels.patch("Optic",5,1,lambda u,v:tail(.12+.74*u,.46+.12*v,.035),normal)
            else:
                def tail(u,v,offset):
                    return shell(end,side,.34+.61*u,height-.09+.058*u+(.132-.052*u**3)*v,offset)
                panels.patch("RubStrip",18,3,lambda u,v:tail(u,v,.023),normal)
                panels.patch("RedLens",18,3,lambda u,v:tail(.02+.96*u,.07+.86*v,.030),normal)
                for row in [.19,.60]:
                    panels.patch("Tail",15,1,lambda u,v:tail(.07+.85*u,row+.085*v,.034),normal)
                panels.patch("Optic",4,1,lambda u,v:tail(.07+.17*u,.35+.14*v,.034),normal)

        if end > 0 and formed:
            source.front_intakes(panels, shell, height, low)
        elif end > 0:
            top = height + (.067 if utility else .039)
            half = shape.half(shape.nb) * (.82 if utility else .76)
            bottom = top - (.205 if utility else .138)
            centre(end,half+.018,bottom-.012,top+.009,"DarkChrome",.017,.054)
            centre(end,half,bottom,top,"RubStrip",.022,.054)
            for i in range(3 if utility else 2):
                z = bottom + (i+1)*(top-bottom)/(4 if utility else 3)
                centre(end,half-.012,z,z+.012,"DarkChrome",.026,.03)
            centre(end,shape.w*.52,low+.035,low+.115,"RubStrip",.026,.045)
        plate_z = height - (.18 if utility else .17) if end < 0 else low + .155
        if end < 0:
            centre(end, .28, plate_z+.075,plate_z+.104,"DarkChrome",.025,.016)
            centre(end, .092, plate_z+.081,plate_z+.100,"RubStrip",.026,.005)
            # Outline the boot lid or hatch where it returns above the rear bumper.
            for side in (-1, 1):
                def seam(u,v):
                    across = side*(shape.half(-shape.nb)*(.84-.18*u)+v*.009)
                    z = (height-.035)*(1-u)+(low+.155)*u
                    return (-shape.nb-.004,across,z)
                panels.patch("PanelGap",2,6,seam,Vector((-1,0,0)))
            centre(end,shape.half(-shape.nb)*.67,low+.152,low+.162,"PanelGap",.005,.004)
        # One flat mounting plinth clears the convex fascia, even at the lip of
        # the lower air intake. The glyph shader expects a planar plate face.
        plate_base = shape.nb + (.044 if formed else 0)
        if formed:
            panels.patch("Trim",8,3,lambda u,v:
                (end*(plate_base+.036*v),(.536-.012*v)*(u-.5),plate_z-.061),Vector((0,0,-1)))
        for half, high, offset, mat in ((.265,.064,.037,"RubStrip"),(.254,.055,.041,"Plate")):
            panels.patch(mat,1,1,lambda u,v: (end*(plate_base+offset),(2*u-1)*half,plate_z+(2*v-1)*high),Vector((end,0,0)))
        # Blue country strip on the reader's left. No manufacturer badges.
        panels.patch("EUBlue",1,1,lambda u,v:(end*(plate_base+.045),-end*(.215+.038*u),plate_z-.05+.10*v),Vector((end,0,0)))
    # Rubber blades sit on the lower windscreen. Sample the actual inset
    # panes so the tips follow the bowed glass rather than hovering above it.
    xa, xb, sill, header, half = source.screen_layout
    panes = [[v.index for v in f.verts] for f in source.bm.faces if materials[f.material_index] == "Window"]
    screen = BVHTree.FromPolygons(verts,panes)
    def glass_height(x,y):
        hit = screen.ray_cast(Vector((x,y,4)),Vector((0,0,-1)),5)[0]
        return hit.z if hit is not None else sill + (xa - x) / (xa - xb) * (header - sill)
    for start, end in ((.78*half,.035),(-.035,-.78*half)):
        def on_glass(x,y,offset):
            return (x,y,glass_height(x,y)+offset)
        def blade(u,v):
            return on_glass(xa-.095-.070*u+.012*v,start+(end-start)*u,.007)
        panels.patch("RubStrip",12,1,blade,Vector((.6,0,1)))
        # At its tip the arm meets the middle of the blade. Its pivot is on
        # the scuttle, a little to the side, keeping both bars nearly parallel.
        bx,by,_ = blade(.50,.50)
        pivot_x,pivot_y = xa-.037, start
        def arm(u,v):
            return on_glass(pivot_x+(bx-pivot_x)*u+.009*(v-.5),pivot_y+(by-pivot_y)*u,.014)
        panels.patch("RubStrip",10,1,arm,Vector((.6,0,1)))
    obj = panels.build(name+"_street_trim",material)
    obj["headlamp"] = head_mount
