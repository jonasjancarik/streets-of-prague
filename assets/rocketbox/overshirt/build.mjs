// Refit one Rocketbox LOD1 without re-exporting its skeleton, facial targets or animations.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const here = path.dirname(fileURLToPath(import.meta.url));
const [source, output] = process.argv.slice(2);
if (!source || !output) throw Error('Usage: node build.mjs original-male-adult-07.glb output.glb');
const raw = fs.readFileSync(source);
if (createHash('sha256').update(raw).digest('hex') !== '58f4bb4cc300bda9b829f3300ab5540b28ae42190c1183f7b98c9ae30e2d773b')
  throw Error('Expected the unmodified CodePawl male-adult-07 LOD1. Its UVs and bind transform define this outfit.');
const length = raw.readUInt32LE(12);
const doc = JSON.parse(raw.subarray(20,20+length));
const bin = raw.subarray(28+length);
const body = doc.meshes[0].primitives[0];
const attributes = body.attributes;
const extension = 'EXT_meshopt_compression';
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);

const types = {
  5120: [1,'getInt8','setInt8',127], 5121: [1,'getUint8','setUint8',255],
  5122: [2,'getInt16','setInt16',32767], 5123: [2,'getUint16','setUint16',65535],
};
const width = { SCALAR:1, VEC2:2, VEC3:3, VEC4:4 };
const align = n => Math.ceil(n/4)*4;
function read(index) {
  const a = doc.accessors[index], v = doc.bufferViews[a.bufferView], e = v.extensions[extension];
  const decoded = new Uint8Array(e.count*e.byteStride);
  MeshoptDecoder.decodeGltfBuffer(decoded,e.count,e.byteStride,bin.subarray(e.byteOffset,e.byteOffset+e.byteLength),e.mode,e.filter);
  const [size,get,,max] = types[a.componentType], data = new DataView(decoded.buffer);
  return Array.from({length:a.count},(_,i) => Array.from({length:width[a.type]},(_,j) =>
    data[get]((a.byteOffset||0)+i*e.byteStride+j*size,true)/(a.normalized?max:1)));
}

// The donor's bind shape is uniformly scaled and translated in its inverse bind matrices.
const scale = .9385263, offset = [0,.881409114,.0298564214];
const input = {xyz:read(attributes.POSITION).map(p=>p.map((v,i)=>v*scale+offset[i])),
  uv:read(attributes.TEXCOORD_0), normal:read(attributes.NORMAL), weights:read(attributes.WEIGHTS_0),
  joints:read(attributes.JOINTS_0), faces:read(body.indices).flat()};
const replacements = new Map();

