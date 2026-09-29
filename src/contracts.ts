import type { Bounds, GeoData, Point2, Polygons } from './map/geo.ts';
import type { RawStreetEdge } from './network.ts';
import type { GroundResult, GroundRoadEdge, GroundTileData } from './ground.ts';
import type { TreeTileData } from './map/vegetation.ts';
import type { BuildingTile } from './map/buildings.ts';

export interface TerrainMetadata {
  n: number;
  step: number;
  bare?: string[];
  // Tiles with bridges or tunnels of their own (pipeline/structures.py).
  structures?: string[];
}

export type TileIndexEntry = [number, number, number] | [number, number, number, number];

export interface MapIndex extends GeoData {
  area: string;
  bbox_wgs84: Bounds;
  tile: number;
  cols: number;
  rows: number;
  tiles: TileIndexEntry[];
  rails: { kind: string; pts: Point2[] }[];
  graphs?: boolean;
  parkingInTiles?: boolean;
  ipr?: boolean;
  iprRef?: number;
  terrain?: TerrainMetadata;
  gzip?: boolean;
}

export type TileBuilding = BuildingTile['buildings'][number] & {
  own?: boolean;
  noIpr?: boolean;
  base?: number;
};

export interface TileSection {
  code: string;
  category: string;
  spaces: number;
  occDay?: number;
  occNight?: number;
  share: number;
  polys: Polygons;
}

export interface TilePassage { pts: Point2[]; w: number }

// A level of bridges (1, 2, …) or tunnels (-1, -2, …) in a tile: its outline here;
// its heights come in the tile's .levels.bin.
export interface TileStructure { level: number; kind: 'bridge' | 'tunnel'; polys: Polygons }

export interface TileJSON extends GroundTileData {
  i: number;
  j: number;
  box: Bounds;
  buildings: TileBuilding[];
  walls: { kind: string; pts: Point2[] }[];
  trees: Point2[];
  lots?: { o: 'parallel' | 'diagonal' | 'perpendicular' | null; rings: Point2[][] }[];
  sections?: TileSection[];
  passages?: TilePassage[];
  drive?: RawStreetEdge[];
  walk?: RawStreetEdge[];
  ipr?: object;
  structures?: TileStructure[];
}

export interface HeightGrid { hm: Float32Array; box: Bounds; n: number; step: number }
// A level with its heights, for the tile workers.
export interface LevelInput extends TileStructure { heights: HeightGrid }

export interface BuildingArrays {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  facade: Float32Array;
  drapeUv?: Float32Array;
}

export interface LandResult {
  trees: { matrices: Float32Array; colours: Float32Array; evergreen: Float32Array; count: number };
  walls: { position: Float32Array; normal: Float32Array };
  cells: Uint8Array;
}

export interface WorkerJobs {
  roofs: { buildings: TileBuilding[]; size: Point2; origin: Point2; ground: HeightGrid | null; bbox: Bounds };
  ipr: { buffer: ArrayBuffer; box: Bounds; absolute: boolean; ground: HeightGrid | null; bbox: Bounds };
  ground: {
    d: GroundTileData; box: Bounds; edges: GroundRoadEdge[];
    buildings: { rings: Point2[][] }[]; parkingZones: (string | null)[];
    ground: HeightGrid | null; levels: LevelInput[] | null;
  };
  land: {
    data: TreeTileData & { passages: TilePassage[]; levels: boolean };
    seeds: Float64Array; ground: HeightGrid | null; bridges: HeightGrid[];
  };
}

export interface WorkerResults {
  roofs: BuildingArrays;
  ipr: BuildingArrays;
  ground: GroundResult;
  land: LandResult;
}

export type WorkerKind = keyof WorkerJobs;
export type WorkerRequest = { [K in WorkerKind]: { id: number; type: K; data: WorkerJobs[K] } }[WorkerKind];
export type WorkerResponse = { id: number; result: unknown; error?: never } | { id: number; error: string; result?: never };

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const numericTuple = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every((part) => typeof part === 'number');

// Check the fields used to construct a tile. Individual OSM features stay owned by
// the map writer; this migration does not validate every nested geometry.
export function isTileJSON(value: unknown): value is TileJSON {
  if (!record(value)) return false;
  return typeof value.i === 'number' && typeof value.j === 'number' && numericTuple(value.box, 4)
    && record(value.areas) && record(value.roads)
    && Array.isArray(value.buildings) && Array.isArray(value.walls) && Array.isArray(value.trees)
    && Array.isArray(value.rails)
    && (value.drive === undefined || (Array.isArray(value.drive) && Array.isArray(value.walk)))
    && (value.sections === undefined || Array.isArray(value.sections));
}

export function isMapIndex(value: unknown): value is MapIndex {
  if (!record(value)) return false;
  return typeof value.area === 'string' && numericTuple(value.size, 2) && numericTuple(value.origin, 2)
    && numericTuple(value.bbox_wgs84, 4) && typeof value.tile === 'number'
    && Array.isArray(value.tiles) && value.tiles.every((entry) => Array.isArray(entry)
      && (entry.length === 3 || entry.length === 4) && entry.every((part) => typeof part === 'number'))
    && Array.isArray(value.rails)
    && (value.terrain === undefined || (record(value.terrain)
      && typeof value.terrain.n === 'number' && typeof value.terrain.step === 'number'));
}
