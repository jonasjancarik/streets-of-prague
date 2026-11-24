import assert from 'node:assert/strict';
import { FramePhotos, png } from '../src/frameCapture.ts';

const queue = new FramePhotos();
const picture = new Blob(['photo'], { type: 'image/png' });
const slowCanvas = { toBlob(done) { setTimeout(() => done(picture), 35); } };
const photo = queue.next(5).then(frame => frame && png(frame));
const thumbnail = queue.next(5);
assert(queue.requested);
queue.drawn(slowCanvas);
assert.equal(queue.requested, false);
assert.equal(await thumbnail, slowCanvas);
assert.equal(await photo, picture, 'PNG encoding may finish after the frame-wait timeout');
assert.equal(await queue.next(5), null, 'a tab that never draws still times out');
assert.equal(queue.requested, false, 'expired requests leave the queue');
console.log('Shared capture, slow encoding and hidden-tab timeout passed');
