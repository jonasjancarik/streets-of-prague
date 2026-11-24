// Grounded, seasonal, deterministic leaves, including cancellation and tile removal.
import assert from 'node:assert/strict';
import './offline-city.mjs';
import * as THREE from 'three';
const { StreetLitter, LITTER_CAPACITY, LITTER_VERTICES, setLitterMaterial } = await import('../src/streetLitter.ts');
const { STREET_DETAIL } = await import('../src/streetHedges.ts');
const { SEASON } = await import('../src/shading.ts');

setLitterMaterial(() => new THREE.MeshLambertMaterial());
STREET_DETAIL.value = true; SEASON.value.x = 1;
const matrices = new Float32Array(48);
for (const [i,x] of [0,8,-8].entries()) new THREE.Matrix4().makeScale(2,5,2).setPosition(x,5,0).toArray(matrices,i*16);
const data = {count:3,big:0,shrubs:0,conifers:1,matrices,
  colours:new Float32Array(9),yearly:Float32Array.of(.2,1.1,.2),outlines:new Float32Array(24).fill(1)};
const ground = {open:(x,y)=>x>0, height:(x,y)=>.1*x+.05*y};
const litter = new StreetLitter();
const fill = () => {
  for(let i=0;i<500;i++) { litter.street(true,0,0,ground); if(!litter.pending) return; }
  throw new Error('leaf placement did not finish');
};
try {
  litter.add('tile',data); fill();
  assert.equal(litter.group.children.length,1,'all trees share one draw');
  const mesh=litter.group.children[0], g=mesh.geometry;
  const {position,corner,normal}=g.attributes, count=g.userData.leaves;
  assert(count>80 && count<=LITTER_CAPACITY,'leaves are visible and capped');
  assert(g.index.array instanceof Uint16Array,'indices stay within the 16-bit limit');
  let curled=0;
  for(let i=0;i<count*LITTER_VERTICES;i++) {
    const x=position.getX(i)+corner.getX(i), y=-position.getZ(i)-corner.getZ(i);
    const h=position.getY(i)+corner.getY(i), lift=h-ground.height(x,y);
    assert(x>0 && Math.hypot(x,y)<2.5,'no leaves inside obstacles, under evergreens or conifers');
    assert(lift>.005 && lift<.04,'each edge follows the slope and sits just above it');
    assert(normal.getY(i)>0 && Number.isFinite(normal.getX(i)),'curled faces have valid upward normals');
    if(lift>.015) curled++;
  }
  assert(curled>0,'some edges curl above the ground');
  const original=Array.from(position.array), version=position.version;
  fill(); assert.equal(mesh.geometry,g); assert.equal(position.version,version,'standing still causes no uploads');
  litter.street(false); assert(!litter.group.visible,'overhead hides detailed litter');
  SEASON.value.x=0; fill(); assert(!litter.group.visible,'no autumn leaves in summer');
  SEASON.value.x=1;
  litter.remove('tile'); fill(); assert.equal(mesh.geometry.drawRange.count,0,'unloaded trees leave no stale litter');
  litter.add('tile',data);
  // Stop during the first yielded slice; returning to street view must finish it.
  litter.pending=litter.build(litter.nearby(0,0),ground,0,0);
  litter.pending.next(); litter.street(false); fill();
  assert.deepEqual(Array.from(mesh.geometry.attributes.position.array),original,'re-entry restores the same leaves');
  assert.equal(mesh.geometry,g,'tile changes and re-entry retain the geometry');
  assert.equal(mesh.geometry.attributes.position.array,position.array,'refills retain GPU buffer identity');
  console.log(`Street litter: ${count} grounded leaves; seasons, obstacles, curled normals, stable uploads, cancellation and tile removal passed.`);
} finally { litter.dispose(); }
