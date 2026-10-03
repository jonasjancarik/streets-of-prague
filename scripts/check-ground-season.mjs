#!/usr/bin/env node
// Date transitions and the unmodified summer reference; no browser or map required.
import assert from 'node:assert/strict';
import { Season } from '../src/season.ts';
import { GROUND_SEASON, WOOD_SEASON, FIELD_SEASON, HEDGE_SEASON, shareGroundSeason } from '../src/groundSeason.ts';

const season = new Season(new URLSearchParams('date=07-15'));
const values = () => [GROUND_SEASON.value.toArray(), WOOD_SEASON.value.toArray(), FIELD_SEASON.value.toArray(), HEDGE_SEASON.value.toArray()];
const at = (date) => { season.set(typeof date === 'number' ? date : new Season(new URLSearchParams(`date=${date}`)).day); shareGroundSeason(season); return values(); };
const summer = at('07-15');
for (const row of summer) assert.ok(row.every((v) => v === 1), '15 July must preserve every original surface factor');
const spring = at('04-20'), dry = at('08-20'), autumn = at('10-20'), winter = at('01-15');
assert.ok(spring[0][1] > summer[0][1] && spring[0][3] < summer[0][3], 'spring grass is fresher with fewer dry patches');
assert.ok(dry[0][0] > summer[0][0] && dry[0][3] > summer[0][3], 'late-summer grass has more yellow patches');
assert.ok(winter[0][1] < summer[0][1] && winter[0][2] < summer[0][2], 'winter grass is dull olive');
assert.ok(winter[1][0] > winter[1][1] && at('03-15')[1][0] > 1, 'woodland litter lasts through March');
assert.ok(at('11-15')[1][0] > 1 && summer[1].every((v) => v === 1), 'woodland summer remains unchanged');
assert.ok(spring[2][0] < spring[2][1] && autumn[2][0] > autumn[2][1], 'fields move from green to harvested earth');
assert.deepEqual(autumn[3], summer[3], 'evergreen hedges do not turn brown in autumn');
assert.ok(winter[3].every((v) => v > 0.8), 'winter hedge dulling keeps green foliage');
const refs = [GROUND_SEASON.value, WOOD_SEASON.value, FIELD_SEASON.value, HEDGE_SEASON.value];
let previous = at(365);
for (let day = 1; day <= 365; day++) {
  const next = at(day);
  for (let row = 0; row < next.length; row++) for (let col = 0; col < next[row].length; col++) {
    assert.ok(Number.isFinite(next[row][col]) && next[row][col] > 0, `valid multiplier on day ${day}`);
    assert.ok(Math.abs(next[row][col] - previous[row][col]) < 0.07, `smooth transition on day ${day}`);
  }
  previous = next;
}
assert.deepEqual([GROUND_SEASON.value, WOOD_SEASON.value, FIELD_SEASON.value, HEDGE_SEASON.value], refs);
for (let i = 0; i < refs.length; i++) assert.equal([GROUND_SEASON.value, WOOD_SEASON.value, FIELD_SEASON.value, HEDGE_SEASON.value][i], refs[i], 'uniform objects survive date changes');
assert.deepEqual(at('07-15'), summer, 'returning to July restores the baseline');
console.log('Ground seasons: summer reference, seasonal colours, evergreen hedges, smooth year and stable uniforms passed');
