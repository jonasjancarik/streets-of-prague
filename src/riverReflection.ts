import * as THREE from 'three';
import proj4 from 'proj4';
import locations from './riverBankStations.json';
import type { Bounds } from './map/geo.ts';

interface Station { x: number; z: number; height: number }
const placeholder = new THREE.DataTexture(new Uint8Array([0,0,0,0]), 1, 1);
placeholder.needsUpdate = true;

// Low panoramas of the actual banks. Each station includes the distance to the
// shore in each direction so a water pixel can correct its reflected view.
export class RiverBanks {
  enabled = true;
  banks = true;
  readonly street = { value: 0 };
  readonly strength = { value: 0 };
  readonly mix = { value: 0 };
  readonly a = { value: new THREE.Vector4() };
  readonly b = { value: new THREE.Vector4() };
  map: THREE.Texture = placeholder;
  onLoad?: (map: THREE.Texture) => void;
  private stations: Station[] = [];
  private ix = 0;
  private lastX = Infinity;
  private lastZ = Infinity;
  private loading = false;
  private ready = false;
  private retryAt = 0;

  area([west,south,east,north]: Bounds, datum: number) {
    if (east < 14.32 || west > 14.52 || north < 50.02 || south > 50.15) {
      this.stations = []; this.strength.value = 0;
      return;
    }
    const local = `+proj=tmerc +lat_0=${(south+north)/2} +lon_0=${(west+east)/2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`;
    this.stations = locations.map(([lon,lat,h]) => {
      const [x,y] = proj4('EPSG:4326', local, [lon,lat]);
      return { x, z: -y, height: h + 180-datum };
    });
    this.lastX = Infinity;
  }

  private async load() {
    this.loading = true;
    try {
      const map = await new THREE.TextureLoader().loadAsync(import.meta.env.BASE_URL + 'vltava-banks.webp');
      map.colorSpace = THREE.SRGBColorSpace;
      map.generateMipmaps = false;
      map.minFilter = map.magFilter = THREE.LinearFilter;
      this.map = map; this.onLoad?.(map); this.ready = true;
    } catch { this.retryAt = performance.now()+60000; }
    finally { this.loading = false; }
  }

  private fraction(x: number, z: number, a: Station, b: Station) {
    const dx = b.x-a.x, dz = b.z-a.z;
    return Math.max(0, Math.min(1, ((x-a.x)*dx+(z-a.z)*dz)/(dx*dx+dz*dz || 1)));
  }

  view(street: boolean, x: number, z: number) {
    this.street.value = street && this.enabled ? 1 : 0;
    if (!this.street.value || !this.banks || this.stations.length < 2) { this.strength.value = 0; return; }
    if ((x-this.lastX)**2+(z-this.lastZ)**2 > 36) {
      this.lastX = x; this.lastZ = z;
      let best = Infinity;
      for (let i = 0; i < this.stations.length-1; i++) {
        const a = this.stations[i], b = this.stations[i+1], t = this.fraction(x,z,a,b);
        const d = (x-a.x-t*(b.x-a.x))**2+(z-a.z-t*(b.z-a.z))**2;
        if (d < best) { best = d; this.ix = i; }
      }
    }
    const a = this.stations[this.ix], b = this.stations[this.ix+1];
    const t = this.fraction(x,z,a,b), dx = x-a.x-t*(b.x-a.x), dz = z-a.z-t*(b.z-a.z);
    const fade = 1-THREE.MathUtils.smoothstep(dx*dx+dz*dz, 145**2, 230**2);
    this.strength.value = this.ready ? fade : 0;
    if (!fade) return;
    if (!this.ready) { if (!this.loading && performance.now() >= this.retryAt) void this.load(); return; }
    this.mix.value = t;
    this.a.value.set(a.x,a.height+.35,a.z,this.ix);
    this.b.value.set(b.x,b.height+.35,b.z,this.ix+1);
  }
}

export const riverBanks = new RiverBanks();
