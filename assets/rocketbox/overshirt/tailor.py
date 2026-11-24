"""Blender tailoring pass on the bind-pose body, in metres, Y up."""
import json
import math
import sys
from pathlib import Path

from mathutils import Matrix, Vector, geometry

src, dest = map(Path, sys.argv[sys.argv.index("--") + 1:])
data = json.loads(src.read_text())
positions = [Vector(p) for p in data["xyz"]]
normals = [Vector(n).normalized() for n in data["normal"]]
uvs = [Vector(uv) for uv in data["uv"]]
triangles = [data["faces"][i:i+3] for i in range(0, len(data["faces"]), 3)]


def smooth(a, b, v):
    t = min(1, max(0, (v-a)/(b-a)))
    return t*t*(3-2*t)


def reshape(p):
    x, y, z = p
    # Give the chinos a straighter fall from knee to hem and a little break over the shoe.
    leg = smooth(.071, .139, y) * (1-smooth(.42, .78, y))
    centre = math.copysign(.127 - .033*y, x)
    xx = x + (x-centre)*.16*leg
    zz = z + (z+.018)*.10*leg
    yy = y - .013*leg*(1-smooth(.16,.42,y))
    # Relax the side seams, drop the overshirt hem and ease the sleeves around the elbow.
    hem = (1-smooth(.16,.235,abs(x))) * smooth(.776,.835,y) * (1-smooth(.90,1.15,y))
    xx += x*.043*hem
    zz += (z-.012)*.055*hem
    yy -= .017*hem
    sleeve = smooth(.225,.32,abs(x))*(1-smooth(.525,.58,abs(x))) * smooth(1.01,1.12,y)
    zz += (z-.005)*.14*sleeve
    width = (y-(1.695-1.08*abs(x)))*.085*sleeve
    xx += math.copysign(1,x)*width
    yy += width
    # The old dress shoe tapers to a point. A rounder last also gives its sole room.
    toe = (1-smooth(.063,.135,y))*smooth(.005,.15,z)
    xx += (x-math.copysign(.14,x))*.095*toe
    zz -= .009*toe
    return Vector((xx,yy,zz))


fitted = [reshape(p) for p in positions]
# Transform normals with the inverse transpose of the local deformation. This keeps the
# donor's split shading at sewn edges without introducing cracks at UV seams.
for i, p in enumerate(positions):
    columns = [(reshape(p+axis*.0002)-reshape(p-axis*.0002))/.0004 for axis in
               (Vector((1,0,0)),Vector((0,1,0)),Vector((0,0,1)))]
    normals[i] = (Matrix(columns).inverted() @ normals[i]).normalized()


# The donor's standing collar has its own UV island. In the generated atlas that
# space is the tee's hem. Fit the collar lower and give it a continuous piece of
# the navy back panel, including the part the player sees below the nape.
links = [set() for _ in positions]
for a,b,c in triangles:
    links[a].update((b,c)); links[b].update((a,c)); links[c].update((a,b))


def island(seed):
    connected = set()
    pending = [seed]
    while pending:
        i = pending.pop()
        if i not in connected:
            connected.add(i)
            pending.extend(links[i] - connected)
    return connected


collar = island(max(range(len(positions)), key=lambda i: positions[i].y))
for i in collar:
    u,v = uvs[i]
    if not (.32 < u < .67 and .81 < v < .88):
        raise ValueError("Unexpected collar UV island")
    uvs[i] = Vector((.48+(u-.5)*.45, .29+(v-.84)*.7))
    p = fitted[i]
    back = 1-smooth(-.003,.073,p.z)
    rim = back*smooth(1.52,1.575,p.y)
    p.y -= .004*rim
    # Give the cloth clearance over the skinned neck as the head turns.
    outward = Vector((p.x,0,p.z-.014)).normalized()
    p += outward*(.007*rim)

def vertex(p, n, uv, bones):
    fitted.append(p.copy())
    normals.append(n.normalized())
    uvs.append(Vector(uv))
    weights = sorted(bones.items(), key=lambda pair: -pair[1])[:4]
    total = sum(w for _, w in weights)
    data["joints"].append(([j for j, _ in weights] + [0]*4)[:4])
    data["weights"].append(([w/total for _, w in weights] + [0]*4)[:4])
    return len(fitted)-1


def skin(i):
    return {j:w for j,w in zip(data["joints"][i],data["weights"][i]) if w}


