import * as THREE from 'three';
import type { WebGPURenderer as GPU } from 'three/webgpu';
import * as telemetry from './telemetry.ts';

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
    const r = new THREE.WebGLRenderer({ antialias: true, stencil: true });
    const gl = r.getContext(), names = gl.getExtension('WEBGL_debug_renderer_info');
    if (names) telemetry.setGpu(String(gl.getParameter(names.UNMASKED_RENDERER_WEBGL)));
    return r;
  };
  if (params.get('renderer') === 'webgl') return legacy();
  let renderer: GPU;
  try {
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string; description?: string } } | null> } }).gpu;
    const adapter = gpu && await within(gpu.requestAdapter(), 5000, 'WebGPU adapter request timed out');
    if (!adapter) return legacy();
    const info = adapter.info;
    if (info) telemetry.setGpu(info.description || [info.vendor, info.architecture].filter(Boolean).join(' '));
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
    telemetry.error('WebGPU could not start', e);
    return legacy();
  }
  // The ports install material factories. Import them only after initialization
  // succeeds, so a timeout cannot mix node materials into the legacy renderer.
  return (await import('./webgpu.ts')).configureRenderer(renderer);
}
