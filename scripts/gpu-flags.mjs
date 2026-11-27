// Chrome's switches for drawing the game on the GPU from a script (scene.mjs, bench.mjs,
// the browser checks). ANGLE's backend is the platform's own: Metal on a Mac, Direct3D 11
// on Windows, the default elsewhere. `--use-angle=metal` on Windows has no backend to use,
// and Chrome quietly drew everything in software instead: a second a frame and a page that
// crashed under the city (November 2026).
export const ANGLE = process.platform === 'darwin' ? 'metal' : process.platform === 'win32' ? 'd3d11' : null;
export const gpuFlags = (angle = ANGLE) => [...(angle ? [`--use-angle=${angle}`] : []), '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'];
