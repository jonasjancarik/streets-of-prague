import * as THREE from 'three';
import type { WebGPURenderer as GPU } from 'three/webgpu';

// A browser/driver can leave requestAdapter or requestDevice pending indefinitely.
// Finish startup with the legacy renderer instead of leaving the map loading forever.
async function within<T>(pending: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export async function createGameRenderer(params: URLSearchParams): Promise<THREE.WebGLRenderer> {
  const legacy = () => {
    console.info('Renderer: three.js WebGLRenderer');
    return new THREE.WebGLRenderer({ antialias: true, stencil: true });
  };
  if (params.get('renderer') === 'webgl') return legacy();
  let renderer: GPU;
  try {
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu || !await within(gpu.requestAdapter(), 5000, 'WebGPU adapter request timed out')) return legacy();
    const { WebGPURenderer } = await import('three/webgpu');
    renderer = new WebGPURenderer({ antialias: true, stencil: true });
    const initialized = renderer.init();
    try {
      await within(initialized, 15000, 'WebGPU device initialization timed out');
    } catch (e) {
      // There is no API to cancel requestDevice. If it eventually succeeds, release
      // its device rather than keeping a second renderer alive behind the fallback.
      void initialized.then(() => renderer.dispose()).catch(() => {});
      throw e;
    }
  } catch (e) {
    console.warn('WebGPU could not start; using WebGL', e);
    return legacy();
  }
  // The ports install material factories. Import them only after initialization
  // succeeds, so a timeout cannot mix node materials into the legacy renderer.
  return (await import('./webgpu.ts')).configureRenderer(renderer);
}
