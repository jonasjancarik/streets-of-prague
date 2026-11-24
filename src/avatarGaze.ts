import * as THREE from 'three';

const up = new THREE.Vector3(0,1,0);
const shares: [string, number][] = [['Bip01_Spine2', .28], ['Bip01_Neck', .34], ['Bip01_Head', .38]];

// The feet can step sideways while the player keeps looking down the street.
// Apply a small turn above the hips, on top of the authored motion capture.
export class PlayerGaze {
  private joints: { bone: THREE.Object3D; share: number; base: THREE.Quaternion }[];
  private applied = false;
  private yaw = 0;
  private pitch = 0;
  private heading = new THREE.Vector3();
  private sight = new THREE.Vector3();
  private pitchAxis = new THREE.Vector3();
  private parentRotation = new THREE.Quaternion();
  private local = new THREE.Quaternion();
  private turn = new THREE.Quaternion();
  private tilt = new THREE.Quaternion();

  constructor(root: THREE.Object3D) {
    this.joints = shares.flatMap(([name, share]) => {
      const bone = root.getObjectByName(name);
      return bone?.parent ? [{ bone, share, base: new THREE.Quaternion() }] : [];
    });
  }

  // AnimationMixer need not rewrite a track whose sampled value is constant.
  // Return the unmodified keys before the mixer evaluates the next pose.
  restore() {
    if (!this.applied) return;
    for (const { bone, base } of this.joints) bone.quaternion.copy(base);
    this.applied = false;
  }

  release() { this.restore(); this.yaw = this.pitch = 0; }

  apply(dt: number, camera: THREE.Camera, root: THREE.Object3D, freedom: number) {
    this.heading.set(0,0,1).applyQuaternion(root.quaternion);
    camera.getWorldDirection(this.sight);
    const flat = Math.hypot(this.sight.x,this.sight.z);
    const angle = flat < .1 ? this.yaw : Math.atan2(this.heading.z*this.sight.x-this.heading.x*this.sight.z,
      this.heading.x*this.sight.x+this.heading.z*this.sight.z);
    // As the camera orbits behind the body, let the head return to its rest
    // pose before the signed angle changes sides.
    const follow = freedom*(1-THREE.MathUtils.smoothstep(Math.abs(angle),1.68,2.72));
    const targetYaw = THREE.MathUtils.clamp(angle,-.98,.98)*follow;
    const targetPitch = THREE.MathUtils.clamp(Math.atan2(this.sight.y,flat),-.30,.34)*follow;
    const ease = 1-Math.exp(-Math.max(0,dt)*9);
    this.yaw += (targetYaw-this.yaw)*ease;
    this.pitch += (targetPitch-this.pitch)*ease;
    if (Math.abs(this.yaw)+Math.abs(this.pitch) < .002 || freedom < .01) return;

    this.pitchAxis.crossVectors(this.heading,up).normalize();
    for (const { bone, share, base } of this.joints) {
      base.copy(bone.quaternion);
      bone.parent!.getWorldQuaternion(this.parentRotation);
      this.turn.setFromAxisAngle(up,this.yaw*share);
      this.tilt.setFromAxisAngle(this.pitchAxis,this.pitch*share);
      this.local.copy(this.parentRotation).invert().multiply(this.turn).multiply(this.tilt).multiply(this.parentRotation);
      bone.quaternion.premultiply(this.local);
    }
    this.applied = true;
  }
}
