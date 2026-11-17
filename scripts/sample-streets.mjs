#!/usr/bin/env node
// A repeatable set of varied street-level comparison spots from the built map.
// node scripts/sample-streets.mjs [area] [seed]
import { readFileSync } from 'node:fs';
import proj4 from 'proj4';
import { rng } from '../src/map/geo.ts';
import { Polyline } from '../src/network.ts';

const [area = 'praha', seedText = '1'] = process.argv.slice(2);
const seed = Number(seedText);
if (!/^[a-z]+$/.test(area) || !Number.isSafeInteger(seed)) throw new Error('Expected a map area and an integer seed');
const dir = new URL(`../public/data/${area}_now/`, import.meta.url);
const read = (file) => JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
const index = read('index.json');
const [west, south, east, north] = index.bbox_wgs84;
const projection = `+proj=tmerc +lat_0=${(south + north) / 2} +lon_0=${(west + east) / 2} +k=1 +ellps=WGS84 +units=m`;
const transform = proj4(projection, 'EPSG:4326');
const town = transform.inverse([14.4206, 50.0873]);
const random = rng(seed);
const tiles = index.tiles.map(([i, j]) => [i, j, random()]).sort((a, b) => a[2] - b[2]);
const main = new Set(['primary', 'secondary', 'tertiary']);
const categories = new Set(['main road', 'residential', 'service', 'pedestrian', 'bridge', 'stairs']);
const found = [];
const nearby = (x, y, p, r) => Math.hypot(x - p[0], y - p[1]) < r;
const typeOf = (e) => {
  if (e.tunnel || (e.level ?? 0) < 0) return null;
  if (e.hw === 'steps' && !e.bridge && !e.level && !e.levels) return 'stairs';
  if (e.bridge) return 'bridge';
  if (e.hw === 'pedestrian' || e.hw === 'footway') return 'pedestrian';
  if (main.has(e.hw)) return 'main road';
  if (e.hw === 'living_street' || e.hw === 'residential') return 'residential';
  return e.hw === 'service' ? 'service' : null;
};

for (const [i, j] of tiles) {
  if (!categories.size) break;
  const x = (i + 0.5) * index.tile - index.origin[0], y = (j + 0.5) * index.tile - index.origin[1];
  if (area === 'praha' && !nearby(x, y, town, 11000)) continue;
  if (found.some((p) => nearby(x, y, p.xy, 1050))) continue;

  const tile = read(`tiles/${i}_${j}.json`);
  const ways = new Map([...(tile.drive ?? []), ...(tile.walk ?? [])].map((e) => [e.id, e]));
  const edges = [...ways.values()].map((e) => [e, random()]).sort((a, b) => a[1] - b[1]);
  for (const [edge] of edges) {
    const type = typeOf(edge);
    if (!categories.has(type) || edge.pts.length < 2) continue;
    const line = new Polyline(edge.pts);
    if (line.length < (type === 'stairs' ? 5 : 20)) continue;
    const p = line.at(line.length * 0.5);
    if (p.x <= tile.box[0] || p.x >= tile.box[2] || p.y <= tile.box[1] || p.y >= tile.box[3]) continue;
    if (found.some((spot) => nearby(p.x, p.y, spot.xy, 1200))) continue;
    const [lon, lat] = transform.forward([p.x, p.y]).map((v) => +v.toFixed(7));
    const heading = Math.round((450 - p.ang * 180 / Math.PI) % 360) % 360;
    const streetView = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}&heading=${heading}`;
    found.push({ type, name: edge.name || null, tile: `${i}_${j}`, at: [lat, lon], heading, streetView, xy: [p.x, p.y] });
    categories.delete(type);
    break;
  }
}
console.log(JSON.stringify(found.map(({ xy, ...spot }) => spot), null, 2));
if (categories.size) console.error(`No separated sample in ${area} for: ${[...categories].join(', ')}`);