# Cut the old button-up V out of the undershirt. Keep the back neck binding
# and the jersey below the sternum. Between them, the tee is one curved sheet.
jersey = island(990)
neck = island(1198)
open_v = {1200, 1202, 1203, 1204, 1205}
facing = set(range(1041,1055)) | set(range(1099,1113))
triangles = [tri for tri in triangles if not (
    (tri[0] in jersey and max(positions[i].y for i in tri) >= 1.38) or
    (tri[0] in neck and open_v.intersection(tri)) or
    (tri[0] in collar and facing.intersection(tri))
)]
for i in jersey:
    u, v = uvs[i]
    uvs[i] = Vector((.5 + (u-.5)*.10, .525 + (v-.48)*.75))
for i in neck:
    u, v = uvs[i]
    uvs[i] = Vector((.5 + (u-.5)*.20, .47 + (v-.45)*.35))

# The neckline follows the donor's original neck opening so it moves with the
# skin. The lower seam reuses the three vertices at the top of the existing tee.
neckline = [1222,1201,1199,1198,1206,1207,1209]
# The two corners of the former V dipped below the neck binding. Let the
# round neck follow the skin from its centre up towards either shoulder.
for i, side, front in [(1201,1222,1199), (1207,1209,1206)]:
    t = (fitted[i].x-fitted[side].x)/(fitted[front].x-fitted[side].x)
    fitted[i] = fitted[side].lerp(fitted[front], t)
hem = [1001,1001,1001,1002,1013,1013,1013]
tee_rows = [hem]
sources = sorted(jersey | neck)
columns = [-1.,-.79,-.46,0.,.46,.79,1.]
for height, width, depth, curve, v in [
    (1.374,.082,.121,.012,.565), (1.426,.085,.104,.020,.545),
    (1.463,.083,.085,.023,.525),
]:
    row = []
    for x in columns:
        point = Vector((width*x,height,depth-curve*x*x))
        nearest = min(sources, key=lambda i: (positions[i]-point).length_squared)
        row.append(vertex(point,Vector((0,0,1)),(.5+x*.015,v),skin(nearest)))
    tee_rows.append(row)
# Confine the narrow ribbing to the first few millimetres below the neck.
band = []
for column, i in enumerate(neckline):
    point = fitted[i].lerp(fitted[tee_rows[-1][column]], .19)
    band.append(vertex(point,normals[i],(.5+columns[column]*.015,.512),skin(i)))
tee_rows.extend([band, neckline])
tee_faces = []
for lower, upper in zip(tee_rows,tee_rows[1:]):
    for j in range(len(columns)-1):
        if lower[j] != lower[j+1]:
            tee_faces.append([lower[j],lower[j+1],upper[j]])
        tee_faces.append([lower[j+1],upper[j+1],upper[j]])
tee_normals = {i:Vector((0,0,0)) for row in tee_rows for i in row}
for tri in tee_faces + [t for t in triangles if t[0] in jersey or t[0] in neck]:
    a,b,c = (fitted[i] for i in tri)
    normal = (b-a).cross(c-a)
    for i in tri:
        if i in tee_normals:
            tee_normals[i] += normal
for i, normal in tee_normals.items():
    normals[i] = normal.normalized()
triangles.extend(tee_faces)


# On the donor, the front of each jacket panel folds back under a separate
# notched lapel. Sew a single layer across that opening, from the front panel
# to its lining, and keep the shirt collar above it. The seam landmarks below
# refer to the pinned LOD1 checked by build.mjs, ordered from hem to shoulder.
# Each inner seam carries the UVs for the right side of the fabric. The outer
# seam reuses the chest panel's vertices, stitch placement and skin weights.
front_seams = [
    ([558, 561, 563, 566, 568, 574, 578],
     [(588,.42394,.44152), (587,.42201,.44457), (581,.42496,.44419), (605,.42596,.44152),
      (606,.43615,.48226), (608,.43917,.51125), (609,.44717,.55135), (614,.45544,.58242)]),
    ([680, 682, 685, 687, 688, 691, 698, 702],
     [(721,.57606,.44152), (720,.57799,.44457), (705,.57504,.44419), (709,.56385,.48226),
      (711,.56083,.51125), (712,.55319,.54934), (785,.54456,.58242), (787,.54701,.58389)]),
]


def old_fold(tri, panel, lapel):
    if tri[0] in lapel:
        return True
    if tri[0] in panel:
        # The narrow return underneath the lapel faces back into the chest.
        a, b, c = (positions[i] for i in tri)
        centre = (a+b+c)/3
        return centre.y > 1.275 and centre.z > .026 and (b-a).cross(c-a).z < 0
    return False


