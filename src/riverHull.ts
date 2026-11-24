import * as THREE from 'three';
import { strut, type Point3 } from './vehicleFittings.ts';
import { letteringGeometry } from './vehicleLettering.ts';

type Surface = (geometry: THREE.BufferGeometry, colour: string, glow?: number) => void;
type Box = (length: number, height: number, width: number, x: number, y: number, z: number, colour: string) => void;

// Longitudinal stations of the sightseeing boat. At the bow the waterline
// finishes short of the deck, and the topsides flare out above the bilge.
const length = 34, halfBeam = 3.2;
const stations = [
  // Fraction of length, fraction of beam, rise of the deck edge in metres.
  [-.5,.68,.10],[-.486,.82,.07],[-.45,.94,.035],[-.34,.995,.005],
  [-.16,1,0],[.12,1,0],[.26,.995,.012],[.335,.95,.042],
  [.395,.81,.095],[.44,.61,.16],[.473,.36,.23],[.491,.15,.29],[.5,.008,.325],
];
const widthAt = (s: number[]) => s[1]*halfBeam;
const deckAt = (s: number[]) => 1.55+s[2];
const distantSections = [0,2,4,5,7,9,11,12].map(i=>stations[i]);
const shell = (s: number[], side: number, y: number, width: number, rake: number): Point3 => {
  const bow = Math.max(0,(s[0]-.22)/.28), stern = Math.max(0,(-s[0]-.34)/.16);
  return [s[0]*length-rake*(1.12*bow*bow-.38*stern*stern),y,side*widthAt(s)*width];
};
type Edge = (s: number[],side: number) => Point3;

function skin(sections: number[][], low: Edge, high: Edge, capEnds=true) {
  const positions: number[] = [], indices: number[] = [];
  for (const side of [-1,1]) {
    const start=positions.length/3;
    for (const s of sections) positions.push(...low(s,side),...high(s,side));
    for (let i=0;i<sections.length-1;i++) {
      const a=start+i*2;
      if (side===1) indices.push(a,a+2,a+3,a,a+3,a+1);
      else indices.push(a,a+3,a+2,a,a+1,a+3);
    }
  }
  // Hard normals on the transom and stem.
  for (const end of capEnds ? [0,sections.length-1] : []) {
    const s=sections[end], a=positions.length/3;
    positions.push(...low(s,-1),...low(s,1),...high(s,1),...high(s,-1));
    if (end===0) indices.push(a,a+1,a+2,a,a+2,a+3);
    else indices.push(a,a+2,a+1,a,a+3,a+2);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3)); g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

