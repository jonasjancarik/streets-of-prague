// The cars, trams, funicular and boats in TSL (the onBeforeCompile of their module-level
// materials in car.ts, trams.ts, funicular.ts and boats.ts): snow on the cars' roofs, lit
// windows and navigation lights at night, and the lamps' light. Registered as ports of
// the 'cars', 'trams', 'funicular' and 'boats' materials (see addPort).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { float, vec3, vec4, attribute, vertexColor, normalView, cameraViewMatrix, diffuseColor, dot, smoothstep, mix, select } from 'three/tsl';
import { lampLit, uLampOn } from './lamps.ts';
import { type N, addPort, uSnow } from './common.ts';

const luma = (c: N) => dot(c, vec3(0.3, 0.59, 0.11));

// Adds to the material's emissive colour (what the GLSL adds to totalEmissiveRadiance).
const glow = (node: N, light: () => N) => {
  const emissive = node.emissiveNode;
  node.emissiveNode = (emissive ? vec3(emissive) : vec3(0)).add(light());
};

addPort(/^cars$/, (node) => {
  const proto = Object.getPrototypeOf(node);
  node.setupDiffuseColor = function (builder: N) {
    proto.setupDiffuseColor.call(this, builder);
    const up = dot(normalView, cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);
    const cover = smoothstep(0.75, 0.95, up).mul(smoothstep(0.1, 0.6, uSnow)).mul(0.6);
    diffuseColor.assign(vec4(mix(diffuseColor.rgb, vec3(0.8, 0.82, 0.86), cover), diffuseColor.a));
  };
  lampLit(node);
});

// The windows (the dark band of blue-ish vertex colour) are lit from inside.
const windows = () => {
  const c = vertexColor().rgb;
  const dark = luma(c).lessThan(0.03).and(c.z.greaterThan(c.x));
  return select(dark, vec3(1, 0.88, 0.7).mul(0.5).mul(uLampOn), vec3(0));
};
for (const name of [/^trams$/, /^funicular$/]) {
  addPort(name, (node) => {
    glow(node, windows);
    lampLit(node);
  });
}

// Cabin windows lit, and the navigation lights (glow 2) in their own colour.
addPort(/^boats$/, (node) => {
  glow(node, () => {
    const g: N = attribute('glow', 'float');
    const c = vertexColor().rgb;
    const lit = select(g.greaterThan(1.5), c.mul(1.6), vec3(1, 0.86, 0.62).mul(0.6));
    return select(g.greaterThan(0.5), lit.mul(uLampOn), vec3(0));
  });
  lampLit(node);
});
