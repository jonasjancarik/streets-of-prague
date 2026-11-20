// Street fittings follow the very same apertures and nose profile as the Blender shell.
// X runs forward, Y up, and positive Z is the boarding side.
import * as THREE from 'three';
import { VEHICLE_VIEW_GLSL, VEHICLE_VIEW_UNIFORMS } from './car.ts';
import { mirrored } from './mirror.ts';
import { seatedPeople } from './passengerCabin.ts';
import { lampLit } from './lamps.ts';

import type { TramFittings } from './tramStreetModel.ts';

export const streetEnamel = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 27, specular: '#303330' });
streetEnamel.onBeforeCompile = (sh) => {
  lampLit(sh);
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float streetGlow; varying float vStreetGlow;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvStreetGlow = streetGlow;');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vStreetGlow;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * (vStreetGlow * uLampOn + max(0., vStreetGlow - 1.5) * .12);');
};
streetEnamel.customProgramCacheKey = () => 'street-tram';
export const streetGlass = new THREE.MeshPhongMaterial({
  color: '#43545b', transparent: true, opacity: 0.27,
  depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, shininess: 110, specular: '#b5c6c9'
});

streetGlass.customProgramCacheKey = () => 'tram-glass';
streetGlass.onBeforeCompile = (sh) => {
  Object.assign(sh.uniforms, VEHICLE_VIEW_UNIFORMS);
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vTramWorld;')
    .replace('#include <project_vertex>', '#include <project_vertex>\nvTramWorld = (modelMatrix * vec4(transformed,1.)).xyz;');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vTramWorld;\n' + VEHICLE_VIEW_GLSL)
    .replace('#include <opaque_fragment>', `vec3 v = normalize(vViewPosition);
      float graze = pow(clamp(1. - abs(dot(normal,v)),0.,1.),2.);
      vec3 ray = (vec4(reflect(-v,normal),0.) * viewMatrix).xyz;
      outgoingLight += carStreet(ray,1.,vTramWorld) * (.74 + 1.1 * graze);
      diffuseColor.a = .23 + .43 * graze;
      #include <opaque_fragment>`);
};

const boards = new Map<string, THREE.MeshBasicMaterial>();
export function tramDestination(ref: string, to: string, classic: boolean) {
  const key = [classic, ref, to].join('|'); let material = boards.get(key); if (material) return material;
  const c = document.createElement('canvas'); c.width = 448; c.height = 72;
  const g = c.getContext('2d')!; g.fillStyle = '#171d17'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = classic ? '#c0dc79' : '#f0ad50'; g.textBaseline = 'middle'; g.font = 'bold 57px Arial, sans-serif';
  g.fillText(ref, 9, 38, 71); g.font = 'bold 40px Arial, sans-serif'; g.fillText(to.toLocaleUpperCase('cs'), 87, 38, 350);
  // Fine unlit gaps break the lettering into the cells of the display.
  g.fillStyle = 'rgba(17,24,16,.41)'; for (let x = 0; x < c.width; x += 4)g.fillRect(x, 0, 1, c.height);
  for (let y = 0; y < c.height; y += 4)g.fillRect(0, y, c.width, 1);
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
  material = new THREE.MeshBasicMaterial({ map }); boards.set(key, material); return material;
}

let numberInk: THREE.MeshLambertMaterial | undefined;
function fleetInk() {
  if (numberInk) return numberInk;
  const c = document.createElement('canvas'); c.width = 400; c.height = 64;
  const g = c.getContext('2d')!; g.fillStyle = '#f3dfb0'; g.font = 'bold 52px Arial'; g.textBaseline = 'middle'; g.textAlign = 'center';
  for (let i = 0; i < 10; i++)g.fillText(String(i), i * 40 + 20, 34);
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
  return numberInk = new THREE.MeshLambertMaterial({ map, alphaTest: .33, polygonOffset: true, polygonOffsetFactor: -1 });
}
function setFleetNumber(mesh: THREE.Mesh, number: number) {
  const uv = mesh.geometry.attributes.uv, digits = String(number).padStart(4, '0');
  for (let i = 0; i < uv.count; i++)uv.setX(i, (Number(digits[Math.floor(i / 4) % 4]) + (i % 2)) / 10);
  uv.needsUpdate = true;
}

