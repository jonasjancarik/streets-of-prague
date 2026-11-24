type Picture = HTMLCanvasElement | null;

// A hidden tab may never draw another frame. Once drawing starts, let the GPU
// copy and image encoder finish even on a slow phone.
export class FramePhotos {
  private waiting = new Set<(frame: Picture) => void>();
  get requested() { return this.waiting.size > 0; }

  next(timeoutMs: number) {
    return new Promise<Picture>(resolve => {
      const begin = (frame: Picture) => { clearTimeout(timer); resolve(frame); };
      const timer = setTimeout(() => { this.waiting.delete(begin); resolve(null); }, timeoutMs);
      this.waiting.add(begin);
    });
  }

  drawn(frame: Picture) {
    for (const begin of this.waiting) begin(frame);
    this.waiting.clear();
  }
}

function copy(source: HTMLCanvasElement, width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

// WebGPU presents the swapchain after this animation callback. Copy the frame
// while it is still readable. The PNG encoder can then finish in its own time.
export function captureFrame(source: HTMLCanvasElement) {
  try { return source.width && source.height ? copy(source, source.width, source.height) : null; }
  catch { return null; }
}

export function thumbnail(canvas: HTMLCanvasElement) {
  const scale = Math.min(1, 1280 / canvas.width);
  const small = scale === 1 ? canvas : copy(canvas, Math.round(canvas.width * scale), Math.round(canvas.height * scale));
  return small?.toDataURL('image/jpeg', .72) ?? null;
}

export function png(canvas: HTMLCanvasElement) {
  return new Promise<Blob | null>(done => {
    try { canvas.toBlob(done, 'image/png'); } catch { done(null); }
  });
}
