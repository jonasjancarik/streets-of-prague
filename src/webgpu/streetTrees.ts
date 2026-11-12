// The trees seen from the street (map/streetTree.ts) in TSL: bark on the trunk and boughs,
// and on the cards a spray of leaves in the tree's own colour, turning in autumn as the
// crowns seen from above do, then falling card by card to leave bare twigs. The tree pool
// (../trees.ts) makes the meshes; this is their material.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import {
  Fn, If, Discard, float, vec2, vec3, vec4, attribute, texture, uv, positionGeometry, positionLocal, positionWorld, normalViewGeometry, diffuseColor,
  floor, fract, dot, mix, smoothstep, step, length, min, clamp, normalize, select, cameraViewMatrix,
} from 'three/tsl';
import { BARE, SEASON } from '../shading.ts';
import { STEM } from '../map/vegetation.ts';
import { CROWN_FOOT } from '../map/streetTree.ts';
import { setStreetTreeMaterial } from '../trees.ts';
import { lampLit } from './lamps.ts';
import { instanceMatrix, shareInstances, outlineAt } from './trees.ts';
import { type N, follow, followVec, uWet, uSnow } from './common.ts';

const uBare = follow(BARE), uSeason = followVec(SEASON);
const part: N = attribute('part', 'vec4'), yearly: N = attribute('yearly', 'float');

// The pictures arrive after the first frames: plain stand-ins keep the bindings' types.
const blank = (rgba: number[]) => {
  const t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
};
const sprays: N = texture(blank([120, 120, 120, 0])), bark: N = texture(blank([96, 88, 76, 255]));
// Whether both pictures are in (the pool draws the top-down trees until then).
export const STREET_TREES_READY = { value: false };
let asked = false;
export function loadStreetTrees() {
  if (asked) return;
  asked = true;
  const loader = new THREE.TextureLoader();
  let left = 2;
  const done = () => { if (--left === 0) STREET_TREES_READY.value = true; };
  loader.load('street-trees.webp', (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    sprays.value = t;
    done();
  });
  loader.load('bark.webp', (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
    t.anisotropy = 4;
    bark.value = t;
    done();
  });
}

// `yearly` as in webgpu/trees.ts: the tree's own timing, whether it changes at all, and how
// far below the crown the ground is.
const year: N = yearly.mod(STEM.span), own: N = fract(year);
const changes: N = float(1).sub(step(0.995, year).mul(step(year, 1.5)));
const stem: N = floor(yearly.div(STEM.span)).mul(STEM.step);
const bareTree = (): N => clamp(uBare.mul(1.6).sub(own.mul(0.6)), 0, 1).mul(changes);

// The crown takes the outline the top-down crown has; the lower trunk reaches the ground.
const shaped = (): N => {
  const p: N = positionGeometry, wide: N = mix(1, outlineAt(p), smoothstep(0.15, 0.5, length(p.xz)));
  return vec3(p.x.mul(wide), select(part.y.greaterThanEqual(0), mix(stem.negate().sub(STEM.under), CROWN_FOOT, part.y), p.y), p.z.mul(wide));
};

function material() {
  const m = new MeshLambertNodeMaterial({ side: THREE.DoubleSide }) as N;
  const proto = Object.getPrototypeOf(m);
  m.name = 'street-trees';
  m.setupPosition = function (builder: N) {
    shareInstances(builder);
    positionLocal.assign(shaped());
    return proto.setupPosition.call(this, builder);
  };
  m.castShadowPositionNode = instanceMatrix().mul(vec4(shaped(), 1)).xyz;

  // A card: leaves until the tree has shed this far, then twigs (the atlas's two halves).
  const card: N = uv();
  const leafy = (): N => step(bareTree(), part.z.mul(0.96).add(0.02));
  // (One read: the half of the atlas is chosen by the card, not both read and mixed.)
  const picture: N = Fn(() => sprays.sample(vec2(card.x.mul(0.5).add(leafy().oneMinus().mul(0.5)), card.y.oneMinus())));
  m.maskShadowNode = part.x.greaterThan(0.5).or((picture() as N).a.greaterThan(0.35));

  m.setupDiffuseColor = function (builder: N) {
    proto.setupDiffuseColor.call(this, builder);
    const wood: N = bark.sample(vec2(card.x, positionWorld.y.mul(1.1))).rgb.mul(1.7);
    const p: N = picture().toVar();
    If(part.x.lessThan(0.5).and(p.a.lessThan(0.35)), () => { Discard(); });
    // The leaves' colour through the year (yearColour in webgpu/trees.ts, by the card).
    const tree: N = diffuseColor.rgb;
    const pick: N = fract(own.mul(7.31).add(0.13));
    const shade: N = min(dot(tree, vec3(0.3, 0.59, 0.11)).div(0.15), 1.6);
    const fresh: N = tree.mul(mix(vec3(1), vec3(1.3, 1.25, 0.7), uSeason.z.mul(changes)));
    const autumn: N = mix(mix(vec3(0.58, 0.39, 0.03), vec3(0.32, 0.1, 0.02), smoothstep(0.25, 0.85, pick)), vec3(0.27, 0.03, 0.014), step(0.9, pick));
    const turned: N = clamp(uSeason.x.mul(1.7).sub(clamp(own.add(part.z.sub(0.5).mul(0.3)), 0, 1).mul(0.7)), 0, 1).mul(changes);
    // Darker inside the crown and on its underside, where the light has to come through leaves.
    const inside: N = mix(0.5, 1.12, smoothstep(0.35, 1, part.w));
    const leaf: N = mix(fresh, autumn.mul(shade).mul(0.7), turned).mul(p.rgb).mul(1.5).mul(inside);
    const c: N = mix(p.rgb.mul(0.8), leaf, leafy()).toVar();
    c.assign(mix(c, wood, part.x));
    c.mulAssign(float(1).sub(uWet.mul(0.18)));
    If(uSnow.greaterThan(0.01), () => {
      const upward = dot(normalize(normalViewGeometry), cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);
      c.assign(mix(c, vec3(0.78, 0.8, 0.84), smoothstep(0.3, 0.8, upward).mul(smoothstep(0.2, 0.8, uSnow)).mul(mix(0.7, 0.35, part.x))));
    });
    diffuseColor.assign(vec4(c, 1));
  };
  // The cards' normals are the crown's (map/streetTree.ts), the same from both sides.
  m.setupNormal = () => normalize(normalViewGeometry);
  lampLit(m);
  return m as THREE.Material;
}

setStreetTreeMaterial(() => { loadStreetTrees(); return material(); }, STREET_TREES_READY);
