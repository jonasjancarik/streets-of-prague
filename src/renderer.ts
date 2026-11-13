import * as THREE from 'three';
import type { WebGPURenderer as GPU } from 'three/webgpu';
import * as telemetry from './telemetry.ts';
import { isSoftware, reportTrouble, whyWebGL } from './graphicswarning.ts';

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

function createLegacy(why: string, asked: boolean) {
  console.info('Renderer: three.js WebGLRenderer');
  whyWebGL(why);
  const r = new THREE.WebGLRenderer({ antialias: true, stencil: true });
  const gl = r.getContext(), names = gl.getExtension('WEBGL_debug_renderer_info');
  const name = names ? String(gl.getParameter(names.UNMASKED_RENDERER_WEBGL)) : '';
  if (names) telemetry.setGpu(name);
  if (isSoftware(name)) reportTrouble('software');
  else if (!asked) reportTrouble('webgl');
  return r;
}

// A start the graphics broke is tried again, once with lighter graphics and then once with
// WebGL, for as long as the tab stays open. Safari on an iPhone or iPad short of graphics
// memory makes buffers it can't fill, and three.js then throws "Range consisting of offset
// and length are out of bounds" before the game has begun.
const RETRY = 'graphics-retry';
export type Retry = '' | 'low' | 'webgl';
export function startRetry(): Retry {
  try { const v = sessionStorage.getItem(RETRY); return v === 'low' || v === 'webgl' ? v : ''; } catch { return ''; }
}
let webgpu = false, gpuTrouble = false;
// Whether the failed start is the graphics' fault and the page reloads to try again.
export function retryStart(e: unknown) {
  if (!webgpu) return false;
  const text = e instanceof Error ? `${e.message} ${e.stack ?? ''}` : String(e);
  if (!gpuTrouble && !/three\.webgpu|GPU/.test(text)) return false;
  const now = startRetry(), next = now === '' ? 'low' : now === 'low' ? 'webgl' : '';
  if (!next) return false;
  try { sessionStorage.setItem(RETRY, next); } catch { return false; } // can't remember it: no loop
  // A moment for the GPU's own error and the reports to go out first.
  setTimeout(() => location.reload(), 500);
  return true;
}

// The GPU's own words, which an exception thrown in three.js doesn't carry (an out-of-memory
// buffer, for one), for the statistics.
function watchGpu(renderer: GPU) {
  const r = renderer as unknown as { onError: (info: { type?: string; message?: string }) => void; onDeviceLost: (info: unknown) => void };
  const error = r.onError.bind(renderer), lost = r.onDeviceLost.bind(renderer);
  r.onError = (info) => { gpuTrouble = true; telemetry.error('GPU error', `${info.type ?? 'GPUError'}: ${info.message ?? ''}`); error(info); };
  r.onDeviceLost = (info) => { gpuTrouble = true; lost(info); };
}

export async function createGameRenderer(params: URLSearchParams): Promise<THREE.WebGLRenderer> {
  const retry = startRetry();
  if (retry) telemetry.error('start tried again', retry === 'low' ? 'with low graphics' : 'with WebGL');
  if (retry === 'webgl' && params.get('renderer') !== 'webgl') return createLegacy('WebGPU could not start the game on this device', false);
  const asked = params.get('renderer') === 'webgl';
  const legacy = (why: string) => createLegacy(why, asked);
  if (asked) return legacy('it was asked for in the URL (?renderer=webgl)');
  let why = '';
  let renderer: GPU | undefined;
  const watch = startupWatch();
  try {
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<{ isFallbackAdapter?: boolean; info?: { vendor?: string; architecture?: string; description?: string; isFallbackAdapter?: boolean } } | null> } }).gpu;
    const adapter = gpu && await within(gpu.requestAdapter(), 5000, 'WebGPU adapter request timed out');
    if (!gpu) why = 'the browser has no WebGPU';
    else if (!adapter) why = 'the browser offered no WebGPU adapter';
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
    why = `WebGPU failed: ${e instanceof Error ? e.message : String(e)} (${watch.report()})`;
  }
  if (!renderer) { watch.stop(); return legacy(why); }
  // The ports install material factories. Import them only after initialization
  // succeeds. Failure here must stop startup: this module may finish evaluating
  // later and install factories, so it cannot safely select the legacy renderer.
  watch.stage('materials');
  try {
    const ports = await within(import('./webgpu.ts'), 15000, 'Graphics setup took too long. Reload the page to try again.');
    const configured = ports.configureRenderer(renderer);
    webgpu = true;
    watchGpu(renderer);
    return configured;
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
