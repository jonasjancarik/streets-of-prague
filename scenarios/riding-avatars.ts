import { Matrix4, Vector3, type Object3D, type Scene, type SkinnedMesh, type InstancedMesh } from 'three';
import { CarPool, type Car } from '../src/car.ts';
import { SCALE } from '../src/figures.ts';
import type { Walker } from '../src/people.ts';
import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'The same street avatar rides, coasts and dismounts a bicycle and motorbike',
  async run(t) {
    const g = window.__drive as { walker: Walker; scene: Scene; carPool: CarPool };
    const wasPaused=t.paused, wasDt=t.frameDt, square: [number,number]=[50.08747,14.42108];
    await t.go(square,{heading:90});
    t.paused=true; t.eyes={yaw:45,pitch:0,third:true};
    const riders=()=>g.scene.getObjectByName('rocketbox')?.children.filter(o=>o.visible && o.getObjectByName('Bip01')) ?? [];
    const nearby=(x:number,y:number)=>riders().find(o=>Math.hypot(o.position.x-x,o.position.z+y)<.035);
    const waitFor=async(test:()=>Object3D|undefined)=>{
      const until=performance.now()+40000;
      while (!test() && performance.now()<until) await t.frames(2);
      return test();
    };
    const step=async(move:number,turn=0)=>{t.frameDt=1/30;await t.wait(1/30,{move,turn});};
    const frame = (c:Car) => {
      for (const [key,list] of g.carPool.groups) {
        const index=list.indexOf(c); if (index<0) continue;
        const page=g.carPool.meshes.get(key)![Math.floor(index/CarPool.pageCapacity)];
        const m=new Matrix4(); page.getMatrixAt(index%CarPool.pageCapacity,m);
        return m.scale(new Vector3(SCALE,SCALE,SCALE)).invert();
      }
      throw Error('Missing two-wheeler draw');
    };
    try {
      const player=await waitFor(()=>nearby(g.walker.x,g.walker.y));
      if (!t.check('player model loaded on foot',!!player) || !player) return;
      const skin=(model:Object3D|undefined)=>(model?.getObjectByProperty('isSkinnedMesh',true) as SkinnedMesh|undefined)?.geometry;
      const identity=skin(player);
      let mounted=player;
      const contact=(side:string,bone:string)=>mounted.getObjectByName('Bip01_'+side+'_'+bone)!.getWorldPosition(new Vector3());
      for (const kind of ['bike','moto'] as const) {
        const bike=kind==='bike', c=await t.drive(kind), [x,y]=t.toLocal(square);
        Object.assign(c,{x,y,h:0,vx:0,vy:0,w:0,level:0});
        await t.frames(10);
        const current=nearby(c.x,c.y);
        if (!t.check(kind+' keeps the walking avatar on the saddle',!!current && skin(current)===identity) || !current) return;
        mounted=current;
        const stopped=contact('L','Foot').lerp(contact('L','Toe0'),.55).applyMatrix4(frame(c));
        t.check(kind+' balances on a planted shoe at rest',Math.abs(stopped.y-.045)<.025,{shoeHeight:stopped.y});
        t.push(bike?14:20,90);
        for (let i=0;i<32;i++) await step(.45);
        const start=c.anim!.t;
        let handError=0,footError=0;
        for (let i=0;i<24;i++) {
          await step(.45,i<10?.25:0);
          const inverse=frame(c), theta=Math.PI/2-2*Math.PI*c.anim!.t/c.anim!.duration;
          for (const [side,sign] of [['L',1],['R',-1]] as const) {
            const palm=contact(side,'Hand').lerp(contact(side,'Finger2'),.82).applyMatrix4(inverse);
            const sole=contact(side,'Foot').lerp(contact(side,'Toe0'),.55).applyMatrix4(inverse);
            const target=bike?new Vector3(-.03+sign*.17*Math.cos(theta),.345+sign*.17*Math.sin(theta),-sign*.11):new Vector3(-.12,.425,-sign*.19);
            footError=Math.max(footError,sole.distanceTo(target));
            handError=Math.max(handError,palm.distanceTo(bike?new Vector3(.37,1.052,-sign*.25):new Vector3(.33,1.042,-sign*.32)));
          }
        }
        t.check(kind+' advances the riding clip',c.anim!.t-start>.25);
        t.check(kind+' keeps palms and shoes on the vehicle through a turn',handError<.04 && footError<.04,{handError,footError});
        if (bike) {
          const inverse=frame(c), theta=Math.PI/2-2*Math.PI*c.anim!.t/c.anim!.duration;
          const target=new Vector3(-.03+.17*Math.cos(theta),.30+.17*Math.sin(theta),-.11);
          let nearest=Infinity;
          g.scene.traverseVisible(o=>{
            if (o.name!=='Bicycle cranks and pedals') return;
            const mesh=o as InstancedMesh, matrix=new Matrix4(), centre=new Vector3();
            // Odd instances are the level platforms, even instances their arms.
            for (let i=1;i<mesh.count;i+=2) {
              mesh.getMatrixAt(i,matrix);
              nearest=Math.min(nearest,centre.setFromMatrixPosition(matrix).applyMatrix4(inverse).distanceTo(target));
            }
          });
          t.check('the moving pedal meets the shoe on the same crank phase',nearest<.005,{nearest});
          await step(0);const phase=c.anim!.t;
          for (let i=0;i<8;i++) await step(0);
          t.check('coasting holds the crank and the feet',c.speed>1 && Math.abs(c.anim!.t-phase)<.00001);
        }
        t.eyes=null; await t.frames(4);
        t.check(kind+' uses the instanced rider overhead',!mounted.visible && g.carPool.riders.mesh.count>0);
        if (bike) t.check('the separate crank batch retires overhead',!g.scene.getObjectByName('Bicycle cranks and pedals')?.visible);
        t.eyes={yaw:0,pitch:0,third:true};await t.frames(5);
        c.vx=c.vy=c.w=0;t.exit();await t.frames(6);
        const dismounted=nearby(g.walker.x,g.walker.y);
        t.check(kind+' restores the same outfit on dismount',!!dismounted && skin(dismounted)===identity);
      }
      // Packed order can change, and identical clothing is not an actor ID.
      const bike=t.car('bike',{ahead:4}), moto=t.car('moto',{ahead:6});
      const look={...g.walker.look};
      for (const [c,side] of [[bike,-1],[moto,1]] as const) {
        Object.assign(c,{x:g.walker.x+4,y:g.walker.y+side*2,h:0,vx:0,vy:0,level:0,rider:look});
      }
      t.frameDt=undefined;
      const cyclist=await waitFor(()=>nearby(bike.x,bike.y)), motorcyclist=await waitFor(()=>nearby(moto.x,moto.y));
      t.check('two nearby riders can share an outfit and keep independent poses',
        !!cyclist && !!motorcyclist && cyclist!==motorcyclist && skin(cyclist)===skin(motorcyclist));
      bike.rider=null;await t.frames(4);
      t.check('changing the packed rider order retains the motorcyclist',!!motorcyclist && nearby(moto.x,moto.y)===motorcyclist);
    } finally { t.eyes=null;t.paused=wasPaused;t.frameDt=wasDt; }
  },
} satisfies Scenario;
