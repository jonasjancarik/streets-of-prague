"""Hardware fitted to the real outer and inner faces of a hinged car door."""
import math
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def fit_door(door, faces, hinge, side, belt, mirror, materials):
    vertices = list({v for face in faces for v in face.verts})
    indices = {v: i for i, v in enumerate(vertices)}
    skin = BVHTree.FromPolygons([v.co for v in vertices], [[indices[v] for v in f.verts] for f in faces])
    left = min(v.co.x for v in vertices)
    right = max(v.co.x for v in vertices)
    width = right-left

    def at(x, z, offset):
        hit = skin.ray_cast(Vector((x,side*2,z)),Vector((0,-side,0)),3)[0]
        y = hit.y if hit is not None else hinge.y
        return Vector((x,y+side*offset,z))

    def poly(points, mat, out):
        f = door.faces.new([door.verts.new(p-hinge) for p in points])
        f.material_index = materials.index(mat)
        f.normal_update()
        if f.normal.dot(Vector(out)) < 0:
            f.normal_flip()

    def fitting(x, z, shape, rings, face_mat, edge_mat, inside=False):
        # Each ring is a scale and depth. The bevel is visible from above
        # and the pull projects far enough to catch light from the pavement.
        rows = [[at(x+dx*scale,z+dz*scale,offset) for dx,dz in shape] for scale,offset in rings]
        for a,b in zip(rows,rows[1:]):
            for i in range(len(shape)):
                j = (i+1)%len(shape)
                dx, dz = shape[i]
                poly([a[i],a[j],b[j],b[i]],edge_mat,(dx,0,dz))
        poly(rows[-1],face_mat,(0,-side if inside else side,0))

    outline = [(-.083,-.009),(-.069,-.021),(.063,-.021),(.085,-.011),
               (.086,.009),(.067,.019),(-.066,.019),(-.083,.009)]
    handle_x,handle_z = left+min(.16,width*.25),belt-.118
    fitting(handle_x,handle_z,outline,[(1.05,.003),(1.14,.008)],"DoorSeam","DoorTrim")
    fitting(handle_x,handle_z+.007,outline,[(.91,.009),(.98,.025),(.88,.033)],"DoorPaint","DoorTrim")
    # Inner armrest and the short latch above it, on the lining that swings out.
    pad = [(-.16,-.019),(-.13,-.04),(.12,-.035),(.17,-.011),(.14,.026),(-.14,.032)]
    fitting((left+right)*.5,belt-.23,pad,[(1,-.037),(.96,-.084),(.88,-.095)],"DoorTrim","DoorTrim",True)
    fitting(right-min(.24,width*.29),belt-.12,outline,[(.73,-.037),(.68,-.057)],"DoorBright","DoorTrim",True)

    # A narrow shut line is visible against the body paint. The original
    # face remains load-bearing for hinge bounds and gameplay clearance.
    moved = set(faces)
    for f in faces:
        f.normal_update()
        if f.normal.y*side < .5 or f.material_index != materials.index('Paint'):
            continue
        centre = f.calc_center_median()
        for e in f.edges:
            if all(n in moved for n in e.link_faces) and len(e.link_faces)>1:
                continue
            p,q = (v.co.copy() for v in e.verts)
            if max(p.z,q.z) > belt+.02 or (q-p).length < .07:
                continue
            along = (q-p).normalized()
            interior = centre-(p+q)*.5
            inward = interior - along*interior.dot(along)
            if inward.length < .0001:
                continue
            p += f.normal*.0025; q += f.normal*.0025
            strip = inward.normalized()*.009
            poly([p,q,q+strip,p+strip],"DoorSeam",f.normal)

    if not mirror:
        return
    x,w,z = mirror
    base = at(x-.065,belt-.040,-.009)
    mid = Vector((x-.023,side*(w+.088),z+.004))
    joint = mid + Vector((.013,-side*.067,-.010))
    # The cast stem rises from the door skin below the glass; the top of the
    # raked A-pillar is substantially narrower than the body at this point.
    rows = []
    for origin, wide, high in ((base,.055,.037),(base.lerp(joint,.48),.035,.030),(joint,.032,.025)):
        rows.append([origin+Vector((wide*math.cos(math.tau*i/12),0,high*math.sin(math.tau*i/12))) for i in range(12)])
    for a,b in zip(rows,rows[1:]):
        for i in range(12):
            j=(i+1)%12
            out=(a[i]+a[j])*.5-sum(a,Vector())/len(a)
            poly([a[i],a[j],b[j],b[i]],"DoorTrim",out)

    # Rounded housing and the rear-facing reflective surface.
    stations = [(.068,.034,.031),(.054,.071,.049),(.017,.098,.058),(-.042,.102,.057),
                (-.066,.096,.052),(-.073,.085,.043)]
    rows = []
    for d, a, b in stations:
        row = []
        for i in range(16):
            theta=math.tau*i/16
            c,s=math.cos(theta),math.sin(theta)
            wide=a*math.copysign(abs(c)**.78,c); high=b*math.copysign(abs(s)**.78,s)
            v=(d,wide,high)
            row.append(mid+Vector(v))
        rows.append(row)
    for k,(a,b) in enumerate(zip(rows,rows[1:])):
        for i in range(16):
            j=(i+1)%16
            out=(a[i]+a[j]+b[i]+b[j])*.25-mid
            mat="DoorPaint" if k<4 and (a[i].z+a[j].z)*.5>mid.z-.017 else "DoorTrim"
            poly([a[i],a[j],b[j],b[i]],mat,out)
    poly(rows[0],"DoorPaint",(1,0,0))
    poly(rows[-1],"DoorMirror",(-1,0,0))