export function cruiserHull(close: boolean, add: Surface, box: Box) {
  const sections=close?stations:distantSections;
  const base: Edge = (s,side)=>shell(s,side,-.55,.70,1);
  const chine: Edge = (s,side)=>shell(s,side,.04,.89,.67);
  const boot: Edge = (s,side)=>shell(s,side,.47+.06*s[2],.965,.35);
  const shoulder: Edge = (s,side)=>shell(s,side,deckAt(s)-.16,.998,.03);
  const rail: Edge = (s,side)=>shell(s,side,deckAt(s)-.12,1.012,.012);
  const rim: Edge = (s,side)=>shell(s,side,deckAt(s)-.057,1.012,0);
  const top: Edge = (s,side)=>shell(s,side,deckAt(s),1,0);
  if (close) {
    add(skin(sections,base,chine),'#314548');
    add(skin(sections,chine,boot),'#223c4c');
    // A softer cool edge just above the boot stripe. Bake the paint into the
    // existing vertex colours so sunlight and the night lamps still shade it.
    const paint = skin(sections,boot,shoulder), p=paint.attributes.position;
    const colours=new Float32Array(p.count*3);
    const lower=new THREE.Color('#c5cdca'), upper=new THREE.Color('#eeede6'), tint=new THREE.Color();
    for (let i=0;i<p.count;i++) {
      const level=THREE.MathUtils.smoothstep(p.getY(i),.48,1.45);
      tint.copy(lower).lerp(upper,level).toArray(colours,i*3);
    }
    paint.setAttribute('color',new THREE.BufferAttribute(colours,3)); add(paint,'#e7e6df');
    add(skin(sections,shoulder,rail),'#9da9aa');
    add(skin(sections,rail,rim),'#384549');
    add(skin(sections,rim,top),'#bdc6c2');
  } else {
    add(skin(sections,base,boot),'#223c4c');
    add(skin(sections,boot,top),'#e7e6df');
  }
  const inner: Edge = (s,side)=>[s[0]*length,deckAt(s),side*Math.max(0,widthAt(s)-.16)];
  add(skin(sections,top,inner,false),'#dbdbce');

  const deck = new THREE.BufferGeometry(), pos: number[]=[], ix: number[]=[];
  for (const s of sections) pos.push(...inner(s,1),...inner(s,-1));
  for (let i=0;i<sections.length-1;i++) {
    const a=i*2; ix.push(a,a+2,a+3,a,a+3,a+1);
  }
  deck.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  deck.setIndex(ix); deck.computeVertexNormals(); add(deck,'#aa9379');
  sternEnsign(add,close);
  if (!close) return;

  // Interpolate the same section curve under each deck fitting.
  const section = (x: number) => {
    const at=x/length, j=stations.findIndex(s=>s[0]>=at);
    const a=stations[Math.max(0,j-1)], b=stations[j<0?stations.length-1:j];
    const t=(at-a[0])/(b[0]-a[0]||1);
    return [at,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];
  };
  const port = letteringGeometry(['PRAHA'],.040);
  const letters=port.attributes.position;
  const low=boot(stations[0],1), high=shoulder(stations[0],1);
  for (let i=0;i<letters.count;i++) {
    const z=letters.getX(i),y=.94+letters.getY(i);
    letters.setXYZ(i,THREE.MathUtils.lerp(low[0],high[0],(y-low[1])/(high[1]-low[1]))-.011,y,z);
  }
  port.computeVertexNormals(); add(port,'#263f4a');
  const plank = new THREE.BufferGeometry(), lines: number[]=[];
  // Only the exposed foredeck and afterdeck need visible plank seams.
  for (const [start,end] of [[-16.92,-12.9],[11.73,16.83]]) {
    const sections=[section(start),...stations.filter(s=>s[0]*length>start && s[0]*length<end),section(end)];
    for (let z=-2.94;z<=2.95;z+=.155) {
      for (let i=1;i<sections.length;i++) {
        let a=sections[i-1],b=sections[i];
        const limit=Math.abs(z)+.095,w1=widthAt(a),w2=widthAt(b);
        if (w1<limit && w2<limit) continue;
        if ((w1<limit)!==(w2<limit)) {
          const edge=section(length*(a[0]+(b[0]-a[0])*(limit-w1)/(w2-w1)));
          if (w1<limit) a=edge; else b=edge;
        }
        const xa=a[0]*length, xb=b[0]*length, ya=deckAt(a)+.003,yb=deckAt(b)+.003;
        lines.push(xa,ya,z+.006, xb,yb,z+.006, xb,yb,z-.006, xa,ya,z+.006, xb,yb,z-.006, xa,ya,z-.006);
      }
    }
  }
  plank.setAttribute('position',new THREE.Float32BufferAttribute(lines,3)); plank.computeVertexNormals();
  add(plank,'#6c6256');

  for (const side of [-1,1]) {
    for (const [from,to,step] of [[-16.25,-13.1,1.05],[11.9,16.2,1.075]]) {
      let previous: Point3 | undefined;
      for (let x=from;x<=to+.001;x+=step) {
        const s=section(x),z=side*(widthAt(s)-.18),y=deckAt(s),end: Point3=[x,y+.66,z];
        add(strut([x,y,z],end,.028,6,true),'#b0b9b8');
        if (previous) {
          add(strut(previous,end,.036,7,true),'#a68560');
          add(strut([previous[0],previous[1]-.3,previous[2]],[x,end[1]-.3,z],.017,5,true),'#9ca9a6');
        }
        previous=end;
      }
    }
    for (const x of [-14.7,13.15]) {
      const s=section(x),y=deckAt(s),z=side*(widthAt(s)-.73);
      box(.63,.055,.26,x,y+.03,z,'#525c59');
      for (const dx of [-.19,.19]) {
        add(new THREE.CylinderGeometry(.085,.095,.23,7,1,true).translate(x+dx,y+.15,z),'#48524f');
        add(new THREE.CylinderGeometry(.108,.10,.04,7).translate(x+dx,y+.27,z),'#717875');
      }
    }
    // Oval fairleads set into the bow and stern plating. Follow its actual
    // curve so the opening sits flush even on the flared bow.
    for (const x of [-15.9,14.65]) {
      const point = (angle: number,radius: number,lift: number): Point3 => {
        const s=section(x+.31*radius*Math.cos(angle)),y=deckAt(s)-.39+.105*radius*Math.sin(angle);
        const lower=boot(s,side),upper=shoulder(s,side),t=(y-lower[1])/(upper[1]-lower[1]);
        return [THREE.MathUtils.lerp(lower[0],upper[0],t),y,THREE.MathUtils.lerp(lower[2],upper[2],t)+side*lift];
      };
      const lip: number[]=[],hole: number[]=[];
      for (let i=0;i<16;i++) {
        const a=side*2*Math.PI*i/16,b=side*2*Math.PI*(i+1)/16;
        lip.push(...point(a,1,.038),...point(b,1,.038),...point(b,.73,.05),
                 ...point(a,1,.038),...point(b,.73,.05),...point(a,.73,.05));
        hole.push(...point(a,0,.026),...point(a,.75,.026),...point(b,.75,.026));
      }
      for (const [p,col] of [[lip,'#95a0a0'],[hole,'#343e40']] as const) {
        const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));
        g.computeVertexNormals();add(g,col);
      }
    }
  }
}

// A Czech ensign on the stern staff. Eight small panels give the fly a fold
// and let it catch the same light as the boat, including in the river mirror.
function sternEnsign(add: Surface, close: boolean) {
  add(strut([-15.65,1.62,.16],[-15.85,2.73,.16],.027,close ? 7 : 4,!close),'#876b4b');
  const point=(u: number,v: number): Point3=>[-15.8-.78*u-.08*v,2.19+.49*v-.14*u,
    .16+.33*u+.115*Math.sin(u*6.3)*(.55+.45*v)];
  const cloth: number[][]=[[],[],[]];
  const panel=(colour: number,u: number,v: number,l: number,h: number,endL: number,endH: number)=>{
    const a=point(u,l),b=point(v,endL),c=point(v,endH),d=point(u,h);
    cloth[colour].push(...a,...b,...c,...a,...c,...d,...a,...c,...b,...a,...d,...c);
  };
  const panels=close ? 4 : 2;
  for (let i=0;i<panels;i++) {
    const a=i/panels,b=(i+1)/panels,lo=Math.min(.5,a),hi=Math.min(.5,b);
    panel(0,a,b,1-lo,1,1-hi,1);
    panel(1,a,b,0,lo,0,hi);
    if (a<.5) panel(2,a,b,lo,1-lo,hi,1-hi);
  }
  for (const [i,colour] of ['#e9e7da','#ad302f','#294c70'].entries()) {
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(cloth[i],3));
    g.computeVertexNormals();add(g,colour);
  }
}
