// One immutable outcome per world: unavailable optional evidence disables scenery
// for every tile, even if the request succeeds after its deadline.
export async function furnitureSurvey(url: string, timeout = 3000,
  fetcher: typeof fetch = fetch): Promise<Float32Array | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    try {
      const res = await fetcher(url, { signal: controller.signal });
      if (!res.ok) return null;
      let buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 8) {
        buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      }
      if (buf.byteLength < 4) return null;
      const count = new DataView(buf).getUint32(0, true);
      if (4 + count * 9 > buf.byteLength) return null;
      const xy = new Float32Array(buf.slice(4, 4 + count * 8));
      return xy.every(Number.isFinite) ? xy : null;
    } catch { return null; }
  };
  try {
    return await Promise.race([read(), new Promise<null>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, timeout);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
