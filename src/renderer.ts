import * as THREE from 'three';
import type { WebGPURenderer as GPU } from 'three/webgpu';
import * as telemetry from './telemetry.ts';
import { isSoftware, reportTrouble } from './graphicswarning.ts';

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
  const asked = params.get('renderer') === 'webgl';
  const legacy = () => {
    console.info('Renderer: three.js WebGLRenderer');
    const r = new THREE.WebGLRenderer({ antialias: true, stencil: true });
    const gl = r.getContext(), names = gl.getExtension('WEBGL_debug_renderer_info');
    const name = names ? String(gl.getParameter(names.UNMASKED_RENDERER_WEBGL)) : '';
    if (names) telemetry.setGpu(name);
    if (isSoftware(name)) reportTrouble('software');
    else if (!asked) reportTrouble('webgl');
    return r;
  };
  if (asked) return legacy();
  let renderer: GPU | undefined;
  const watch = startupWatch();
  try {
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<{ isFallbackAdapter?: boolean; info?: { vendor?: string; architecture?: string; description?: string; isFallbackAdapter?: boolean } } | null> } }).gpu;
    const adapter = gpu && await within(gpu.requestAdapter(), 5000, 'WebGPU adapter request timed out');
    if (adapter) {
      const info = adapter.info;
      const name = info ? info.description || [info.vendor, info.architecture].filter(Boolean).join(' ') : '';
      if (info) telemetry.setGpu(name);
      watch.gpu(name);
      if (adapter.isFallbackAdapter || info?.isFallbackAdapter || isSoftware(name)) reportTrouble('software');
      // This library import creates no renderer or game material factories if it arrives late.
      watch.stage('module');
      const { WebGPURenderer } = await within(import('three/webgpu'), 15000, 'WebGPU renderer module loading timed out');
      // (three.js asks for an adapter of its own in init(), with featureLevel 'compatibility', and
      // then for the device: the adapter above is only read for its name and never used again.)
      watch.stage('device');
      const candidate = new WebGPURenderer({ antialias: true, stencil: true });
      const initialized = candidate.init();
      try {
        await within(initialized, 15000, 'WebGPU device initialization timed out');
      } catch (e) {
        // There is no API to cancel requestDevice. Release a device that arrives later,
        // and include async disposal in this chain so it cannot reject unhandled.
        const late = performance.now();
        void initialized.then(() => {
          telemetry.error('WebGPU device arrived late', `${Math.round(performance.now() - late)} ms after giving up`, watch.report());
          return candidate.dispose();
        }, () => {}).catch((error) => {
          console.warn('WebGPU late cleanup failed', error, watch.report());
          telemetry.error('WebGPU late cleanup failed', error, watch.report());
        });
        throw e;
      }
      renderer = candidate;
    }
  } catch (e) {
    console.warn('WebGPU could not start; using WebGL', e, watch.report());
    telemetry.error('WebGPU could not start', e, watch.report());
  }
  if (!renderer) { watch.stop(); return legacy(); }
  // The ports install material factories. Import them only after initialization
  // succeeds. Failure here must stop startup: this module may finish evaluating
  // later and install factories, so it cannot safely select the legacy renderer.
  watch.stage('materials');
  try {
    const ports = await within(import('./webgpu.ts'), 15000, 'Graphics setup took too long. Reload the page to try again.');
    return ports.configureRenderer(renderer);
  } catch (error) {
    const failed = renderer;
    // Cleanup must not hold the error screen open or replace the original failure.
    void Promise.resolve().then(() => failed.dispose()).catch((cleanup) => {
      console.warn('WebGPU setup cleanup failed', cleanup, watch.report());
      telemetry.error('WebGPU setup cleanup failed', cleanup, watch.report());
    });
    throw error;
  } finally {
    watch.stop();
  }
}
