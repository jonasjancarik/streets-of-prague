// Equipment shared by the street-level fire crew. The helmet coordinates are
// in metres relative to the head joint in the avatar's upright bind pose (+z forward).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cutAway } from './shading.ts';

export function fireGear() {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, tint: string) => {
    g.deleteAttribute('uv');
    const c = new THREE.Color(tint), colours = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < colours.length; i += 3) colours.set([c.r, c.g, c.b], i);
    g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  const material = cutAway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.64 }), 'rocketbox');
  const mesh = () => {
    const result = new THREE.Mesh(mergeGeometries(parts.splice(0)), material);
    result.castShadow = result.receiveShadow = true;
    return result;
  };
  const dome = new THREE.SphereGeometry(1, 24, 12, 0, 2 * Math.PI, 0, Math.PI * 0.55);
  dome.scale(0.132, 0.154, 0.151).translate(0, 0.137, 0.003);
  add(dome, '#dfdc96');
  // Raised visor, projecting brim and the dark neck curtain at the back.
  const brim = new THREE.CylinderGeometry(1, 1, 0.014, 32).scale(0.146, 1, 0.173).translate(0, 0.127, 0.013);
  add(brim, '#c2bd81');
  const visor = new THREE.SphereGeometry(1, 20, 5, 0.38, Math.PI - 0.76, 0.91, 0.48);
  add(visor.scale(0.136, 0.158, 0.154).translate(0, 0.137, 0.003), '#687576');
  const nape = new THREE.CylinderGeometry(0.122, 0.143, 0.135, 16, 1, true, Math.PI * 0.54, Math.PI * 0.92);
  add(nape.scale(1, 1, 0.97).translate(0, 0.061, -0.006), '#3c4241');
  // Longitudinal moulding and reflective side panels distinguish the fire
  // helmet in profile. Follow the curvature of the shell at the temples.
  const crest = new THREE.SphereGeometry(1, 16, 8);
  add(crest.scale(.020,.050,.116).translate(0,.247,-.008), '#e9e5aa');
  for (const phi of [-.22, Math.PI-.22]) {
    const patch = new THREE.SphereGeometry(1, 8, 3, phi, .45, 1.10, .12);
    add(patch.scale(.134,.156,.153).translate(0,.137,.003), '#d1d6ca');
  }
  const helmet = mesh();
  // Nozzle sits between the hands in the hose clip; z=0.60 is the jet origin.
  for (const [start, end, radius, colour] of [
    [0.24, 0.39, 0.041, '#393e40'], [0.39, 0.47, 0.047, '#b69453'],
    [0.47, 0.54, 0.037, '#42484a'], [0.54, 0.60, 0.042, '#697477'],
  ] as const) {
    const z = (start + end) / 2;
    add(new THREE.CylinderGeometry(radius, radius, (end - start) * 1.035, 16).rotateX(Math.PI / 2 - 0.25)
      .translate(0, 1.30 + (z - 0.60) * 0.25, z), colour);
  }
  add(new THREE.CircleGeometry(.029, 16).rotateX(-.25).translate(0, 1.301, .602), '#222627');
  // The flexible line drops behind the shutoff grip and trails past the boot.
  const line = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 1.21, .24), new THREE.Vector3(.15, 1.12, .11),
    new THREE.Vector3(.26, .72, -.08), new THREE.Vector3(.31, .10, -.24),
    new THREE.Vector3(.38, .04, -.52), new THREE.Vector3(.51, .04, -1.30),
  ]);
  add(new THREE.TubeGeometry(line, 20, .029, 8, false), '#605953');
  return { helmet, nozzle: mesh() };
}
