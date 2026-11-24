// A zinc downpipe in façade coordinates: along the wall, above the pavement,
// out from the plaster. All pieces go into the wall's existing mesh.
export type PipePoint = [number, number, number];
export interface PipeFace { points: PipePoint[]; finish: 'zinc' | 'cast' | 'strap' | 'inside' }
export function rainpipe(u: number, height: number, storey: number) {
  const faces: PipeFace[] = [];
  const tube = (path: [number, number, number][], finish: PipeFace['finish'], open = false) => {
    const rings = path.map(([y, z, radius], i) => {
      const before = path[Math.max(0,i-1)], after = path[Math.min(i+1,path.length-1)];
      const dy = after[0]-before[0], dz = after[1]-before[1], length = Math.hypot(dy,dz) || 1;
      return Array.from({ length: 8 }, (_, j): PipePoint => {
        const a = j*Math.PI/4, radial = radius*Math.cos(a);
        return [u+radius*Math.sin(a), y-radial*dz/length, z+radial*dy/length];
      });
    });
    for (let i = 1; i < rings.length; i++) for (let j = 0; j < 8; j++) {
      if (finish === 'strap' && (j === 3 || j === 4)) continue; // concealed against the bracket
      const k = (j+1)%8;
      faces.push({ points: [rings[i-1][j],rings[i-1][k],rings[i][k],rings[i][j]], finish });
    }
    if (open) {
      const rim = rings[0], [y,z] = path[0];
      const inner = rim.map(([x,h,d]): PipePoint => [u+(x-u)*.73,y+(h-y)*.73+.008,z+(d-z)*.73-.005]);
      for (let j=0;j<8;j++) { const k=(j+1)%8; faces.push({ points:[rim[j],inner[j],inner[k],rim[k]],finish }); }
      faces.push({ points:inner.slice().reverse(),finish:'inside' });
    }
  };
  // The heavier cast-iron shoe curves towards the gutter. Its socket receives
  // the narrower sheet-metal pipe. A pair of swept bends meets the eaves.
  tube([[.12,.236,.061],[.21,.183,.061],[.33,.139,.058],[.92,.139,.058],
    [.94,.139,.069],[1.015,.139,.069],[1.027,.139,.060]],'cast',true);
  tube([[1.015,.139,.053],[storey-.29,.139,.053],[storey-.10,.205,.053],
    [storey+.18,.205,.053],[storey+.36,.139,.053],[height-.48,.139,.053],
    [height-.25,.255,.053],[height-.065,.255,.053]],'zinc');
  for (let y=1.65;y<height-.65;y+=2.9) {
    // Rolled sleeve and a wall strap, with a short lug on either side.
    tube([[y-.023,.139,.061],[y+.023,.139,.062],[y+.030,.139,.054]],'strap');
    faces.push({ finish:'strap', points:[[u-.087,y-.018,.039],[u+.087,y-.018,.039],[u+.087,y+.025,.039],[u-.087,y+.025,.039]] });
  }
  return faces;
}
