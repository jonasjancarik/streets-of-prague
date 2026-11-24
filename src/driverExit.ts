import * as THREE from 'three';

export const DRIVER_STAND = .62;
// A visible seated driver and an on-foot avatar use different origins. The
// car stores the pelvis matrix that actually drew the driver, including pitch
// and cabin scale. Blend from that pose through the open door to the pedestrian.
export class DriverExit {
  elapsed = 0;
  readonly duration: number;
  private seat: THREE.Matrix4;
  private facing = new THREE.Quaternion();
  private size = new THREE.Vector3();
  private start = new THREE.Vector3();
  private door = new THREE.Vector3();

  constructor(seat: THREE.Matrix4, x: number, y: number, pulled: boolean) {
    this.seat=seat.clone();
    seat.decompose(this.start,this.facing,this.size);
    this.door.set(x,0,-y);
    this.duration=pulled ? .48 : DRIVER_STAND;
  }

  get progress() { return Math.min(1,this.elapsed/this.duration); }

  get standingWeight() { return THREE.MathUtils.smoothstep(this.progress,.45,1); }
  get seatedPhase() { return 1-THREE.MathUtils.smoothstep(this.progress,.03,.87); }

  place(root: THREE.Object3D, seatedHips: THREE.Vector3, front: THREE.Quaternion) {
    const u=THREE.MathUtils.smoothstep(this.progress,0,1), back=1-u;
    this.start.copy(seatedHips).applyQuaternion(front).negate().applyMatrix4(this.seat);
    this.door.y=(this.start.y+root.position.y)*.5;
    root.position.multiplyScalar(u*u).addScaledVector(this.door,2*u*back).addScaledVector(this.start,back*back);
    root.quaternion.slerp(this.facing,1-THREE.MathUtils.smoothstep(this.progress,.20,.95));
    root.scale.copy(this.size).lerp(UNIT,u);
  }
}
const UNIT=new THREE.Vector3(1,1,1);
