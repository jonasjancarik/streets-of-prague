import type * as THREE from 'three';
import type { Building, Box as MapBox, DeckMask, HeightSampler, MapData, Point as MapPoint, Rail, SurfaceLayer } from './map/types.ts';
import type { Car } from './car.ts';
import type { RawEdge } from './network.ts';

export type Point = MapPoint;
export type Box = MapBox;
export type HeightAt = HeightSampler;

export interface TerrainData {
  hm: Float32Array;
  box: Box;
  n: number;
  step: number;
}

export type TileBuilding = Building & { own?: boolean; noIpr?: boolean };

export interface TilePassage {
  pts: Point[];
  w: number;
}

export type TileEdge = RawEdge & { bridge?: boolean; surface?: string };

export type ParkingOrientation = 'parallel' | 'diagonal' | 'perpendicular';
export interface ParkingLot { o: ParkingOrientation | null; rings: Point[][]; }
export interface ParkingSection {
  code: string;
  category: string;
  spaces: number;
  occDay?: number | null;
  occNight?: number | null;
  share: number;
  polys: Point[][][];
}

export interface RawTileData extends Omit<MapData, 'size' | 'origin'> {
  i: number;
  j: number;
  box: Box;
  buildings: TileBuilding[];
  passages?: TilePassage[];
  sections?: ParkingSection[];
  lots?: ParkingLot[];
  drive?: TileEdge[];
  walk?: TileEdge[];
  ipr?: Record<string, unknown>;
  decks?: boolean;
  [key: string]: unknown;
}

export interface TileData extends RawTileData {
  size: Point;
  origin: Point;
}

export type TileIndexEntry = [number, number, number, (0 | 1)?];

export interface TileIndex {
  tile: number;
  area: string;
  size: Point;
  origin: Point;
  cols: number;
  rows: number;
  tiles: TileIndexEntry[];
  rails: Rail[];
  graphs?: boolean;
  parkingInTiles?: boolean;
  ipr?: boolean;
  terrain?: {
    bare?: string[];
    decks?: string[];
    n: number;
    step: number;
  };
  iprRef?: number;
  gzip?: boolean;
  bbox_wgs84: Box;
}

export interface BuildingArrays {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  drapeUv?: Float32Array;
  facade: Float32Array;
}

export interface TreeArrays {
  matrices: Float32Array;
  colours: Float32Array;
  count: number;
}

export interface WallArrays {
  position: Float32Array;
  normal: Float32Array;
}

export interface GeometryArrays {
  position: Float32Array;
  normal: Float32Array;
  index: Uint32Array;
  alpha?: Float32Array;
}

export type GroundLayer = SurfaceLayer;

export type TileMask = DeckMask;

export type GroundMapData = Pick<MapData, 'areas' | 'roads' | 'rails' | 'weirs' | 'crossings'>;

export interface GroundEdge {
  bridge?: boolean;
  lanes?: number | null;
  surface?: string | null;
  hw: string;
  oneway?: boolean;
  u: number | string;
  v: number | string;
  width: number;
  pts: Point[];
}

export interface GroundBuilding {
  rings: TileBuilding['rings'];
}

export type GroundDeckData = TerrainData | Record<string, never> | null;

export interface GroundJobResult {
  layers: GroundLayer[];
  mask: TileMask | null;
}

export interface LandJobResult {
  trees: TreeArrays;
  walls: WallArrays;
  cells: Uint8Array;
}

export interface RoofsJobData {
  buildings: TileBuilding[];
  size: Point;
  origin: Point;
  ground: TerrainData | null;
  bbox: Box;
}

export interface IprJobData {
  buffer: ArrayBuffer;
  box: Box;
  absolute: boolean;
  ground: TerrainData | null;
  bbox: Box;
}

export interface GroundJobData {
  d: GroundMapData;
  box: Box;
  edges: GroundEdge[];
  buildings: GroundBuilding[];
  parkingZones: Array<string | null>;
  ground: TerrainData | null;
  deck: GroundDeckData;
}

export interface LandJobData {
  data: Pick<MapData, 'size' | 'origin' | 'areas' | 'roads' | 'walls' | 'trees' | 'rails'> & {
    buildings: GroundBuilding[];
    passages?: TilePassage[];
    decks?: boolean;
  };
  seeds: Float64Array;
  ground: TerrainData | null;
}

export interface TileJobMap {
  roofs: { data: RoofsJobData; result: BuildingArrays };
  ipr: { data: IprJobData; result: BuildingArrays };
  ground: { data: GroundJobData; result: GroundJobResult };
  land: { data: LandJobData; result: LandJobResult };
}

export type TileJobType = keyof TileJobMap;

export type TileWorkerRequest = {
  [Type in TileJobType]: { id: number; type: Type; data: TileJobMap[Type]['data'] }
}[TileJobType];

export type TileWorkerSuccess = {
  [Type in TileJobType]: { id: number; result: TileJobMap[Type]['result'] }
}[TileJobType];

export interface TileWorkerFailure {
  id: number;
  error: string;
}

export type TileWorkerResponse = TileWorkerSuccess | TileWorkerFailure;
export type TileWorkerTransferable = ArrayBuffer;
export type TileWorkerTransferList = TileWorkerTransferable[];

export interface Relief {
  texture: THREE.DataTexture;
  box: Box;
  sample: HeightAt;
  hm: Float32Array;
}

export interface TileDeck {
  grid: { at(x: number, y: number): number };
  sample: HeightAt;
}

export interface GeneratedTile {
  k: string;
  i: number;
  j: number;
  box: Box;
  passages: TilePassage[];
  group: THREE.Group;
  surfaces: { dispose(): void };
  grid: { at(x: number, y: number): number };
  deck: TileDeck | null;
  cars: Car[];
  ms: Record<string, number>;
  disposables: Array<THREE.Mesh | THREE.InstancedMesh>;
  relief: Relief | null;
  sample?: HeightAt;
}
