// How much the game has asked the GPU for, for the statistics (renderer.ts): when an iPhone
// or iPad fails to start ("Range consisting of offset and length are out of bounds"), the
// report says how much was in use, the biggest pieces, and the buffer the GPU couldn't make.
// The texture sizes are estimates: four bytes a pixel unless the format says otherwise,
// a third more with mipmaps.

type Desc = { size?: number; label?: string; mappedAtCreation?: boolean };
type TexDesc = { size: number[] | { width: number; height?: number; depthOrArrayLayers?: number }; format?: string; mipLevelCount?: number; sampleCount?: number; label?: string };
type Device = {
  createBuffer(d: Desc): { getMappedRange(): ArrayBuffer; destroy(): void };
  createTexture(d: TexDesc): { destroy(): void };
  limits?: { maxBufferSize?: number };
};

const MB = 1024 * 1024;
let buffers = 0, bufferBytes = 0, biggestBuffer = 0, biggestBufferLabel = '';
let textures = 0, textureBytes = 0, biggestTexture = 0, biggestTextureLabel = '';
let failed = '', maxBufferSize = 0;

const bytesPerPixel = (format = '') =>
  /32float|32uint|32sint/.test(format) ? (/rgba/.test(format) ? 16 : /rg/.test(format) ? 8 : 4)
    : /16float|16uint|16sint/.test(format) ? (/rgba/.test(format) ? 8 : /rg/.test(format) ? 4 : 2)
      : /^(r8|stencil8)/.test(format) ? 1 : /^rg8/.test(format) ? 2 : 4;

function textureSize(d: TexDesc) {
  const s = Array.isArray(d.size) ? { width: d.size[0], height: d.size[1], depthOrArrayLayers: d.size[2] } : d.size;
  const pixels = (s.width || 1) * (s.height || 1) * (s.depthOrArrayLayers || 1);
  return pixels * bytesPerPixel(d.format) * (d.sampleCount || 1) * ((d.mipLevelCount ?? 1) > 1 ? 4 / 3 : 1);
}

export function trackGpuMemory(device: Device) {
  maxBufferSize = device.limits?.maxBufferSize ?? 0;
  const createBuffer = device.createBuffer.bind(device), createTexture = device.createTexture.bind(device);
  device.createBuffer = (d) => {
    const buffer = createBuffer(d), size = d.size ?? 0;
    // Safari short of memory returns a buffer anyway, with nothing behind it: its mapped
    // range (which three.js asks for once, and which can be asked for only once) is short.
    if (d.mappedAtCreation && size > 0) {
      const range = buffer.getMappedRange.bind(buffer) as (offset?: number, length?: number) => ArrayBuffer;
      (buffer as { getMappedRange: typeof range }).getMappedRange = (offset?: number, length?: number) => {
        const got = range(offset, length);
        if (offset === undefined && got.byteLength < size && !failed) {
          failed = `${(size / MB).toFixed(1)} MB${d.label ? ` (${d.label.slice(0, 40)})` : ''}, got ${got.byteLength} bytes, ${buffers} buffers before it`;
        }
        return got;
      };
    }
    buffers++; bufferBytes += size;
    if (size > biggestBuffer) { biggestBuffer = size; biggestBufferLabel = d.label ?? ''; }
    const destroy = buffer.destroy.bind(buffer);
    let gone = false;
    buffer.destroy = () => { if (!gone) { gone = true; buffers--; bufferBytes -= size; } destroy(); };
    return buffer;
  };
  device.createTexture = (d) => {
    const texture = createTexture(d), size = textureSize(d);
    textures++; textureBytes += size;
    if (size > biggestTexture) {
      biggestTexture = size;
      const sz = Array.isArray(d.size) ? d.size : [d.size.width, d.size.height ?? 1, d.size.depthOrArrayLayers ?? 1];
      biggestTextureLabel = `${sz.map((n) => n ?? 1).join('x')} ${d.format ?? ''}${(d.mipLevelCount ?? 1) > 1 ? ' mips' : ''}${(d.sampleCount ?? 1) > 1 ? ` x${d.sampleCount}` : ''}${d.label ? ` ${d.label.slice(0, 30)}` : ''}`;
    }
    const destroy = texture.destroy.bind(texture);
    let gone = false;
    texture.destroy = () => { if (!gone) { gone = true; textures--; textureBytes -= size; } destroy(); };
    return texture;
  };
}

// One line for a report.
export function gpuMemoryReport() {
  const mb = (n: number) => `${(n / MB).toFixed(1)} MB`;
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;
  return [
    `buffers ${buffers}, ${mb(bufferBytes)}, biggest ${mb(biggestBuffer)}${biggestBufferLabel ? ` (${biggestBufferLabel.slice(0, 40)})` : ''}`,
    `textures ${textures}, about ${mb(textureBytes)}, biggest ${mb(biggestTexture)}${biggestTextureLabel ? ` (${biggestTextureLabel.slice(0, 60)})` : ''}`,
    failed && `failed buffer ${failed}`,
    maxBufferSize && `max buffer ${mb(maxBufferSize)}`,
    memory && `device memory ${memory} GB`,
    `screen ${screen.width}x${screen.height}@${devicePixelRatio}`,
  ].filter(Boolean).join('; ');
}
