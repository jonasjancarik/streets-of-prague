import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import proj4 from 'proj4';
import type { Bounds } from './map/geo.ts';
import type { Sky } from './sky.ts';

// Survey views of the Hradčany ridge. The photos are on sparse geometry
// reconstructed from the visible depth, so the cathedral moves relative to
// the palace and the near roofs as the player crosses the river.
const origin: [number, number] = [14.40052,50.09077];
const step = THREE.MathUtils.smoothstep;

export class CastleHorizon {
  private model?: THREE.Group;
  private views: THREE.Mesh<THREE.BufferGeometry,THREE.MeshBasicMaterial>[] = [];
  private bearings: number[] = [];
  private loading = false;
  private retryAt = 0;
  private at?: THREE.Vector3;
  private turn = 0;
  private sight = new THREE.Vector3();
  private light = new THREE.Color();

  constructor(private scene: THREE.Scene, [west,south,east,north]: Bounds, datum: number) {
    if (east < 14.30 || west > 14.50 || north < 50.03 || south > 50.15) return;
    const projection = `+proj=tmerc +lat_0=${(south+north)/2} +lon_0=${(west+east)/2} +ellps=WGS84 +units=m`;
    const [x,y] = proj4('EPSG:4326',projection,origin);
    const [ex,ey] = proj4('EPSG:4326',projection,[origin[0]+.001,origin[1]]);
    this.at = new THREE.Vector3(x,180-datum,-y);
    this.turn = Math.atan2(ey-y,ex-x);
  }

  private async load() {
    if (!this.at) return;
    this.loading = true;
    try {
      const { scene: model } = await new GLTFLoader().loadAsync(import.meta.env.BASE_URL+'hradcany-horizon.glb');
      const views = model.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh)
        .sort((a,b)=>a.userData.bearing-b.userData.bearing);
      if (views.length < 2 || views.some((o,i)=>Array.isArray(o.material) || !Number.isFinite(o.userData.bearing) ||
          (i && o.userData.bearing<=views[i-1].userData.bearing))) throw Error('Incomplete Hradčany views');
      this.bearings = [...views.map(o=>o.userData.bearing),360];
      const originals = new Set<THREE.Material>();
      for (const view of views) {
        const original = view.material as THREE.MeshStandardMaterial;
        originals.add(original);
        const material = new THREE.MeshBasicMaterial({ map: original.map, fog: false, transparent: true, depthWrite: false, side: THREE.DoubleSide });
        material.forceSinglePass = true;
        view.material = material;
        view.visible = false;
        this.views.push(view as THREE.Mesh<THREE.BufferGeometry,THREE.MeshBasicMaterial>);
      }
      for (const material of originals) material.dispose();
      model.name = 'Distant Hradčany';
      model.position.copy(this.at); model.rotation.y = this.turn; model.updateMatrix(); model.matrixAutoUpdate = false;
      model.visible = false;
      this.scene.add(model);
      this.model = model;
    } catch { this.views.length = 0; this.retryAt = performance.now()+60000; }
    finally { this.loading = false; }
  }

  update(street: boolean, camera: THREE.PerspectiveCamera, sky: Sky) {
    if (!this.at || !street) { if (this.model) this.model.visible = false; return; }
    const dx = camera.position.x-this.at.x, dz = camera.position.z-this.at.z;
    const distance = Math.hypot(dx,dz);
    const strength = .91*step(distance,490,785)*(1-step(distance,2200,4800))*(1-step(sky.murk,.025,.43));
    if (strength < .008) { if (this.model) this.model.visible = false; return; }
    camera.getWorldDirection(this.sight);
    const facing = (-dx*this.sight.x-dz*this.sight.z) / Math.max(1e-6,distance*Math.hypot(this.sight.x,this.sight.z));
    const half = Math.atan(Math.tan(camera.fov*Math.PI/360)*camera.aspect) + Math.asin(Math.min(.97,675/Math.max(1,distance)));
    if (facing < Math.cos(Math.min(Math.PI,half+.08))) {
      if (this.model) this.model.visible = false;
      return;
    }
    if (!this.model) {
      if (!this.loading && performance.now() >= this.retryAt) void this.load();
      return;
    }
    this.model.visible = true;
    const angle = THREE.MathUtils.euclideanModulo((Math.atan2(dx,-dz)+this.turn)*180/Math.PI,360);
    let a=0;
    while (a < this.bearings.length-2 && angle >= this.bearings[a+1]) a++;
    const b=(a+1)%this.views.length, blend=step((angle-this.bearings[a])/(this.bearings[a+1]-this.bearings[a]),.39,.61);
    const second = strength*blend, first = (strength-second)/(1-second);
    this.light.copy(sky.hemi.color).multiplyScalar(sky.hemi.intensity*.30);
    const sun = sky.sun;
    this.light.r += sun.color.r*sun.intensity*.105;
    this.light.g += sun.color.g*sun.intensity*.105;
    this.light.b += sun.color.b*sun.intensity*.105;
    for (let i=0;i<this.views.length;i++) {
      const view = this.views[i], opacity = i===a ? first : i===b ? second : 0;
      view.visible = opacity > .003;
      if (!view.visible) continue;
      view.renderOrder = i===a ? -20 : -19;
      view.material.opacity = opacity;
      view.material.color.copy(this.light);
    }
  }
}
