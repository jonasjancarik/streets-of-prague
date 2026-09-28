export type Point = [number, number];
export type Point3 = [number, number, number];
export type Ring = Point[];
export type Polygon = Ring[];
export type Polygons = Polygon[];
export type Lines = Point[][];
export type Box = [number, number, number, number];
export type Size = [number, number];

export type HeightSampler = (x: number, y: number) => number;

export interface Building {
  id: string;
  rings: Polygon;
  h: number;
  minh: number;
  base?: number;
  name?: string | null;
  kind?: string;
  roof?: string | null;
  church?: boolean;
}

export interface Wall {
  kind?: string;
  pts: Point[];
}

export interface Rail {
  kind: string;
  pts: Point[];
}

export interface MapAreas {
  [name: string]: Polygons | undefined;
}

export interface MapRoads {
  [name: string]: Polygons | undefined;
}

export interface MapData {
  size: Size;
  origin: Point;
  areas: MapAreas;
  roads: MapRoads;
  buildings: Building[];
  walls: Wall[];
  trees: Point[];
  rails: Rail[];
  weirs?: Lines;
  crossings?: Lines;
}

export interface NetworkEdge {
  bridge?: boolean;
  lanes?: number | null;
  surface?: string | null;
  hw: string;
  oneway: boolean;
  u: number | string;
  v: number | string;
  width: number;
  pts: Point[];
}

export interface SurfaceGeometry {
  position: Float32Array;
  normal: Float32Array;
  index: Uint32Array;
  alpha?: Float32Array;
}

export interface SurfaceLayer {
  order: number;
  geometry: SurfaceGeometry;
  color?: string;
  pattern?: string;
  blend?: number | null;
  shade?: number;
  deck?: boolean;
  slab?: boolean;
}

export interface DeckMask {
  w: number;
  h: number;
  cells: Uint8Array;
  box: Box;
}

export interface TextureMask {
  texture: import('three').Texture;
  box: Box;
}

export interface Relief {
  texture: import('three').Texture;
  box: Box;
}
