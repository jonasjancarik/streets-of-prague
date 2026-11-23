import * as THREE from 'three';
import { box, join, rod, slat, spun } from './furnitureModels.ts';

// All four chairs, the table and the parasol frame share the park furniture's
// timber atlas. Only the cloth takes the café's colour.
const enamel = '#414941', zinc = '#929085';
const timber = ['#b18c63', '#a98560', '#b99874', '#a68461', '#ae906c', '#ae8862'];

function foldingChair() {
  const parts: THREE.BufferGeometry[] = [];
  // Two scissor frames. The longer strap behind each front foot continues up
  // past the hinge, carrying the backrest. The seat boards rest on side rails.
  for (const x of [-.176, .176]) {
    const strap = (z1: number, y1: number, z2: number, y2: number, inset = 0) => {
      const length = Math.hypot(z2 - z1, y2 - y1);
      return box(.013, length, .026, 0, 0, 0, enamel)
        .rotateX(Math.atan2(z2 - z1, y2 - y1)).translate(x + inset, (y1+y2)/2, (z1+z2)/2);
    };
    parts.push(strap(-.215, .012, .151, .47), strap(.151, .47, .225, .83),
      strap(.211, .012, -.175, .445, -Math.sign(x)*.015),
      box(.022, .025, .355, x, .434, -.005, enamel),
      rod([x, .246, -.023], [x + Math.sign(x)*.012, .246, -.023], .016, 8, zinc));
  }
  for (const [y, z] of [[.135, .11], [.414, -.153]]) {
    parts.push(rod([-.17, y, z], [.17, y, z], .009, 6, enamel));
  }
  for (let i = 0; i < 5; i++) {
    const z = (i-2)*.077;
    parts.push(slat(.415, .021, .066, timber[i], i).translate(0, .461 + .012*(z/.16)**2, z));
  }
  for (let i = 0; i < 2; i++) {
    parts.push(slat(.424, .078, .021, timber[4-i], i+4).rotateX(.16).translate(0, .688 + i*.093, .182 + i*.015));
  }
  return join(parts);
}

export function terraceFurniture() {
  const parts: THREE.BufferGeometry[] = [];
  const chair = foldingChair();
  // Leave a passage between neighbouring settings. One chair is pulled back
  // slightly, so the four backs don't read as an exact radial pattern.
  for (const [x, z, angle] of [[1.19, .05, 1.43], [-.23, .46, -.96], [.51, .79, .09], [.45, -.73, 3.04]]) {
    parts.push(chair.clone().rotateY(angle).translate(x, 0, z));
  }
  chair.dispose();

  const tx = .48;
  for (let i = 0; i < 6; i++) {
    parts.push(slat(.765, .032, .12, timber[i], i).translate(tx, .749, (i-2.5)*.128));
  }
  for (const x of [-.23, .23]) parts.push(box(.039, .032, .70, tx+x, .722, 0, enamel));
  parts.push(spun([[.022,.035],[.078,.061],[.068,.10],[.049,.131],[.039,.19],
    [.039,.62],[.051,.66],[.054,.693],[.14,.707],[.14,.721]], 12, enamel).translate(tx,0,0));
  for (let i = 0; i < 4; i++) {
    const foot = box(.052, .039, .48, 0, .039, .19, enamel).rotateY(Math.PI/4 + i*Math.PI/2);
    parts.push(foot.translate(tx,0,0));
  }

  // Parasol on its own weighted shoe, behind the table. Its eight ribs and
  // opening stretchers meet the underside of the canvas at the stitched seams.
  const mast = 0;
  parts.push(box(.44, .056, .44, mast, .028, 0, '#65655d'),
    rod([mast, .05, 0], [mast, 2.77, 0], .026, 10, '#867961'),
    rod([mast, 2.22, 0], [mast, 2.28, 0], .044, 10, enamel),
    rod([mast, 2.75, 0], [mast, 2.793, 0], .041, 10, '#746c5b'));
  const corners = [[1.35,1.35],[0,1.35],[-1.35,1.35],[-1.35,0],[-1.35,-1.35],[0,-1.35],[1.35,-1.35],[1.35,0]];
  const clothPos: number[] = [], clothTone: number[] = [];
  const tr = (a: number[], b: number[], c: number[], shades: number[]) => {
    clothPos.push(...a,...c,...b);
    for (const s of [shades[0], shades[2], shades[1]]) clothTone.push(s,s,s);
  };
  for (let i = 0; i < 8; i++) {
    const [x,z] = corners[i], [xx,zz] = corners[(i+1)%8];
    // Between stitched seams the cloth bellies below the ribs. The hem hangs
    // a little lower midway between its supported points.
    const a = [x,2.35,z], b = [xx,2.35,zz], mid = [(x+xx)/2,2.32,(z+zz)/2];
    const top = [mast,2.765,0];
    const seam = [(mast+x)/2,2.574,z/2], seamB = [(mast+xx)/2,2.574,zz/2];
    const belly = [(mast+mid[0])/2,2.55,mid[2]/2];
    tr(top,seam,belly,[.95,1,.95]); tr(top,belly,seamB,[.95,.95,1]);
    tr(seam,a,mid,[1,.975,.94]); tr(seam,mid,belly,[1,.94,.95]);
    tr(belly,mid,b,[.95,.94,.975]); tr(belly,b,seamB,[.95,.975,1]);
    for (const [p,q] of [[a,mid],[mid,b]]) {
      const lowP = [p[0],p[1]-.098,p[2]], lowQ = [q[0],q[1]-.098,q[2]];
      tr(p,lowP,lowQ,[.86,.79,.79]); tr(p,lowQ,q,[.86,.79,.86]);
    }
    parts.push(rod([mast,2.744,0],[seam[0],2.555,seam[2]],.012,6,zinc),
      rod([seam[0],2.555,seam[2]],[x,2.338,z],.011,6,zinc,.008),
      rod([mast,2.257,0],[seam[0],2.544,seam[2]],.009,6,zinc));
  }
  const cloth = new THREE.BufferGeometry();
  cloth.setAttribute('position', new THREE.Float32BufferAttribute(clothPos,3));
  cloth.setAttribute('color', new THREE.Float32BufferAttribute(clothTone,3));
  cloth.computeVertexNormals();
  return { furniture: join(parts), cloth };
}
