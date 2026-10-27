import * as THREE from 'three';
import type { Point2 } from './map/geo.ts';

// What the cars mirror along the horizon (plan 037 phase 2): a 360° street for each kind
// of area, made with image generation and packed into one texture by
// assets/reflections/pack.sh (public/reflections.webp, one strip under another in the
// order of KINDS). Each car takes the kind of area it's in (CarPool, from where it is),
// and car.ts looks its strip up by the direction a point of its paint reflects. Until the
// texture is in, and on Lowest, the cars keep the made-up street of phase 1.

export const KINDS = ['oldtown', 'tenements', 'estate', 'villas', 'river', 'park', 'country'] as const;
export type Kind = typeof KINDS[number];

// The cadastral areas (districts.ts) by kind; any other within 8 km of the Old Town
// Square is villas, further out the countryside.
const BY_DISTRICT: Record<string, Kind> = {};
const list = (kind: Kind, names: string) => { for (const n of names.split(',')) BY_DISTRICT[n.trim()] = kind; };
list('oldtown', 'Staré Město, Malá Strana, Hradčany, Josefov, Nové Město, Vyšehrad');
list('tenements', 'Vinohrady, Žižkov, Karlín, Holešovice, Smíchov, Vršovice, Nusle, Libeň, Bubeneč, Dejvice, Vysočany, Břevnov, Košíře, Michle, Podolí, Strašnice, Bubny');
list('estate', 'Chodov, Háje, Stodůlky, Modřany, Bohnice, Černý Most, Prosek, Kobylisy, Řepy, Letňany, Krč, Lhotka, Petrovice, Hloubětín, Střížkov, Kamýk, Libuš, Záběhlice, Hostivař, Jinonice, Zličín, Hlubočepy, Malešice, Kyje');
list('villas', 'Střešovice, Hodkovičky, Braník, Troja, Liboc, Veleslavín, Vokovice, Sedlec, Suchdol, Lysolaje, Ruzyně, Motol, Radlice');
const CITY_KM = 8;
const CENTRE: Point2 = [0, 0]; // the Old Town Square (main.ts sets it)
export function setCentre(x: number, y: number) { CENTRE[0] = x; CENTRE[1] = y; }

// The kind of area at (x, y): `district` the cadastral area there (null outside them
// all), `water` whether there's open water within some 40 m (then it's the riverbank).
export function kindAt(x: number, y: number, district: string | null, water: boolean): number {
  if (water) return KINDS.indexOf('river');
  const k = district ? BY_DISTRICT[district] : undefined;
  if (k) return KINDS.indexOf(k);
  const km = Math.hypot(x - CENTRE[0], y - CENTRE[1]) / 1000;
  return KINDS.indexOf(district && km < CITY_KM ? 'villas' : 'country');
}

// The packed strips (a stand-in until they're in), and 1 once they're in and the
// graphics want them. A shader that holds the texture itself (TSL) hears of the new one
// through onStrips.
export const STRIPS: { value: THREE.Texture } = { value: new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1) };
STRIPS.value.needsUpdate = true;
export const STRIPS_ON = { value: 0 };
const listeners: ((t: THREE.Texture) => void)[] = [];
export function onStrips(f: (t: THREE.Texture) => void) { listeners.push(f); }
let wanted = true, loaded = false;
export function wantStrips(on: boolean) { wanted = on; STRIPS_ON.value = wanted && loaded ? 1 : 0; }

export function loadStrips(url = 'reflections.webp') {
  new THREE.TextureLoader().load(url, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    STRIPS.value = t;
    for (const f of listeners) f(t);
    loaded = true;
    wantStrips(wanted);
  }, undefined, () => { /* no strips: the made-up street stays */ });
}
