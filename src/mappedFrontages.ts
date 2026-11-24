import proj4 from 'proj4';
import type { Bounds } from './map/geo.ts';
import mapped from './map/mosteckaFrontages.json' with { type: 'json' };

interface WallBox { x0: number; x1: number; z0: number; z1: number; nx: number; nz: number }

// A ray from the named street toward the mapped shop avoids decorating the
// back of the building or another shop across the street.
export class MappedFrontages {
  private rays: { x:number; z:number; dx:number; dz:number; length:number; trade:number }[] = [];
  constructor(bounds?: Bounds) {
    if (!bounds) return;
    const [west,south,east,north]=bounds;
    const local=`+proj=tmerc +lat_0=${(south+north)/2} +lon_0=${(west+east)/2} +ellps=WGS84 +units=m`;
    for (const [lon,lat,shopLon,shopLat,trade] of mapped) {
      if (lon<west || lon>east || lat<south || lat>north) continue;
      const [x,y]=proj4('EPSG:4326',local,[lon,lat]), [tx,ty]=proj4('EPSG:4326',local,[shopLon,shopLat]);
      const dx=tx-x,dz=y-ty,length=Math.hypot(dx,dz);
      this.rays.push({x,z:-y,dx:dx/length,dz:dz/length,length,trade});
    }
  }

  onWall(w:WallBox, pos:Float32Array, facade:Float32Array) {
    const hits:number[]=[];
    const mx=(w.x0+w.x1)/2,mz=(w.z0+w.z1)/2;
    for (const r of this.rays) {
      if (r.x<w.x0-20 || r.x>w.x1+20 || r.z<w.z0-20 || r.z>w.z1+20) continue;
      const facing=r.dx*w.nx+r.dz*w.nz;
      if (facing>-.65) continue;
      const reach=((mx-r.x)*w.nx+(mz-r.z)*w.nz)/facing;
      if (reach<2 || reach>r.length+3 || r.length-reach>10) continue;
      const x=r.x+r.dx*reach,z=r.z+r.dz*reach;
      if (x<w.x0-.15 || x>w.x1+.15 || z<w.z0-.15 || z>w.z1+.15) continue;
      // Follow the source triangle's along-wall axis, including reversed bays.
      for (let i=1;i<pos.length/3;i++) {
        const dx=pos[i*3]-pos[0],dz=pos[i*3+2]-pos[2],d2=dx*dx+dz*dz;
        if (d2<.25) continue;
        hits.push(facade[0]+(facade[i*4]-facade[0])*((x-pos[0])*dx+(z-pos[2])*dz)/d2,r.trade);
        break;
      }
    }
    return new Float32Array(hits);
  }
}
