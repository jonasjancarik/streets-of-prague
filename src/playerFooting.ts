import * as THREE from 'three';

export type FootGround = (x: number, z: number) => number;

class Leg {
  offset = 0;
  private base = [new THREE.Quaternion(),new THREE.Quaternion(),new THREE.Quaternion()];
  private applied = false;
  private planted = false;
  private plantX = 0;
  private plantZ = 0;
  private hip = new THREE.Vector3();
  private knee = new THREE.Vector3();
  private ankle = new THREE.Vector3();
  private target = new THREE.Vector3();
  private bend = new THREE.Vector3();
  private axis = new THREE.Vector3();
  private from = new THREE.Vector3();
  private toward = new THREE.Vector3();
  private parent = new THREE.Quaternion();
  private change = new THREE.Quaternion();
  private inverseParent = new THREE.Quaternion();
  private ankleTurn = new THREE.Quaternion();
  private soleNormal = new THREE.Vector3(0,1,0);
  private measuredNormal = new THREE.Vector3();
  private soleTilt = new THREE.Quaternion();
  private toeAt = new THREE.Vector3();

  private thigh: THREE.Object3D;
  private shin: THREE.Object3D;
  private foot: THREE.Object3D;
  private toe?: THREE.Object3D;
  constructor(thigh: THREE.Object3D, shin: THREE.Object3D, foot: THREE.Object3D, toe?: THREE.Object3D) {
    this.thigh=thigh; this.shin=shin; this.foot=foot; this.toe=toe;
  }

  reset() { this.restore(); this.offset=0; this.planted=false; this.soleNormal.set(0,1,0); }

  restore() {
    if (!this.applied) return;
    this.thigh.quaternion.copy(this.base[0]); this.shin.quaternion.copy(this.base[1]); this.foot.quaternion.copy(this.base[2]);
    this.applied = false;
  }

  private rotate(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3) {
    bone.parent!.getWorldQuaternion(this.parent);
    this.change.setFromUnitVectors(from.normalize(),to.normalize());
    this.change.premultiply(this.inverseParent.copy(this.parent).invert()).multiply(this.parent);
    bone.quaternion.premultiply(this.change);
  }

