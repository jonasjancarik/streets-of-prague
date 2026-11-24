import type { Walker, Crowd } from '../src/people.ts';
import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A driver clears a shared passenger door before the player gets in',
  async run(t) {
    const square: [number,number]=[50.08747,14.42108];
    await t.go(square,{heading:90});
    t.time('21:18'); t.weather('clear'); t.set({money:10000,stars:0,health:100});
    const {walker,crowd}=window.__drive as {walker:Walker; crowd:Crowd};
    const sedan=()=>t.trafficAgents().find(a=>a.car.type==='sedan')?.car;
    let car=sedan();
    for (let i=0;!car && i<40;i++) {await t.wait(.5);car=sedan();}
    if (!t.check('an occupied sedan is available',!!car) || !car) return;
    // Keep the original occupied car and normal E interaction. Stage it
    // stopped so the outcome does not depend on a traffic light or queue.
    const [x,y]=t.toLocal(square);
    Object.assign(car,{x,y,h:.35,vx:0,vy:0,w:0,level:0});
    t.toDoor(car,2,0);
    const original=new Set(crowd.people), unwall=t.wallBeside(car,1);
    try {
      t.press(); await t.wait(.42);
      const driver=crowd.people.find(p=>!original.has(p)&&Math.hypot(p.x-car.x,p.y-car.y)<6);
      t.check('the driver leaves while the player holds the door',!!driver && !car.entryDriver && walker.anim.name==='latchRight');
      if (driver) {
        const side=(driver.y-car.y)*Math.cos(car.h)-(driver.x-car.x)*Math.sin(car.h);
        t.check('the driver is outside on the clear passenger side',side < -car.spec.W/2,{side});
      }
      await t.wait(1.6);
      t.check('the player takes the seat',t.where().mode==='car' && t.probe().car?.type===car.type);
      t.check('traffic has released the car',!t.driven(car));
    } finally {unwall();if(t.where().mode==='car')t.exit();}
  },
} satisfies Scenario;
