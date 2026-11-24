import * as THREE from 'three';
import { loftSections, pane, strut, type Point3 } from './vehicleFittings.ts';

type Surface = (g: THREE.BufferGeometry, colour: string, glow?: number) => void;
type Box = (l: number, h: number, w: number, x: number, y: number, z: number, colour: string, glow?: number) => void;

// The distant saloon has painted panes in the same twelve bays as the near
// saloon. Its night reflection keeps the interruptions from the sash posts.
export function distantCruiseFittings(add: Surface) {
  const quad = (a: Point3,b: Point3,c: Point3,d: Point3,colour: string,glow=0) => {
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute([...a,...b,...c,...a,...c,...d],3));
    add(g,colour,glow);
  };
  const level=[.14,.22,.12,.065,.20,.17];
  for (const side of [-1,1]) for (let bay=0;bay<12;bay++) {
    const x=-12.88+bay*1.8133+.09, z=side*2.709, next=x+1.63;
    const a=side>0 ? x : next, b=side>0 ? next : x;
    quad([a,2.05,z],[b,2.05,z],[b,3.20,z],[a,3.20,z],'#45565b',level[bay%level.length]);
  }
  for (const end of [-1,1]) for (const side of [-1,1]) {
    const x=-2+end*10.89,z=side*1.28,a=z-end*1.17,b=z+end*1.17;
    quad([x,2.05,a],[x,3.20,a],[x,3.20,b],[x,2.05,b],'#45565b',.13);
  }
  // From above the roof benches need only the seat and its two long faces.
  for (let i=0;i<6;i++) {
    const a=-12.6+i*3.6,b=a+1.2;
    quad([a,3.59,.25],[b,3.59,.25],[b,3.59,-.25],[a,3.59,-.25],'#3d6f9a');
    for (const side of [-1,1]) {
      const x=side>0?a:b,end=side>0?b:a,z=side*.25;
      quad([x,3.51,z],[end,3.51,z],[end,3.59,z],[x,3.59,z],'#3d6f9a');
    }
  }
}

export function passengerVessel(kind: 'cruise' | 'ferry', beam: number, add: Surface, box: Box) {
  const cruise = kind === 'cruise', deck = cruise ? 1.56 : 1.10;
  const metal = '#aeb7b5', rail = '#778a8f', trim = '#eae7df', wood = '#916648';
  const rod = (a: Point3, b: Point3, r: number, colour = metal) => add(strut(a, b, r, 6, true), colour);
  // Sash posts and glazing enclose a real saloon. Leave the forward ferry deck
  // open under its awning and give the longer cruiser a separate wheelhouse.
  const cabin = (aft: number, fore: number, z: number, sill: number, top: number, bays: number, rake=0) => {
    box(fore - aft, sill - deck, z * 2, (aft + fore) / 2, (sill + deck) / 2, 0, trim);
    for (const side of [-1, 1]) {
      const edge = side * z;
      add(pane([aft, sill, edge], [fore, sill, edge], [fore-rake, top, edge], [aft, top, edge]), '#526672');
      if (cruise) box(fore-aft,.075,.088,(aft+fore)/2,sill-.055,edge,'#637676');
      for (let i = 0; i <= bays; i++) {
        const x = aft + (fore - aft) * i / bays;
        if (rake && i===bays) rod([x,sill,edge],[x-rake,top,edge],.047,trim);
        else box(.085, top - sill, .085, x, (top + sill) / 2, edge, trim);
      }
    }
    for (const x of [aft, fore]) {
      const upper=x===fore?x-rake:x;
      add(pane([x, sill, -z], [upper, top, -z], [upper, top, z], [x, sill, z]), '#526672');
      if (upper===x) box(.075, top - sill, .085, x, (top + sill) / 2, 0, trim);
      else {
        rod([x,sill,0],[upper,top,0],.043,trim);
        for (const side of [-1,1]) {
          const base: Point3=[x-rake*.08+.03,sill+.08,side*.65];
          const arm: Point3=[x-rake*.53+.03,sill+(top-sill)*.53,side*.86];
          rod(base,arm,.012,'#384246');
          rod([arm[0],arm[1],arm[2]-.19],[arm[0],arm[1],arm[2]+.19],.016,'#384246');
        }
      }
    }
    box(fore - rake - aft, .13, z * 2 + .08, (aft + fore-rake) / 2, top, 0, trim);
    box(fore - aft - .24, .025, .16, (aft + fore) / 2, top - .075, 0, '#e2dac2', 1);
  };
  const bench = (x: number, y: number, z: number, w: number) => {
    for (const side of [-1, 1]) box(.16, .30, .065, x, y + .15, z + side * w * .35, rail);
    for (const dx of [-.12, 0, .12]) box(.10, .05, w, x + dx, y + .32, z, wood);
    box(.065, .17, w, x - .17, y + .45, z, wood);
  };
  if (cruise) {
    cabin(-12.88, 8.88, 2.70, 2.02, 3.32, 12);
    cabin(8.95, 11.7, 1.58, 2.05, 3.12, 2,.31);
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
  add(new THREE.TorusGeometry(.16, .022, 6, 14).rotateY(Math.PI / 2).translate(fore - .61, deck + .66, -.25), wood);
  for (const side of [-1, 1]) {
    const x = cruise ? 6.6 : -2.2, z = side * (cruise ? 2.78 : (beam - .7) / 2 + .08);
    const y = cruise ? 2.26 : 1.87;
    const ring=new THREE.TorusGeometry(.24,.064,6,24).toNonIndexed();
    const pos=ring.attributes.position, colours=new Float32Array(pos.count*3);
    const orange=new THREE.Color('#d65c32'), tape=new THREE.Color('#e8e5d3');
    for (let i=0;i<pos.count;i+=3) {
      const a=Math.atan2(pos.getY(i)+pos.getY(i+1)+pos.getY(i+2),pos.getX(i)+pos.getX(i+1)+pos.getX(i+2));
      const c=Math.abs(Math.sin(a*2))<.43?tape:orange;
      for (let j=i;j<i+3;j++) c.toArray(colours,j*3);
    }
    ring.setAttribute('color',new THREE.BufferAttribute(colours,3));
    add(ring.translate(x,y,z),'#d65c32');
    for (const x of (cruise ? [-10, 0, 10] : [-3.5, 2.2])) {
      if (cruise) {
        const z=side*(beam/2+(x===10 ? .015 : .105));
        rod([x,1.28,z],[x+.08,1.53,z-side*.09],.024,'#928b76');
        add(new THREE.LatheGeometry([new THREE.Vector2(.035,0),new THREE.Vector2(.105,.075),
          new THREE.Vector2(.115,.19),new THREE.Vector2(.115,.50),new THREE.Vector2(.085,.60),
          new THREE.Vector2(.036,.64)],8).translate(x,.65,z),'#3c4444');
      } else {
        const z = side * (beam / 2 - .055);
        rod([x, .60, z], [x + .10, .98, z], .09, '#3e4446');
      }
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