  pose(dt: number, ground: FootGround, floor: number, weight: number, contact: number) {
    if (weight<.01) return;
    this.foot.getWorldPosition(this.ankle);
    let x=this.ankle.x, z=this.ankle.z;
    if (contact>0) {
      // During toe-off the ankle rotates about the ball of the foot. Hold
      // the sole there, allowing the heel to lift with the captured motion.
      const sole=this.toe ? this.toe.getWorldPosition(this.toeAt) : this.ankle;
      if (!this.planted || Math.hypot(sole.x-this.plantX,sole.z-this.plantZ)>.55) {
        this.plantX=sole.x; this.plantZ=sole.z;
      }
      const dx=this.plantX-sole.x, dz=this.plantZ-sole.z;
      const follow=Math.min(1,.20/(Math.hypot(dx,dz)||1))*contact;
      x+=dx*follow; z+=dz*follow;
    }
    this.planted=contact>0;
    const height=ground(x,z), difference=height-floor;
    if (!Number.isFinite(difference) || Math.abs(difference) >= .30) { this.reset(); return; }
    // Walking animation supplies the swing and toe-off. Only add the change
    // in the surface since the hips' ground sample. Never reach into a drop.
    const ease=1-Math.exp(-18*Math.max(0,dt));
    this.offset += (difference*weight-this.offset)*ease;
    this.measuredNormal.set(0,1,0);
    const planted=weight*(1-THREE.MathUtils.smoothstep(this.ankle.y-floor,.16,.32));
    if (this.toe && planted>.01) {
      this.toe.getWorldPosition(this.toeAt).sub(this.ankle);
      const span=Math.hypot(this.toeAt.x,this.toeAt.z);
      if (span>.03) {
        const fx=this.toeAt.x/span, fz=this.toeAt.z/span;
        const along=(ground(x+fx*.20,z+fz*.20)-height)/.20;
        const across=(ground(x-fz*.14,z+fx*.14)-height)/.14;
        // A step edge is not a ramp. Leave the shoe's own roll on a broken
        // or missing patch; its altitude still follows the floor at the ankle.
        if (Number.isFinite(along+across) && Math.hypot(along,across)<.55)
          this.measuredNormal.set(-(along*fx-across*fz)*planted,1,-(along*fz+across*fx)*planted).normalize();
      }
    }
    this.soleNormal.lerp(this.measuredNormal,ease).normalize();
    if (Math.abs(this.offset)<.008 && this.soleNormal.y>.9995 && Math.abs(x-this.ankle.x)+Math.abs(z-this.ankle.z)<.002) return;
    this.thigh.getWorldPosition(this.hip); this.shin.getWorldPosition(this.knee);
    this.target.set(x,this.ankle.y+this.offset,z);
    this.axis.subVectors(this.target,this.hip);
    const distance=this.axis.length(), upper=this.hip.distanceTo(this.knee), lower=this.knee.distanceTo(this.ankle);
    if (distance<.01 || upper<.01 || lower<.01) return;
    this.axis.divideScalar(distance);
    this.bend.subVectors(this.knee,this.hip);
    this.bend.addScaledVector(this.axis,-this.bend.dot(this.axis));
    // An exactly straight chain has no reliable bend plane.
    if (this.bend.lengthSq()<.00001) return;
    this.bend.normalize();
    // The two fixed-length bones and the hip-to-ankle line form a triangle.
    // Place the knee on its original bend side, then turn each joint in its
    // parent frame. The mocap's toe-off survives the small ground tilt.
    const reach=THREE.MathUtils.clamp(distance,Math.abs(upper-lower)+.0001,upper+lower-.0001);
    const along=(reach*reach+upper*upper-lower*lower)/(2*reach);
    this.bend.multiplyScalar(Math.sqrt(Math.max(0,upper*upper-along*along))).addScaledVector(this.axis,along);
    this.target.copy(this.hip).addScaledVector(this.axis,reach);
    this.base[0].copy(this.thigh.quaternion); this.base[1].copy(this.shin.quaternion); this.base[2].copy(this.foot.quaternion);
    this.foot.getWorldQuaternion(this.ankleTurn);
    this.ankleTurn.premultiply(this.soleTilt.setFromUnitVectors(UP,this.soleNormal));
    this.rotate(this.thigh,this.from.subVectors(this.knee,this.hip),this.toward.copy(this.bend));
    this.shin.getWorldPosition(this.knee); this.foot.getWorldPosition(this.ankle);
    this.rotate(this.shin,this.from.subVectors(this.ankle,this.knee),this.toward.subVectors(this.target,this.knee));
    this.foot.parent!.getWorldQuaternion(this.parent);
    this.foot.quaternion.copy(this.parent.invert().multiply(this.ankleTurn));
    this.applied = true;
  }
}

const UP = new THREE.Vector3(0,1,0);

export class PlayerFooting {
  private legs: Leg[] = [];
  constructor(root: THREE.Object3D) {
    for (const side of ['L','R']) {
      const bone = (name: string) => root.getObjectByName(`Bip01_${side}_${name}`);
      const thigh=bone('Thigh'), shin=bone('Calf'), foot=bone('Foot');
      if (thigh?.parent && shin?.parent && foot?.parent) this.legs.push(new Leg(thigh,shin,foot,bone('Toe0')));
    }
  }
  restore() { for (const leg of this.legs) leg.restore(); }
  release() { for (const leg of this.legs) leg.reset(); }
  apply(dt: number, ground: FootGround, floor: number, weight: number, phase=0, lock=0) {
    for (const [i,leg] of this.legs.entries()) {
      const step=phase-i*.5;
      const contact=lock*(1-THREE.MathUtils.smoothstep(Math.abs(step-Math.round(step)),.095,.175));
      leg.pose(dt,ground,floor,weight,contact);
    }
  }
}
