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

// What the page was doing while the graphics started, for the statistics: when a request never
// returns, the report says which one, after how long, whether the tab was hidden or lost focus
// meanwhile, and whether the browser was still drawing frames (in the benchmark, headless Chrome
// made the device reliably only with animation frames running: scripts/bench.mjs --loading-frames).
function startupWatch() {
  const t0 = performance.now();
  let stage = 'adapter', frames = 0, hiddenAtStart = document.hidden, wasHidden = document.hidden, done = false, gpu = '';
  const onVisibility = () => { if (document.hidden) wasHidden = true; };
  document.addEventListener('visibilitychange', onVisibility);
  const tick = () => { if (!done) { frames++; requestAnimationFrame(tick); } };
  requestAnimationFrame(tick);
  return {
    stage: (name: string) => { stage = name; },
    gpu: (name: string) => { gpu = name; },
    stop: () => { done = true; document.removeEventListener('visibilitychange', onVisibility); },
    report: () => [
      `stage ${stage}`, `after ${Math.round(performance.now() - t0)} ms`, `frames ${frames}`,
      `hidden at start ${hiddenAtStart}`, `hidden since ${wasHidden}`, `hidden now ${document.hidden}`, `focus ${document.hasFocus()}`,
      gpu && `gpu ${gpu}`,
    ].filter(Boolean).join(', '),
  };
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
  const watch = startupWatch();
  try {
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string; description?: string } } | null> } }).gpu;
    const adapter = gpu && await within(gpu.requestAdapter(), 5000, 'WebGPU adapter request timed out');
    if (!adapter) { watch.stop(); return legacy(); }
    const info = adapter.info;
    const name = info ? info.description || [info.vendor, info.architecture].filter(Boolean).join(' ') : '';
    if (info) telemetry.setGpu(name);
    watch.gpu(name);
    // (three.js asks for an adapter of its own in init(), with featureLevel 'compatibility', and
    // then for the device: the adapter above is only read for its name and never used again.)
    watch.stage('device');
    const { WebGPURenderer } = await import('three/webgpu');
    renderer = new WebGPURenderer({ antialias: true, stencil: true });
    const initialized = renderer.init();
    try {
      await within(initialized, 15000, 'WebGPU device initialization timed out');
    } catch (e) {
      // There is no API to cancel requestDevice. If it eventually succeeds, release
      // its device rather than keeping a second renderer alive behind the fallback.
      // Whether it did arrive, and how late, is worth knowing too.
      const late = performance.now();
      void initialized.then(() => {
        telemetry.error('WebGPU device arrived late', `${Math.round(performance.now() - late)} ms after giving up`, watch.report());
        renderer.dispose();
      }).catch(() => {});
      throw e;
    }
  } catch (e) {
    console.warn('WebGPU could not start; using WebGL', e, watch.report());
    telemetry.error('WebGPU could not start', e, watch.report());
    watch.stop();
    return legacy();
  }
  watch.stop();
  // The ports install material factories. Import them only after initialization
  // succeeds, so a timeout cannot mix node materials into the legacy renderer.
  return (await import('./webgpu.ts')).configureRenderer(renderer);
}
