import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loftSections, strut, tint, type Point3 } from './vehicleFittings.ts';
import { SCALE } from './figures.ts';

// The contact points are those of the riding clips in assets/figures/build.py.
// Keep the saddle, grips, footrests and courier pack aligned with the overhead rig.
export function twoWheelerStreet(type: 'bike' | 'moto', base: THREE.BufferGeometry) {
  const moto = type === 'moto', parts = moto ? [] : [base];
  const paint = '#ffffff';
  const metal = '#a0a5a5', steel = '#63686a', rubber = '#282828', bronze = '#867257';
  function add(g: THREE.BufferGeometry, colour: string) {
    tint(g, colour);
    g.scale(SCALE, SCALE, SCALE);
    const count = g.attributes.position.count;
    g.setAttribute('painted', new THREE.Float32BufferAttribute(new Float32Array(count).fill(colour === paint ? 1 : 0), 1));
    parts.push(g);
  }
  const rod = (a: Point3, b: Point3, r: number, colour: string) => add(strut(a, b, r, 6), colour);
  const ring = (x: number, y: number, z: number, r: number, t: number, colour: string) =>
    add(new THREE.TorusGeometry(r, t, 6, 32).translate(x, y, z), colour);
  const box = (x: number, y: number, z: number, l: number, h: number, w: number, colour: string) =>
    add(new THREE.BoxGeometry(l, h, w).translate(x, y, z), colour);
  const y = moto ? .33 : .334, rim = moto ? .198 : .289;
  const rear = moto ? -.7 : -.52, front = moto ? .72 : .53;
  for (const x of [rear, front]) {
    ring(x, y, 0, rim, moto ? .025 : .009, metal);
    const spokes = moto ? 6 : 24;
    for (let i = 0; i < spokes; i++) {
      const a = i * Math.PI * 2 / spokes;
      const b = a + (i % 2 ? .42 : -.42);
      rod([x + Math.cos(b) * .046, y + Math.sin(b) * .046, (i % 2 ? 1 : -1) * .028],
        [x + Math.cos(a) * rim, y + Math.sin(a) * rim, 0], moto ? .017 : .003, steel);
    }
    if (moto) {
      ring(x, y, -.065, .127, .021, metal);
      box(x + .083, y + .085, -.071, .067, .075, .035, '#73574e');
    }
  }
  const driveZ = moto ? -.107 : .075, crank = moto ? -.12 : -.03, crankY = moto ? .45 : .30;
  ring(rear, y, driveZ, moto ? .104 : .056, .009, steel);
  ring(crank, crankY, driveZ, moto ? .06 : .088, .011, steel);
  for (const side of [-1, 1]) rod([rear, y + side * (moto ? .104 : .056), driveZ],
    [crank, crankY + side * (moto ? .06 : .088), driveZ], .007, rubber);
  if (moto) {
    // A naked roadster: frame rails tie the steering head to the swingarm pivot.
    // The saddle narrows against the tank at the rider's original hip position.
    add(loftSections([[-.18, .76, .055, .07], [-.10, .81, .10, .12], [.08, .86, .15, .18],
    [.25, .89, .15, .17], [.36, .87, .12, .11], [.41, .83, .055, .065]], 2.5), paint);
    add(loftSections([[-.78, .80, .03, .055], [-.66, .83, .065, .115], [-.48, .82, .055, .139],
    [-.30, .78, .045, .139], [-.15, .78, .040, .093], [-.09, .80, .026, .075]], 3.1), rubber);
    add(loftSections([[-.80, .76, .025, .052], [-.62, .77, .045, .125], [-.35, .70, .06, .11],
    [-.13, .69, .08, .095], [-.06, .72, .045, .07]], 2.4), paint);
    add(new THREE.CylinderGeometry(.045, .05, .012, 20).translate(.18, 1.022, 0), metal);
    for (const side of [-1, 1]) {
      const z = side * .103;
      rod([.40, .85, z * .58], [.04, .64, z], .027, steel);
      rod([.04, .64, z], [-.19, .49, z], .029, steel);
      rod([-.19, .49, z], [-.61, .76, z], .021, steel);
      rod([-.19, .49, z], [rear, y, z], .032, steel);
      rod([.40, .85, z * .58], [.26, .38, z], .023, steel);
      rod([.26, .38, z], [-.17, .37, z], .023, steel);
      rod([front, y, z], [.54, .82, z], .036, metal);
      rod([.54, .82, z], [.46, 1.00, z], .027, steel);
      rod([.45, .96, z], [.33, 1.02, side * .30], .016, metal);
      rod([.33, 1.02, side * .26], [.33, 1.02, side * .38], .022, rubber);
      rod([.35, 1.02, side * .26], [.39, 1.02, side * .36], .008, metal);
      rod([.34, 1.02, side * .25], [.41, 1.16, side * .35], .009, steel);
      add(new THREE.SphereGeometry(1, 14, 8).scale(.024, .048, .072).translate(.41, 1.16, side * .35), rubber);
      rod([-.12, .38, z], [-.12, .38, side * .22], .018, rubber);
    }
    for (const x of [rear, front]) {
      ring(x, y, 0, .267, .063, rubber);
      // A rolled rim, separate shoulders either side of the tyre.
      for (const side of [-1, 1]) ring(x, y, side * .032, .220, .012, metal);
      add(new THREE.CylinderGeometry(.070, .070, .17, 16).rotateX(Math.PI / 2).translate(x, y, 0), steel);
    }
    const fender = new THREE.TorusGeometry(.348, .018, 8, 28, Math.PI * .61);
    fender.scale(1, 1, 4.3).rotateZ(.52).translate(front, y, 0); add(fender, paint);
    add(loftSections([[-.24, .46, .069, .11], [-.14, .47, .112, .144], [.04, .46, .115, .14],
    [.18, .48, .088, .13], [.22, .51, .05, .11]], 2.6), steel);
    add(new THREE.CylinderGeometry(.102, .10, .035, 22).rotateX(Math.PI / 2).translate(-.10, .47, .145), metal);
    box(.05, .56, 0, .25, .21, .225, '#434644');
    add(loftSections([[.44, .93, .085, .065], [.51, .94, .126, .127], [.57, .94, .124, .13]], 2.3), rubber);
    add(new THREE.CylinderGeometry(.115, .122, .024, 24).rotateZ(-Math.PI / 2).translate(.577, .94, 0), metal);
    add(new THREE.SphereGeometry(1, 20, 12).scale(.025, .103, .103).translate(.59, .94, 0), '#e2dbb7');
    add(new THREE.CylinderGeometry(.078, .093, .06, 16).rotateZ(.35).translate(.43, 1.02, 0), rubber);
    box(-.78, .76, 0, .042, .05, .14, '#bd3d39');
    rod([.06, .25, -.15], [-.43, .34, -.18], .035, bronze);
    rod([-.43, .34, -.18], [-.79, .49, -.18], .067, metal);
    rod([-.76, .48, -.18], [-.803, .496, -.18], .041, rubber);
    for (let i = 0; i < 6; i++) box(.06, .44 + i * .036, 0, .31, .017, .285, steel);
    for (const z of [-.085, .085]) {
      rod([.18, .54, z], [.30, .34, z], .027, bronze);
      rod([.30, .34, z], [.08, .25, -.15], .026, bronze);
    }
    for (const z of [-.12, .12]) {
      rod([rear + .10, .36, z], [-.43, .73, z], .023, metal);
      rod([rear + .17, .45, z], [-.46, .68, z], .038, rubber);
      box(.55, .88, z * 1.75, .055, .045, .055, '#e49b3a');
    }
    box(-.81, .62, 0, .024, .13, .18, '#e4e2d5');
  } else {
    for (const z of [-.063, .063]) {
      rod([rear, y, z], [-.67, .536, z], .008, metal);
      rod([rear, y, z], [-.41, .536, z], .008, metal);
      rod([.37, 1.015, z * 3.6], [.405, .99, z * 2.65], .008, steel);
      rod([.405, .99, z * 2.65], [.43, .73, z * .6], .004, rubber);
    }
    box(-.71, .55, 0, .019, .046, .051, '#a42c2d');
    rod([-.12, .30, -.04], [-.23, .015, -.15], .009, steel);
  }
  return mergeGeometries(parts);
}