// Pooled instances share all fitted geometry. Only the deployed door fraction,
// cab occupant and destination belong to an individual tram.
const driverCoat = new THREE.MeshLambertMaterial({ vertexColors: true, color: '#dedbd1' });
export class TramStreetView {
  visible = false;
  private rows: {
    shell: THREE.Mesh; low: THREE.BufferGeometry; old: THREE.Material | THREE.Material[];
    fitted: TramFittings; panes: THREE.Mesh; fleet?: THREE.Mesh; boards: THREE.Mesh[]
  }[];
  private id = -1; private route = ''; private terminal = ''; private amount = 0;
  private driver?: THREE.Mesh; private loadedDriver = -1; private pending = false; private retry = 0;
  constructor(shells: THREE.Mesh[], fittings: TramFittings[], private classic: boolean) {
    this.rows = shells.map((shell, i) => {
      const fitted = fittings[i], panes = mirrored(new THREE.Mesh(fitted.glass, streetGlass));
      const boards = fitted.displays.map(geometry => mirrored(new THREE.Mesh(geometry, streetEnamel)));
      const fleet = fitted.numbers ? mirrored(new THREE.Mesh(fitted.numbers.clone(), fleetInk())) : undefined;
      shell.add(panes, ...boards); if (fleet) shell.add(fleet);
      return { shell, low: shell.geometry, old: shell.material, fitted, panes, boards, fleet };
    });
  }
  show(ref: string, to: string, open: boolean, dt: number, id: number) {
    if (!this.visible) {
      this.visible = true; this.amount = open ? 1 : 0;
      for (const r of this.rows) {
        r.shell.geometry = r.fitted.body; r.shell.material = streetEnamel; r.shell.updateMorphTargets(); r.panes.visible = true;
        if (r.fleet) r.fleet.visible = true;
        for (const board of r.boards) board.visible = true;
      }
    }
    if (ref !== this.route || to !== this.terminal) {
      const mat = tramDestination(ref, to, this.classic);
      for (const row of this.rows) for (const board of row.boards) board.material = mat;
      this.route = ref; this.terminal = to;
    }
    this.amount = THREE.MathUtils.clamp(this.amount + (open ? 1 : -1) * dt * 1.25, 0, 1);
    for (const row of this.rows) {
      row.shell.morphTargetInfluences![0] = this.amount;
      row.panes.morphTargetInfluences![0] = this.amount;
    }
    if (this.id !== id) {
      for (const row of this.rows) if (row.fleet) setFleetNumber(row.fleet, (this.classic ? 7100 : 9100) + (id % 800));
      this.id = id;
    }
    const donor = id % 2;
    if (this.driver) this.driver.visible = this.loadedDriver === donor;
    if (this.loadedDriver !== donor && this.rows[0].fitted.driver && !this.pending && performance.now() >= this.retry) void this.seatDriver(donor);
  }
  lampOrigin(side: number, out: THREE.Vector3) {
    const front = this.rows[0], p = front.fitted.headlamp;
    if (!this.visible || !p) return false;
    out.set(p[0], p[1], p[2] * side).applyQuaternion(front.shell.quaternion).add(front.shell.position);
    return true;
  }
  get heading() { return this.rows[0].shell.rotation.y; }
  private async seatDriver(donor: number) {
    this.pending = true;
    try {
      const source = await seatedPeople(), person = source.getObjectByName('seated_driver_' + donor) as THREE.Mesh;
      if (!person?.isMesh) throw new Error('Missing seated tram driver');
      if (!this.driver) {
        this.driver = mirrored(new THREE.Mesh(person.geometry, driverCoat));
        this.driver.position.set(...this.rows[0].fitted.driver!); this.driver.receiveShadow = true;
        this.rows[0].shell.add(this.driver);
      } else this.driver.geometry = person.geometry;
      this.loadedDriver = donor; this.driver.visible = this.visible;
    } catch { this.retry = performance.now() + 60000; } finally { this.pending = false; }
  }
  hide() {
    if (!this.visible) return; this.visible = false;
    if (this.driver) this.driver.visible = false;
    for (const row of this.rows) {
      row.shell.geometry = row.low; row.shell.material = row.old; row.panes.visible = false;
      if (row.fleet) row.fleet.visible = false;
      for (const board of row.boards) board.visible = false;
    }
  }
}
