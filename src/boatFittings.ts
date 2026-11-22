import * as THREE from 'three';
import { loftSections, pane, strut, type Point3 } from './vehicleFittings.ts';

type Surface = (g: THREE.BufferGeometry, colour: string, glow?: number) => void;
type Box = (l: number, h: number, w: number, x: number, y: number, z: number, colour: string, glow?: number) => void;

export function passengerVessel(kind: 'cruise' | 'ferry', beam: number, add: Surface, box: Box) {
  const cruise = kind === 'cruise', deck = cruise ? 1.56 : 1.10;
  const metal = '#aeb7b5', rail = '#778a8f', trim = '#eae7df', wood = '#916648';
  const rod = (a: Point3, b: Point3, r: number, colour = metal) => add(strut(a, b, r), colour);
  // Sash posts and glazing enclose a real saloon. Leave the forward ferry deck
  // open under its awning and give the longer cruiser a separate wheelhouse.
  const cabin = (aft: number, fore: number, z: number, sill: number, top: number, bays: number) => {
    box(fore - aft, sill - deck, z * 2, (aft + fore) / 2, (sill + deck) / 2, 0, trim);
    for (const side of [-1, 1]) {
      const edge = side * z;
      add(pane([aft, sill, edge], [fore, sill, edge], [fore, top, edge], [aft, top, edge]), '#526672');
      for (let i = 0; i <= bays; i++) {
        const x = aft + (fore - aft) * i / bays;
        box(.085, top - sill, .085, x, (top + sill) / 2, edge, trim);
      }
    }
    for (const x of [aft, fore]) {
      add(pane([x, sill, -z], [x, top, -z], [x, top, z], [x, sill, z]), '#526672');
      box(.075, top - sill, .085, x, (top + sill) / 2, 0, trim);
    }
    box(fore - aft, .13, z * 2 + .08, (aft + fore) / 2, top, 0, trim);
    box(fore - aft - .24, .025, .16, (aft + fore) / 2, top - .075, 0, '#e2dac2', 1);
  };
  const bench = (x: number, y: number, z: number, w: number) => {
    for (const side of [-1, 1]) box(.16, .30, .065, x, y + .15, z + side * w * .35, rail);
    for (const dx of [-.12, 0, .12]) box(.10, .05, w, x + dx, y + .32, z, wood);
    box(.065, .17, w, x - .17, y + .45, z, wood);
  };
  if (cruise) {
    cabin(-12.88, 8.88, 2.70, 2.02, 3.32, 12);
    cabin(8.95, 11.7, 1.58, 2.05, 3.12, 2);
    for (let x = -11.8; x < 8.3; x += 2.5) for (const z of [-1.83, 1.83]) {
      bench(x, deck + .14, z, 1.05);
      box(.52, .07, .75, x + .48, deck + .68, z, '#d4c6ac');
    }
    // Low rails fold down under the bridges. Stanchions leave open gaps.
    for (const side of [-1, 1]) {
      const z = side * (beam / 2 - .42);
      for (let x = -13; x <= 9; x += 2) rod([x, 3.46, z], [x, 3.71, z], .028);
      rod([-13, 3.71, z], [9, 3.71, z], .037);
      for (let x = -10; x < 8; x += 3.3) {
        box(.9, .09, .40, x, 3.56, side * 1.10, wood);
        box(.10, .23, .40, x - .40, 3.61, side * 1.10, wood);
      }
    }
  } else {
    cabin(-4.4, -.80, (beam - .70) / 2, 1.86, 2.98, 3);
    for (const z of [-1, 1]) for (const x of [.45, 1.65]) bench(x, deck, z, .73);
  }
  const fore = cruise ? 11.7 : -.80;
  box(.33, .24, .94, fore - .38, deck + .61, -.25, '#3d474a');
  add(new THREE.TorusGeometry(.16, .022, 7, 16).rotateY(Math.PI / 2).translate(fore - .61, deck + .66, -.25), wood);
  for (const side of [-1, 1]) {
    const x = cruise ? 6.6 : -2.2, z = side * (cruise ? 2.78 : (beam - .7) / 2 + .08);
    const y = cruise ? 2.26 : 1.87;
    add(new THREE.TorusGeometry(.24, .070, 8, 24).translate(x, y, z), '#de6037');
    for (const dx of [-.24, .24]) box(.075, .12, .14, x + dx, y, z, trim);
    for (const x of (cruise ? [-10, 0, 10] : [-3.5, 2.2])) {
      const z = side * (beam / 2 - .055);
      rod([x, .60, z], [x + .10, cruise ? 1.42 : .98, z], .09, '#3e4446');
    }
  }
}

export function pedalFittings(swan: boolean, add: Surface, box: Box) {
  const metal = '#888e90', rubber = '#333a3e';
  for (const z of [-.35, .35]) {
    if (!swan) {
      const seat = loftSections([[-.73, .75, .22, .16], [-.64, .72, .22, .215],
      [-.54, .56, .09, .22], [-.32, .54, .064, .22], [-.16, .56, .065, .18]], 3.3);
      add(seat.translate(0, 0, z), '#54616b');
    }
    for (const side of [-1, 1]) {
      const end: Point3 = [.20 + side * .11, .60 + side * .07, z + side * .125];
      add(strut([.20, .60, z + side * .105], end, .015), metal);
      box(.12, .035, .085, ...end, rubber);
    }
    add(strut([.20, .60, z - .12], [.20, .60, z + .12], .024), metal);
  }
  add(strut([-.21, .48, 0], [.01, .84, 0], .025), metal);
  box(.13, .045, .06, .01, .84, 0, rubber);
  if (!swan) for (const z of [-.70, .70]) {
    add(strut([-.98, .48, z], [-.67, 1.57, z], .022), metal);
    add(strut([.07, .48, z], [-.43, 1.57, z], .022), metal);
  }
}
