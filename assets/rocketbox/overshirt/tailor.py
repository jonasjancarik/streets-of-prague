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
collar = set()
pending = [max(range(len(positions)), key=lambda i: positions[i].y)]
while pending:
    i = pending.pop()
    if i not in collar:
        collar.add(i)
        pending.extend(links[i] - collar)
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
