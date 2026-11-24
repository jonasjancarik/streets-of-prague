// Fit the authored riding motion to the two adult skeletons offline. Hands
// hold the grips and the balls of the feet follow the cranks or rest on pegs.
import * as T from 'three';
import { glbSkeleton } from './format.mjs';

const point = bone => bone.getWorldPosition(new T.Vector3());
const rotation = bone => bone.getWorldQuaternion(new T.Quaternion());
function turn(bone, orientation) {
  bone.quaternion.copy(rotation(bone.parent).invert().multiply(orientation)).normalize();
}
function aim(bone, tip, direction) {
  const from = point(tip).sub(point(bone)).normalize();
  const swing = new T.Quaternion().setFromUnitVectors(from, direction.clone().normalize());
  turn(bone, swing.multiply(rotation(bone)));
}
function basis(forward, across) {
  const x = forward.clone().normalize(), z = new T.Vector3().crossVectors(x, across).normalize();
  return new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(x, z.clone().cross(x), z));
}
function reach(upper, lower, end, goal) {
  const hip = point(upper), knee = point(lower), ankle = point(end);
  const a = hip.distanceTo(knee), b = knee.distanceTo(ankle);
  const axis = goal.clone().sub(hip), distance = axis.length();
  axis.normalize();
  const length = T.MathUtils.clamp(distance, Math.abs(a-b)+.00001, a+b-.00001);
  const bend = knee.clone().sub(hip);
  bend.addScaledVector(axis,-bend.dot(axis)).normalize();
  const along = (a*a-b*b+length*length)/(2*length);
  const joint = hip.clone().addScaledVector(axis,along).addScaledVector(bend,Math.sqrt(Math.max(0,a*a-along*along)));
  aim(upper,lower,joint.clone().sub(hip));
  aim(lower,end,hip.addScaledVector(axis,length).sub(point(lower)));
}
export function fittedRidingClips(mode, fps, positions, names, rotations, asset) {
  const clips=[], data=[], frames=positions.length/3, bike=mode==='bike';
  for (const [sex,model] of [['f','female-adult-01'],['m','male-adult-01']]) for (const stopped of [false,true]) {
    const {root}=glbSkeleton(asset('rocketbox/'+model+'.glb'));
    root.rotation.y=Math.PI/2;
    const bone=name=>root.getObjectByName(name), hips=bone('Bip01'), height=hips.position.y;
    const rig=names.map(bone), joints=[...rig], restOffset=new T.Vector3();
    const sides=['L','R'].map((s,i)=>{
      const get=name=>bone('Bip01_'+s+'_'+name);
      const wrist=get('Hand'), middle=get('Finger2'), index=get('Finger1'), little=get('Finger4');
      const local=b=>wrist.worldToLocal(point(b));
      const palm=local(middle).multiply(wrist.getWorldScale(new T.Vector3())).multiplyScalar(.82);
      const frame=basis(local(middle),local(little).sub(local(index)));
      const sign=i===0?1:-1;
      const grip=bike?new T.Vector3(.37,1.03,-sign*.25):new T.Vector3(.33,1.02,-sign*.32);
      const fingers=[];
      for (let f=0;f<5;f++) for (const suffix of ['','1','2']) {
        const digit=get('Finger'+f+suffix);
        if (digit) { joints.push(digit); fingers.push({digit,f,suffix}); }
      }
      joints.push(wrist);
      return {get,sign,grip,palm,wrist,orient:basis(new T.Vector3(1,-.26,0),new T.Vector3(0,0,-sign)).multiply(frame.invert()),fingers};
    });
    const rests=joints.map(b=>b.quaternion.clone()), keys=joints.map(()=>[]), pos=[];
    for (let frame=0;frame<frames;frame++) {
      joints.forEach((b,i)=>b.quaternion.copy(rests[i]));
      hips.position.fromArray(positions,frame*3).multiplyScalar(height);
      rig.forEach((b,i)=>b.quaternion.fromArray(rotations[i],frame*4));
      // Seat height is a property of the vehicle. Preserve the small weight
      // shift in the source clip while placing each skeleton on its saddle.
      const at=point(hips);
      if (frame===0) {
        const seat=bike?new T.Vector3(-.23,.975,0):new T.Vector3(-.17,.93,0);
        // A cyclist moves forward off the saddle when stopping. On the
        // motorbike the rider shifts to the left edge of the wider seat.
        if (stopped) seat.set(bike ? -.045 : -.20, bike ? .84 : .835, bike ? -.045 : -.13);
        restOffset.copy(seat).sub(at);
      }
      hips.position.copy(hips.parent.worldToLocal(at.add(restOffset)));
      // Lean at the chest rather than overextending the elbows to reach the
      // handlebars. Keep the captured sightline as the chest pitches forward.
      const spine=bone('Bip01_Spine1'), neck=bone('Bip01_Neck');
      const chestTurn=rotation(spine), neckTurn=rotation(neck);
      const lean=angle=>turn(spine,new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1),-angle).multiply(chestTurn));
      const reaches=()=>sides.every(({get,grip,palm,orient})=>{
        const shoulder=point(get('UpperArm')), elbow=point(get('Forearm')), wrist=point(get('Hand'));
        const target=grip.clone().add(new T.Vector3(0,.022,0)).sub(palm.clone().applyQuaternion(orient));
        return shoulder.distanceTo(target)<.955*(shoulder.distanceTo(elbow)+elbow.distanceTo(wrist));
      });
      if (!reaches()) {
        let lo=0, hi=.95;
        for (let n=0;n<12;n++) { const mid=(lo+hi)/2; lean(mid); if (reaches()) hi=mid; else lo=mid; }
        lean(hi); turn(neck,neckTurn);
      }
      for (const {get,sign,grip,palm,wrist,orient,fingers} of sides) {
        const wristAt=grip.clone().add(new T.Vector3(0,.022,0)).sub(palm.clone().applyQuaternion(orient));
        reach(get('UpperArm'),get('Forearm'),wrist,wristAt);
        turn(wrist,orient);
        // Four fingers wrap over the forward face of the bar; the thumb
        // opposes them on the rider's side. Keep the original finger spacing.
        for (const {digit,f,suffix} of fingers) {
          const tip=digit.children[0];
          if (!tip) continue;
          const angle=(f===0?[-108,-68,-30]:[-38,-93,-148])[suffix===''?0:Number(suffix)]*Math.PI/180;
          aim(digit,tip,new T.Vector3(Math.cos(angle),Math.sin(angle),f===0?sign*.38:0));
        }
        const ankle=get('Foot'), toe=get('Toe0'), footTurn=rotation(ankle);
        const phase=Math.PI/2-2*Math.PI*frame/(frames-1)+(sign<0?Math.PI:0);
        const pedal=bike?new T.Vector3(-.03+.17*Math.cos(phase),.30+.17*Math.sin(phase),-sign*.11)
                        :new T.Vector3(-.12,.38,-sign*.19);
        const sole=point(toe).sub(point(ankle)).multiplyScalar(.55);
        if (stopped && sign===1) pedal.set(bike ? -.035 : -.20,0,-(bike ? .255 : .30));
        if (bike || (stopped && sign===1)) {
          const pitch=stopped && sign===1 ? -.14 : -.12-.43*(1-Math.sin(phase))*.5;
          const tilt=new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1),pitch-Math.atan2(sole.y,sole.x));
          sole.applyQuaternion(tilt); footTurn.premultiply(tilt);
        }
        reach(get('Thigh'),get('Calf'),ankle,pedal.add(new T.Vector3(0,.045,0)).sub(sole));
        turn(ankle,footTurn);
      }
      pos.push(...hips.position.clone().divideScalar(height).toArray());
      joints.forEach((b,i)=>{
        const q=b.quaternion.clone().normalize(), values=keys[i];
        if (frame && q.dot(new T.Quaternion().fromArray(values,values.length-4))<0) q.set(-q.x,-q.y,-q.z,-q.w);
        values.push(...q.toArray());
      });
    }
    const motion=[],still=[],movingData=[],stillData=[];
    keys.forEach((values,i)=>{
      const packed=Int16Array.from(values,v=>Math.round(v*32767));
      if (packed.every((v,j)=>Math.abs(v-packed[j%4])<=1)) {still.push(joints[i].name);stillData.push(packed.slice(0,4));}
      else {motion.push(joints[i].name);movingData.push(packed);}
    });
    clips.push({name:mode+(stopped?'Stand':'')+(sex==='m'?'Male':''),fps,frames,joints:motion,still});
    data.push(Int16Array.from(pos,v=>Math.round(v*1000)),...movingData,...stillData);
  }
  return {clips,data};
}