function attribute(index, rows, indices=false) {
  const a=doc.accessors[index], [size,,set,max]=types[a.componentType], columns=width[a.type];
  const stride=indices?size:align(size*columns), bytes=new Uint8Array(rows.length*stride);
  const data=new DataView(bytes.buffer), min=Array(columns).fill(Infinity), top=Array(columns).fill(-Infinity);
  for (let i=0;i<rows.length;i++) {
    const row=rows[i].map(v=>Math.round(v*(a.normalized?max:1)));
    if (index===attributes.WEIGHTS_0) {
      const largest=row.indexOf(Math.max(...row));
      row[largest]+=255-row.reduce((s,w)=>s+w,0);
    }
    for (let j=0;j<columns;j++) {
      if (Math.abs(row[j])>max) throw Error('Out of range in accessor '+index);
      data[set](i*stride+j*size,row[j],true);
      min[j]=Math.min(min[j],row[j]);top[j]=Math.max(top[j],row[j]);
    }
  }
  const mode=indices?'TRIANGLES':'ATTRIBUTES';
  const packed=MeshoptEncoder.encodeGltfBuffer(bytes,rows.length,stride,mode);
  // The original index view contains all three primitives. Give the edited body its own view.
  const v={buffer:1,byteLength:bytes.length,target:indices?34963:34962,
    extensions:{[extension]:{buffer:0,byteLength:packed.length,mode,byteStride:stride,count:rows.length}}};
  if (!indices) v.byteStride=stride;
  a.bufferView=doc.bufferViews.push(v)-1;a.byteOffset=0;a.count=rows.length;
  if (a.min) a.min=min;
  if (a.max) a.max=top;
  replacements.set(a.bufferView,packed);
}

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rocketbox-overshirt-'));
try {
  const file=n=>path.join(temp,n);
  fs.writeFileSync(file('in.json'),JSON.stringify(input));
  execFileSync(process.env.BLENDER||'blender',['-b','--factory-startup','-t','2','--python-exit-code','1',
    '-P',path.join(here,'tailor.py'),'--',file('in.json'),file('out.json')],{stdio:'inherit'});
  const fit=JSON.parse(fs.readFileSync(file('out.json')));
  attribute(attributes.POSITION,fit.xyz.map(p=>p.map((v,i)=>(v-offset[i])/scale)));
  attribute(attributes.NORMAL,fit.normal);
  attribute(attributes.TEXCOORD_0,fit.uv);
  attribute(attributes.JOINTS_0,fit.joints);
  attribute(attributes.WEIGHTS_0,fit.weights);
  attribute(body.indices,fit.faces.map(i=>[i]),true);
  // Facial expressions affect the face. Keep the body deltas zero for every new vertex as well.
  for (const target of body.targets) for (const index of Object.values(target)) {
    const a=doc.accessors[index];
    if ([...a.min,...a.max].some(v=>v!==0)) throw Error('Unexpected nonzero body morph');
    delete a.bufferView;delete a.byteOffset;a.count=fit.xyz.length;
  }
  const venv=path.resolve(here,'../../../pipeline/.venv/bin/python');
  execFileSync(process.env.PYTHON||(fs.existsSync(venv)?venv:'python3'),[path.join(here,'materials.py'),temp],{stdio:'inherit'});
  const replaceTexture=(texture,name)=>{
    const image=doc.images[doc.textures[texture.index].extensions.KHR_texture_basisu.source];
    image.name=name;
    replacements.set(image.bufferView,fs.readFileSync(file(name+'.ktx2')));
  };
  const [jacket,face]=doc.materials;
  replaceTexture(jacket.pbrMetallicRoughness.baseColorTexture,'body');
  replaceTexture(jacket.normalTexture,'body-normal');
  replaceTexture(face.pbrMetallicRoughness.baseColorTexture,'head');
  jacket.pbrMetallicRoughness.roughnessFactor=.89;
  face.pbrMetallicRoughness.roughnessFactor=.82;
  face.normalTexture.scale=.7;
  // The cropped hair is on the scalp. The five rows of spiked hair cards from the
  // donor leave dark floating stripes in close-up and cost an alpha-tested draw.
  doc.meshes[0].primitives.pop();
  doc.materials.pop();doc.textures.pop();doc.images.pop();

  // Compact the primitives' live accessors and views. This also drops the original
  // body streams replaced above and the hair card texture and morph data.
  const usedAccessors = new Set();
  function eachAccessor(visit) {
    for (const mesh of doc.meshes) for (const part of mesh.primitives) {
      part.indices=visit(part.indices);
      for (const fields of [part.attributes,...part.targets]) {
        for (const key of Object.keys(fields)) fields[key]=visit(fields[key]);
      }
    }
    for (const skin of doc.skins) skin.inverseBindMatrices=visit(skin.inverseBindMatrices);
  }
  eachAccessor(i=>{usedAccessors.add(i);return i;});
  const accessors=[...usedAccessors].sort((a,b)=>a-b), accessorMap=new Map(accessors.map((a,i)=>[a,i]));
  eachAccessor(i=>accessorMap.get(i));
  doc.accessors=accessors.map(i=>doc.accessors[i]);
  const viewUsers=[...doc.accessors,...doc.images].filter(obj=>obj.bufferView!==undefined);
  const views=[...new Set(viewUsers.map(obj=>obj.bufferView))].sort((a,b)=>a-b);
  const viewMap=new Map(views.map((v,i)=>[v,i]));
  for (const obj of viewUsers) obj.bufferView=viewMap.get(obj.bufferView);


  let at=0, fallback=0;
  const bins=[];
  for (const i of views) {
    const v=doc.bufferViews[i];
    const e=v.extensions?.[extension], stored=e||v;
    const bytes=replacements.get(i)||bin.subarray(stored.byteOffset||0,(stored.byteOffset||0)+stored.byteLength);
    if (e) {v.byteOffset=fallback;fallback+=align(v.byteLength);}
    stored.byteOffset=at;stored.byteLength=bytes.length;
    bins.push(bytes,Buffer.alloc(align(bytes.length)-bytes.length));at+=align(bytes.length);
  }
  doc.bufferViews=views.map(i=>doc.bufferViews[i]);
  doc.buffers[0].byteLength=at;doc.buffers[1].byteLength=fallback;
  const json=Buffer.from(JSON.stringify(doc)), header=Buffer.alloc(20), chunk=Buffer.alloc(8);
  header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+align(json.length)+at,8);
  header.writeUInt32LE(align(json.length),12);header.write('JSON',16);
  chunk.writeUInt32LE(at);chunk.write('BIN\0',4);
  fs.writeFileSync(output,Buffer.concat([header,json,Buffer.alloc(align(json.length)-json.length,32),chunk,...bins]));
  console.log(output,fit.faces.length/3,'body triangles,',at,'binary bytes');
} finally {
  fs.rmSync(temp,{recursive:true,force:true});
}
