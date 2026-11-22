import * as THREE from 'three';
import { pane, strut, type Point3 } from './vehicleFittings.ts';

interface Builder {
  setSeat(x: number, pelvis: number, z: number, roof: number): void;
  add(g: THREE.BufferGeometry, colour: string, x: number, y: number, z: number): void;
  box(colour: string, x0: number, x1: number, y0: number, y1: number, width: number, z?: number): void;
}
const rubber = '#303232', upholstery = '#545962', glass = '#25343e', metal = '#929799';

function drivingPosition({ add, box, setSeat }: Builder, x: number, y: number, z: number, front: number, roof: number) {
  setSeat(x, y + .10, z, roof);
  box('#343738', x - .25, x + .22, y - .23, y, .42, z);
  box(upholstery, x - .26, x + .22, y, y + .10, .47, z);
  add(new THREE.BoxGeometry(.11, .53, .46).rotateZ(.12), upholstery, x - .24, y + .30, z);
  box(upholstery, x - .32, x - .19, y + .54, y + .70, .29, z);
  const hub: Point3 = [x + .4, y + .37, z];
  add(strut([x + .62, y + .14, z], hub, .045), rubber, 0, 0, 0);
  const wheel = new THREE.TorusGeometry(.18, .018, 7, 28).rotateY(Math.PI / 2).rotateZ(-.60);
  add(wheel, rubber, ...hub);
  for (const side of [-1, 1]) add(strut(hub, [hub[0], hub[1], z + side * .17], .014), rubber, 0, 0, 0);
  box(rubber, x + .56, front, y + .14, y + .27, .77, z);
  add(new THREE.BoxGeometry(.075, .16, .39).rotateZ(-.27), '#464a4b', x + .57, y + .31, z);
  for (const side of [-1, 1]) {
    add(new THREE.CircleGeometry(.054, 16).rotateY(-Math.PI / 2), '#1a2023', x + .51, y + .31, z + side * .083);
  }
}

// The cargo bodies, mirrors, lamps and cab pillars come from the ordinary lorry.
// Fit four individual panes between them so the view through the cab has depth.
export function commercialCab(builder: Builder, back: number, nose: number, width: number,
  sill: number, top: number, rake: number) {
  const { add, box } = builder, z = width / 2, front = nose - rake;
  add(pane([nose, sill, -z], [front, top, -z], [front, top, z], [nose, sill, z]), glass, 0, 0, 0);
  for (const side of [-1, 1]) {
    const edge = side * z;
    add(pane([back, sill, edge], [nose, sill, edge], [front, top, edge], [back, top, edge]), glass, 0, 0, 0);
    box('#4a5053', back + .08, nose - .12, sill, sill + .055, .10, edge - side * .04);
    add(strut([nose + .012, sill + .02, side * .79], [nose - .07, sill + .26, side * .27], .014), rubber, 0, 0, 0);
    add(strut([nose - .07, sill + .26, side * .27], [nose - .13, sill + .46, side * .70], .018), rubber, 0, 0, 0);
    if (side > 0) {
      box(upholstery, nose - 1.31, nose - .86, sill, sill + .11, .48, .55);
      box(upholstery, nose - 1.31, nose - 1.19, sill + .07, sill + .61, .46, .55);
    }
  }
  box('#515252', back, back + .08, sill, top, width);
  drivingPosition(builder, nose - 1.03, sill + .035, -width * .25, nose - .06, top);
}

