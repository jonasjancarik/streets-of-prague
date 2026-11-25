// The four glazed stairwells on the roof of the main station's lower hall.
// OSM's 15 m height includes the lower storey. IPR's surface model puts all
// four crowns at about 220.4 m Bpv, roughly 9.5 m above the upper pavement.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TileBuilding } from '../contracts.ts';
import { centroid, signedArea } from './geo.ts';

const ways = new Set(['way/839316634', 'way/839316635', 'way/839316636', 'way/839316637']);
export const isStationStairwell = (building: TileBuilding) => ways.has(building.id);
export const STAIRWELL_GLASS = 'Wilsonova stairwell glazing';
const tau = Math.PI * 2;
const up = new THREE.Vector3(0, 1, 0);
const steel = '#344c49', aluminium = '#9ba9a5', concrete = '#8b8677';

// Two batches for the station tile. The panes let the opposite ribs, the
// landing and the background show through from either side of the street.
export function stationStairwells(buildings: TileBuilding[], ground: ((x: number, y: number) => number) | undefined, ref: number) {
  const frames: THREE.BufferGeometry[] = [], panes: THREE.BufferGeometry[] = [];
  for (const building of buildings) {
    if (!isStationStairwell(building)) continue;
    const ring = building.rings[0], [x, north] = centroid(ring);
    const radius = Math.sqrt(Math.abs(signedArea(ring)) / Math.PI), base = ground?.(x, north) ?? 0;
    const height = ground ? 220.4 - ref - base : 9.6, spring = height - radius;
    const local: THREE.BufferGeometry[] = [];
    const part = (g: THREE.BufferGeometry, colour: string) => {
      const rgb = new THREE.Color(colour), colors = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < colors.length; i += 3) rgb.toArray(colors, i);
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      local.push(g);
    };
    const beam = (a: THREE.Vector3, b: THREE.Vector3, width: number, colour = steel) => {
      const axis = b.clone().sub(a);
      const tube = new THREE.CylinderGeometry(width, width, axis.length(), 5, 1, true);
      tube.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, axis.normalize()));
      const mid = a.clone().lerp(b, .5);
      part(tube.translate(mid.x, mid.y, mid.z), colour);
    };
    const point = (angle: number, r: number, h: number) => new THREE.Vector3(r * Math.cos(angle), h, r * Math.sin(angle));
    const hoop = (r: number, h: number, gauge: number, colour = steel) => {
      const g = new THREE.TorusGeometry(r, gauge, 5, 24);
      part(g.rotateX(Math.PI / 2).translate(0, h, 0), colour);
    };
    const post = (angle: number, r: number, lo: number, hi: number, width: number) =>
      beam(point(angle, r, lo), point(angle, r, hi), width);

    // The arched frames are parallel bows across the crown. Their ends
    // continue down the walls, visible through the panes on the opposite side.
    for (let i = 0; i < 12; i++) {
      const a = tau * i / 12;
      post(a, radius, .15, spring, i % 3 === 0 ? .048 : .031);
    }
    for (const crosswise of [false, true]) {
      for (const offset of [-.72, 0, .72]) {
        const across = radius * offset, arch = Math.sqrt(radius * radius - across * across);
        let previous: THREE.Vector3 | undefined;
        for (let j = 0; j <= 16; j++) {
          const theta = Math.PI * j / 16, u = arch * Math.cos(theta);
          const next = new THREE.Vector3(crosswise ? across : u, spring + arch * Math.sin(theta), crosswise ? u : across);
          if (previous) beam(previous, next, crosswise ? .037 : .052);
          if (j === 0 || j === 16) beam(new THREE.Vector3(next.x, .18, next.z), next, .042);
          previous = next;
        }
      }
    }
    for (const h of [.22, 2.15, 3.25, 5.4, spring]) hoop(radius, h, .044);
    hoop(radius * Math.cos(Math.PI / 4), spring + radius * Math.sin(Math.PI / 4), .028);
    hoop(radius, .13, .085, aluminium);

    // A landing and the head of the stair behind its balustrade.
    const disc = new THREE.CylinderGeometry(radius * .97, radius * .97, .20, 24);
    part(disc.translate(0,.10,0), '#565852');
    const outer = radius * .77, inner = radius * .27;
    let rail: THREE.Vector3 | undefined;
    for (let i = 0; i <= 12; i++) {
      const a = -.8 * Math.PI + i * .15, h = .23 + i * .15;
      const tread = new THREE.BoxGeometry(outer - inner, .12, outer * .18);
      tread.translate((outer + inner) / 2, h, 0).rotateY(-a);
      part(tread, concrete);
      const hand = point(a, outer, h + .93);
      if (i % 3 === 0) post(a, outer, h, h + .93, .032);
      if (rail) beam(rail, hand, .042, aluminium);
      rail = hand;
    }
    const end = -.8 * Math.PI + 12 * .15;
    const landing = new THREE.BoxGeometry(outer-inner, .16, 1.04);
    landing.translate((outer+inner)/2, 2.03, .48).rotateY(-end);
    part(landing, concrete);
    part(new THREE.BoxGeometry(1.0, 2.86, .95).translate(.10,1.43,.05), '#838e87');
    // Glazed entry doors in a dark steel surround at the foot of the drum.
    const door = (x: number, h: number) => new THREE.Vector3(x, h, -Math.sqrt(radius*radius-.65*.65));
    for (const x of [-.65, 0, .65]) beam(door(x,.16),door(x,2.34),.038);
    beam(door(-.65,2.34),door(.65,2.34),.047);
    beam(door(-.54,1.02),door(-.10,1.02),.028,aluminium);
    beam(door(.10,1.02),door(.54,1.02),.028,aluminium);
    for (const g of local) frames.push(g.rotateY(.43).translate(x, base, -north));

    const wall = new THREE.CylinderGeometry(radius-.055, radius-.055, spring-.17, 24, 1, true);
    panes.push(wall.translate(x,base+(spring+.17)/2,-north));
    const cap = new THREE.SphereGeometry(radius-.055, 24, 8, 0, tau, 0, Math.PI/2);
    panes.push(cap.translate(x,base+spring,-north));
  }
  if (!frames.length) return [];
  const frame = new THREE.Mesh(mergeGeometries(frames)!, new THREE.MeshLambertMaterial({ vertexColors: true }));
  const glass = new THREE.Mesh(mergeGeometries(panes)!, new THREE.MeshPhongMaterial({
    color: '#b3d4d4', specular: '#e4f3f4', shininess: 85, transparent: true, opacity: .18,
    depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true,
  }));
  for (const g of [...frames, ...panes]) g.dispose();
  frame.name = 'Wilsonova stairwell frames';
  frame.castShadow = frame.receiveShadow = true;
  glass.name = STAIRWELL_GLASS;
  return [frame, glass];
}
