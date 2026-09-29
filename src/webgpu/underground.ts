// The metro's materials in TSL ('metro-hole' and 'metro-earth' in ../underground.ts): the
// tunnels, platforms and train drawn only inside the hole dug round the player (DIG), and
// the disc of earth at the top of that hole. Registered as ports (see addPort).

import { float, vec2, vec3, vec4, positionGeometry, positionLocal, positionWorld, materialColor, distance } from 'three/tsl';
import { type N, addPort, uDig, fbm } from './common.ts';

// Cut off where the ground above is in the way.
addPort(/^metro-hole$/, (node) => {
  node.maskNode = distance(positionWorld.xz, uDig.xy).lessThanEqual(uDig.z);
});

// The disc follows DIG (a unit circle scaled to the hole's radius, moved to its middle), is
// mottled like the ground in a road tunnel's hole, and is left at the back as far as depth
// goes, so everything of the tunnels is drawn over it.
addPort(/^metro-earth$/, (node) => {
  const p: N = positionGeometry;
  node.positionNode = vec3(uDig.x.add(p.x.mul(uDig.z)), p.y, uDig.y.add(p.z.mul(uDig.z)));
  const xz = positionLocal.xz;
  node.colorNode = vec4(vec3(materialColor).mul(fbm(vec2(xz.x, xz.y.negate()).mul(0.7)).mul(0.4).add(0.8)), 1);
  node.depthNode = float(1);
});
