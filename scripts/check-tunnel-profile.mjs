// Python's frozen clean-source export through the actual runtime decoder/sampler.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {decodeLevels, heightSampler} from '../src/terrain.ts';
import {onPolygons} from '../src/map/geo.ts';
const c=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const samples=[];
for(const [fraction,kind,want] of [[.6,'tunnel',NaN],[.8,'tunnel',199.4],[.95,'bridge',204.06058475]]) {
  const p=c.probes.find(p=>p.fraction===fraction);
  const tile=c.tiles.find(t=>p.x>=t.box[0]&&p.x<=t.box[2]&&p.y>=t.box[1]&&p.y<=t.box[3]);
  assert.ok(tile,'source tile exists');
  const b=Buffer.from(tile.encoded_levels_base64,'base64');
  const heights=decodeLevels(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),c.n,tile.structures.length,c.ref);
  const index=tile.structures.findIndex(s=>s.kind===kind&&onPolygons(s.polys)(p.x,p.y));
  assert.ok(index>=0,`missing ${kind} at ${fraction}`);
  const height=heightSampler(heights[index],tile.box,c.n,c.step)(p.x,p.y)+c.ref;
  if(Number.isNaN(want))assert.ok(Number.isNaN(height),'legacy unknown region must remain explicit');
  else assert.ok(Number.isFinite(height)&&Math.abs(height-want)<2e-5,`${fraction}: ${height} expected ${want}`);
  samples.push({fraction,level:tile.structures[index].level,kind,height:Number.isNaN(height)?null:height});
}
console.log(JSON.stringify({runtimeDecodePassed:true,samples},null,2));