def sew_normals(panel, patch, new_faces):
    # Smooth across UV splits on the outside, keeping the inside lining separate.
    sums = {tuple(fitted[i]): Vector((0,0,0)) for i in patch}
    for tri in [t for t in triangles if t[0] in panel] + new_faces:
        a, b, c = (fitted[i] for i in tri)
        area = (b-a).cross(c-a)
        for i in tri:
            key = tuple(fitted[i])
            if key in sums:
                sums[key] += area
    for i in [*panel, *patch]:
        total = sums.get(tuple(fitted[i]))
        if total is not None and total.length_squared:
            normals[i] = total.normalized()


for outer, inner in front_seams:
    panel = island(outer[0])
    lapel = island(inner[0][0])
    triangles = [tri for tri in triangles if not old_fold(tri, panel, lapel)]
    patch = outer + [vertex(fitted[i], normals[i], (u,v), skin(i)) for i,u,v in inner]
    # Unroll the shoulder towards the chest so the neckline triangulates in order.
    polygon = [Vector((fitted[i].x, fitted[i].y - .7*fitted[i].z, 0)) for i in patch]
    new_faces = []
    for ia, ib, ic in geometry.tessellate_polygon([polygon]):
        tri = [patch[ia], patch[ib], patch[ic]]
        a, b, c = (fitted[i] for i in tri)
        if (b-a).cross(c-a).z < 0:
            tri.reverse()
        new_faces.append(tri)

    sew_normals(panel, patch, new_faces)
    triangles.extend(new_faces)


# Finish the shoulder yoke at the base of the actual collar. The old outer
# collar also wrapped around the back and formed a second point in profile.
# Each row runs from the shoulder seam to the centre of the nape.
yoke = island(531) | island(558) | island(680)
for outer, inner in [
    ([586,589,591,593,597,599,601], [1061,1063,1063,1075,1075,1074,1078]),
    ([719,722,724,726,730,735,736], [1087,1085,1085,1083,1083,1081,1078]),
]:
    rows = []
    for seam in [outer, inner]:
        row = []
        for i in seam:
            p = fitted[i]
            row.append(vertex(p, normals[i], (.50+p.x*.58, .27+p.z*.6), skin(i)))
        rows.append(row)
    outside, inside = rows
    new_faces = []
    for j in range(len(outside)-1):
        for tri in [[outside[j], inside[j], inside[j+1]], [outside[j], inside[j+1], outside[j+1]]]:
            a,b,c = (fitted[i] for i in tri)
            area = (b-a).cross(c-a)
            if area.length_squared < 1e-16:
                continue
            if area.y < 0:
                tri.reverse()
            new_faces.append(tri)
    sew_normals(yoke, outside+inside, new_faces)
    triangles.extend(new_faces)


# Bevel the welt around each existing foot. Reuse the closest shoe vertex's ankle/toe
# weights so the forefoot flexes with the same contact animation.
for side in (-1, 1):
    ids = [i for i,p in enumerate(fitted[:len(positions)]) if p.y < .024 and p.x*side > 0]
    outline = [Vector((fitted[i].x,fitted[i].z)) for i in ids]
    hull = [ids[j] for j in geometry.convex_hull_2d(outline)]
    centre = sum((Vector((fitted[i].x,fitted[i].z)) for i in hull), Vector((0,0)))/len(hull)
    rows = []
    for h, width, ny, tex in [(.001,.0006,-.65,.984),(.004,.0043,-.16,.974),
                               (.019,.0050,.04,.953),(.029,.0015,.6,.940)]:
        row = []
        for i in hull:
            q = Vector((fitted[i].x,fitted[i].z))
            radial = (q-centre).normalized()
            q += radial*width
            lift = .009*smooth(.11,.19,q.y)
            row.append(vertex(Vector((q.x,h+lift,q.y)),Vector((radial.x,ny,radial.y)),
                              (.50+.014*radial.x,tex),skin(i)))
        rows.append(row)
    for lo,hi in zip(rows,rows[1:]):
        for j in range(len(hull)):
            k=(j+1)%len(hull)
            tris=[[lo[j],hi[j],hi[k]],[lo[j],hi[k],lo[k]]]
            for a,b,c in tris:
                if (fitted[b]-fitted[a]).cross(fitted[c]-fitted[a]).dot(normals[a])<0:
                    b,c=c,b
                triangles.append([a,b,c])

data.update(xyz=[list(p) for p in fitted], normal=[list(n) for n in normals],
            uv=[list(uv) for uv in uvs], faces=[i for tri in triangles for i in tri])
dest.write_text(json.dumps(data,separators=(",",":")))