export function busCabin(builder: Builder, L: number, W: number, small: boolean,
  sill: number, top: number, doors: number[], red: string) {
  const { add, box } = builder, z = W / 2 - .035, front = L - .055, rear = -L + .065;
  const rail = '#e5b43a', shell = '#c0bdb6', seat = '#a03e42';
  const glassAt = (a: Point3, b: Point3, c: Point3, d: Point3) => add(pane(a, b, c, d), glass, 0, 0, 0);
  box('#555654', rear, front, .38, .48, W - .08);
  box(red, rear, rear + .075, .48, sill, W - .18);
  box(red, front - .08, front, .48, sill, W - .18);
  glassAt([front, sill, -z + .10], [front, top, -z + .10], [front, top, z - .10], [front, sill, z - .10]);
  glassAt([rear, sill, z - .10], [rear, top, z - .10], [rear, top, -z + .10], [rear, sill, -z + .10]);
  for (const side of [-1, 1]) {
    const edge = side * z, inside = side * (z - .39);
    // Fit each panel between door openings. A full-width block here would hide the aisle.
    const ends = side < 0 ? [] : [...doors].sort((a, b) => a - b);
    let start = rear;
    for (const end of [...ends.map(d => d - .63), front]) {
      const skirt = new THREE.Shape();
      const axles = [-L + (small ? 1.7 : 3.3), L - (small ? 1.3 : 2.7)];
      const lowerEdge = (x: number) => {
        const dx = Math.min(...axles.map(axle => Math.abs(axle - x)));
        return dx < .56 ? .50 + Math.sqrt(.56 ** 2 - dx ** 2) : .46;
      };
      skirt.moveTo(start, sill);
      skirt.lineTo(start, lowerEdge(start));
      for (const axle of axles) {
        for (let i = 0; i <= 20; i++) {
          const angle = Math.PI * (1 - i / 20), x = axle + .56 * Math.cos(angle);
          if (x > start && x < end) skirt.lineTo(x, .50 + .56 * Math.sin(angle));
        }
      }
      skirt.lineTo(end, lowerEdge(end));
      skirt.lineTo(end, sill);
      skirt.closePath();
      add(new THREE.ExtrudeGeometry(skirt, { depth: .075, bevelEnabled: false }), red, 0, 0, edge - .0375);
      glassAt([start, sill, edge], [end, sill, edge], [end, top, edge], [start, top, edge]);
      const bays = Math.ceil((end - start) / 1.5);
      for (let i = 0; i <= bays; i++) {
        const x = start + (end - start) * i / bays;
        box(rubber, x - .03, x + .03, sill, top, .086, edge);
      }
      start = end + 1.26;
    }
    box(rail, rear + .35, front - 1.3, top - .14, top - .105, .035, inside);
    for (let x = rear + .54; x < front - 1.55; x += small ? .83 : .91) {
      if (side > 0 && doors.some(d => Math.abs(x - d) < .9)) continue;
      const seatY = x < rear + 2 || Math.abs(x - (L - (small ? 1.3 : 2.7))) < .65 ? .99 : .86;
      box(metal, x - .10, x + .09, .48, seatY, .095, inside);
      box(seat, x - .20, x + .22, seatY, seatY + .085, .51, inside);
      add(new THREE.BoxGeometry(.08, .55, .50).rotateZ(.10), shell, x - .21, seatY + .27, inside);
      add(new THREE.BoxGeometry(.05, .43, .44).rotateZ(.10), seat, x - .16, seatY + .27, inside);
    }
    for (const x of [rear + .35, 0, front - 1.4]) add(strut([x, .48, inside], [x, top - .10, inside], .023), rail, 0, 0, 0);
    const lensZ = side * (W / 2 - .5);
    box('#44494b', L - .04, L + .024, .52, .76, .53, lensZ);
    box('#d49341', L + .025, L + .032, .56, .70, .09, lensZ + side * .215);
    // The corner posts turn the glazing back to the front and rear faces.
    for (const x of [rear, front]) box(red, x - .045, x + .045, sill, top, .18, side * (z - .055));
    const arm = L - .34;
    add(strut([arm, top - .05, edge], [arm + .11, top - .14, edge + side * .23], .027), rubber, 0, 0, 0);
    box(rubber, arm + .035, arm + .16, top - .46, top - .12, .15, edge + side * .23);
    box(metal, arm + .027, arm + .037, top - .42, top - .15, .12, edge + side * .23);
    add(strut([front + .012, sill + .02, side * .68], [front + .012, sill + .39, side * .22], .016), rubber, 0, 0, 0);
    add(strut([front + .014, sill + .39, side * .22], [front + .014, sill + .5, side * .86], .021), rubber, 0, 0, 0);
  }
  for (const d of doors) {
    for (const dx of [-.62, 0, .62]) box(rubber, d + dx - .025, d + dx + .025, .42, top, .075, z);
    glassAt([d - .6, .46, z], [d + .6, .46, z], [d + .6, top - .04, z], [d - .6, top - .04, z]);
    box('#d5a62e', d - .62, d + .62, .44, .48, .12, z - .06);
    box(rubber, d - .61, d + .61, .98, 1.02, .06, z);
  }
  drivingPosition(builder, L - 1.07, 1.00, -W * .25, L - .10, top);
}
