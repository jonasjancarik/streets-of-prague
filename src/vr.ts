import * as THREE from 'three';
import { t } from './i18n.ts';
import { initialView } from './streetView.ts';
import { STREET_QUALITY } from './streetQuality.ts';

// VR on a phone in a headset (a Daydream View, a Cardboard), the VR camera view (or ?vr): the game's own
// first-person view, drawn once per eye by the browser's WebXR (Chrome on Android draws the
// lenses' correction and follows the head with the phone's sensors). The game places a
// "rig" each frame, where your eyes are and which way is straight ahead, and the head turns
// round it. Drawn with the WebGL renderer (renderer.ts): three.js has no WebXR for WebGPU.
//
// Moving: a gamepad's left stick (the right stick turns), the Daydream controller over
// Web Bluetooth (its touchpad walks, click is E, the app button runs, volume turns), or with
// neither, look straight down for a moment to start or stop walking the way you look.

type XRish = {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(mode: string, init?: object): Promise<XRSessionish>;
};
type XRSessionish = EventTarget & { end(): Promise<void> };
type Characteristic = EventTarget & { value: DataView; startNotifications(): Promise<unknown> };
type BluetoothDevice = EventTarget & {
  gatt: { connect(): Promise<{ getPrimaryService(s: number): Promise<{ getCharacteristic(c: string): Promise<Characteristic> }> }> };
};
type Bluetoothish = { requestDevice(o: object): Promise<BluetoothDevice> };

const SNAP = THREE.MathUtils.degToRad(30);
const TURN = THREE.MathUtils.degToRad(90); // a gamepad's right stick, pushed all the way (per second)
const DAYDREAM_SERVICE = 0xfe55;
const DAYDREAM_DATA = '00000001-1000-1000-8000-00805f9b34fb';

const ahead = new THREE.Vector3();

const EYES: THREE.Vector3[] = [];

export class VR {
  active = false;
  // Which way straight ahead is (the game's headings: radians, 0 east, counter-clockwise):
  // the head turns round it. Turned in steps by the controls, never by the head.
  yaw = 0;
  // Where the head looks, from the last frame drawn.
  headH = 0;
  headPitch = 0;
  // This frame's controls: forward/back, sideways (positive left, like the keyboard's A),
  // held run.
  move = 0;
  side = 0;
  run = false;
  // A step of turning asked for since the last frame (radians).
  private turned = 0;
  private walking = false; // looking down to walk
  private downFor = 0;
  private lastInput = -Infinity;
  private rig = new THREE.Object3D();
  private queue: FrameRequestCallback[] = [];
  private nativeRAF = window.requestAnimationFrame.bind(window);
  private xrTarget: unknown = null;
  private daydream = { x: 0, y: 0, touched: false, click: false, app: false, plus: false, minus: false };
  fps = 0;
  loopMs = 0;
  drawMs = 0;
  private began = 0;
  private loops: number[] = [];
  private draws: number[] = [];
  private reports = 0;
  private gatt: string[] = [];
  private seen: Record<string, number> = {};
  private raw: number[] = [];
  private frames = 0;
  private since = 0;
  private bar = document.createElement('div');
  private session: XRSessionish | null = null;
  private started = false; // the game has begun (the buttons wait for it)
  private offered = true; // VR is the chosen view: the buttons show outside the headset
  private ddClick = false; private ddPlus = false; private ddMinus = false;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private camera: THREE.PerspectiveCamera,
    private key: (code: string) => void,
    private scale: number | null,
    // Back to the game without VR, from the button beside Play in VR.
    private without: () => void,
  ) {
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local');
    renderer.xr.setFramebufferScaleFactor(scale ?? STREET_QUALITY.vrScale);
    // A picture the game draws for itself (the street lamps' light map, the cars' probe, a
    // puddle's mirror) is drawn with its own camera, not the headset's two eyes.
    const render = renderer.render.bind(renderer);
    renderer.render = (scene, cam) => {
      const target = renderer.getRenderTarget();
      if (!this.active || !target || target === this.xrTarget) { render(scene, cam); return; }
      renderer.xr.enabled = false;
      try { render(scene, cam); } finally { renderer.xr.enabled = true; }
    };
    this.buttons();
  }

  // The game has begun: the buttons show (while VR is the chosen view).
  ready() { this.started = true; this.bar.hidden = !this.offered; }
  offer(on: boolean) { this.offered = on; this.bar.hidden = !(on && this.started); }

  // Out of the headset (another camera view was picked).
  exit() { void this.session?.end().catch(() => {}); }

  // Into the headset (the browser asks for this from a tap).
  async enter() {
    const xr = (navigator as { xr?: XRish }).xr;
    if (!xr) return;
    if (this.active) return;
    const session = this.session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local'] });
    session.addEventListener('end', () => this.leave());
    // The framebuffer can only be sized before setSession. Read the current
    // tier on every entry, including after Auto stepped down in the last session.
    this.renderer.xr.setFramebufferScaleFactor(this.scale ?? STREET_QUALITY.vrScale);
    await this.renderer.xr.setSession(session as unknown as XRSession);
    this.active = true;
    this.walking = false;
    document.body.classList.add('in-vr');
    // In the headset the page isn't shown, and the browser stops the page's own animation
    // frames: whatever waits for one (the gamepad, work spread over frames) runs in ours.
    window.requestAnimationFrame = (cb) => { this.queue.push(cb); return 0; };
  }

  private leave() {
    this.active = false;
    this.session = null;
    document.body.classList.remove('in-vr');
    window.requestAnimationFrame = this.nativeRAF;
    const waiting = this.queue; this.queue = [];
    for (const cb of waiting) this.nativeRAF(cb);
  }

  // At the start of each frame: the frames others asked for, and this frame's controls.
  frame(now: number, dt: number, pad: { move: number; turn: number }) {
    if (!this.active) return;
    // WebXR has already supplied this frame's eye pose. Use it for movement and
    // visibility before drawing, so a head turn does not cull from the old pose.
    const eye = this.renderer.xr.getCamera().cameras[0];
    if (eye) {
      ahead.set(0, 0, -1).applyQuaternion(eye.quaternion).transformDirection(this.rig.matrixWorld);
      this.headH = Math.atan2(-ahead.z, ahead.x);
      this.headPitch = Math.asin(THREE.MathUtils.clamp(ahead.y, -1, 1));
    }
    // Frames per second in the headset, and the main thread's share of each frame: the
    // whole game loop and the drawing for both eyes (ms, medians over the last second),
    // for checking (window.__vr, ?vrlog). A loop much shorter than the frame means the
    // graphics chip is what holds it back.
    this.frames++;
    this.began = performance.now();
    if (now - this.since >= 1000) {
      const med = (x: number[]) => (x.sort((a, b) => a - b)[x.length >> 1] ?? 0);
      this.fps = Math.round(this.frames * 1000 / (now - this.since)); this.frames = 0; this.since = now;
      this.loopMs = Math.round(med(this.loops)); this.drawMs = Math.round(med(this.draws)); this.loops = []; this.draws = [];
    }
    this.xrTarget = this.renderer.getRenderTarget();
    const waiting = this.queue; this.queue = [];
    for (const cb of waiting) { try { cb(now); } catch (e) { console.error(e); } }

    let move = 0, side = 0, run = false;
    // A gamepad: the left stick walks (forward is ahead of your eyes), the right one turns.
    for (const p of navigator.getGamepads?.() ?? []) {
      if (!p || p.mapping !== 'standard') continue;
      const dead = (v = 0) => (Math.abs(v) < 0.2 ? 0 : v);
      move = move || -dead(p.axes[1]); side = side || -dead(p.axes[0]);
      // (Smoothly, faster the further it's pushed: steps felt like the view jumping aside.)
      this.turned -= dead(p.axes[2]) * TURN * dt;
    }
    // The Daydream controller's touchpad: the top half walks forward, the sides step sideways.
    const d = this.daydream;
    if (d.touched) {
      move = move || THREE.MathUtils.clamp((0.5 - d.y) * 2.6, -1, 1);
      side = side || THREE.MathUtils.clamp((0.5 - d.x) * 2.6, -1, 1);
      if (Math.abs(move) < 0.25) move = 0;
      if (Math.abs(side) < 0.35) side = 0;
    }
    run = d.app;
    if (d.click && !this.ddClick) this.key('KeyE');
    if (d.plus && !this.ddPlus) this.turned -= SNAP;
    if (d.minus && !this.ddMinus) this.turned += SNAP;
    this.ddClick = d.click; this.ddPlus = d.plus; this.ddMinus = d.minus;

    const touched = move || side || run || pad.move || pad.turn || d.touched || d.click;
    if (touched) { this.lastInput = now; this.walking = false; }
    // No controller: look well down for a second to start walking, again to stop.
    if (now - this.lastInput > 3000) {
      this.downFor = this.headPitch < -0.9 ? this.downFor + dt : 0;
      if (this.downFor > 1) { this.walking = !this.walking; this.downFor = -2; }
      if (this.walking && this.headPitch > -0.9) move = 1;
    }
    this.move = move; this.side = side; this.run = run;
  }

  // A step of turning asked for since the last frame, once.
  takeTurn() { const t = this.turned; this.turned = 0; return t; }

  // Draws the frame for the headset, the eyes at x, y (the game's map metres) and height z,
  // straight ahead along heading h; the head moves and turns from there.
  draw(x: number, y: number, z: number, h: number, render: () => void) {
    const { camera, rig } = this;
    rig.position.set(x, z, -y);
    rig.rotation.set(0, h - Math.PI / 2, 0);
    rig.updateMatrixWorld(true);
    rig.add(camera);
    const t = performance.now();
    try { render(); } finally {
      const end = performance.now();
      this.draws.push(end - t); this.loops.push(end - this.began);
      rig.remove(camera);
      // The game reads the camera as it was drawn, in the city's own coordinates.
      camera.matrix.copy(camera.matrixWorld);
      camera.matrix.decompose(camera.position, camera.quaternion, camera.scale);
    }
    camera.getWorldDirection(ahead);
    this.headH = Math.atan2(-ahead.z, ahead.x);
    this.headPitch = Math.asin(THREE.MathUtils.clamp(ahead.y, -1, 1));
  }

  // Where the headset's eyes are this frame (world positions), while it draws: WebXR
  // gives their poses at the start of the frame, relative to where draw() puts them.
  eyes(): THREE.Vector3[] {
    const cams = this.renderer.xr.getCamera().cameras;
    while (EYES.length < cams.length) EYES.push(new THREE.Vector3());
    EYES.length = cams.length;
    cams.forEach((c, i) => this.rig.localToWorld(EYES[i].copy(c.position)));
    return EYES;
  }

  // The camera the headset draws with (for checks against the game's own camera).
  get xrCamera() { return this.renderer.xr.getCamera(); }

  // The Daydream controller, paired over Web Bluetooth: the browser asks which device.
  private async pair(status: (s: string) => void) {
    const bt = (navigator as { bluetooth?: Bluetoothish }).bluetooth;
    if (!bt) return;
    try {
      const device = await bt.requestDevice({ filters: [{ name: 'Daydream controller' }], optionalServices: [DAYDREAM_SERVICE] });
      status('Connecting…');
      const server = await device.gatt.connect();
      // (For ?vrlog: every service and characteristic the controller offers.)
      try {
        const all = await (server as unknown as { getPrimaryServices(): Promise<{ uuid: string; getCharacteristics(): Promise<{ uuid: string; properties: Record<string, boolean> }[]> }[]> }).getPrimaryServices();
        this.gatt = [];
        for (const sv of all) {
          const cs = await sv.getCharacteristics().catch(() => []);
          const props = (p: Record<string, boolean>) => ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter((k) => p[k]).join(',');
          this.gatt.push(`${sv.uuid}: ${cs.map((c) => `${c.uuid.slice(4, 8)} [${props(c.properties)}]`).join('; ')}`);
          // Listen to every characteristic that can notify, and read those that can be read.
          for (const c of cs as unknown as (Characteristic & { uuid: string; properties: Record<string, boolean>; readValue(): Promise<DataView> })[]) {
            const tag = c.uuid.slice(4, 8);
            if (c.properties.notify || c.properties.indicate) {
              c.addEventListener('characteristicvaluechanged', () => { this.seen[tag] = (this.seen[tag] ?? 0) + 1; this.read(c.value); });
              c.startNotifications().then(() => this.gatt.push(`${tag} notifying`), (e) => this.gatt.push(`${tag} notify failed: ${e}`));
            }
            if (c.properties.read) c.readValue().then((v) => this.gatt.push(`${tag} read ${Array.from(new Uint8Array(v.buffer)).join(' ')}`), (e) => this.gatt.push(`${tag} read failed: ${e}`));
          }
        }
      } catch (e) { this.gatt = [`services: ${e}`]; }
      const data = await (await server.getPrimaryService(DAYDREAM_SERVICE)).getCharacteristic(DAYDREAM_DATA);
      data.addEventListener('characteristicvaluechanged', () => this.read(data.value));
      await data.startNotifications();
      device.addEventListener('gattserverdisconnected', () => {
        Object.assign(this.daydream, { touched: false, click: false, app: false, plus: false, minus: false });
        status('Controller disconnected. Tap to connect it again.');
      });
      status('Controller connected');
    } catch (e) {
      console.warn('Daydream controller', e);
      status('No controller connected. Tap to try again.');
    }
  }

  // One report from the controller (the layout as worked out in three.js's old
  // DaydreamController example): buttons in byte 18, the touchpad across bytes 16–18.
  private read(v: DataView) {
    this.reports++;
    this.raw = Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    if (v.byteLength < 19) return;
    const b = v.getUint8(18);
    const x = ((v.getUint8(16) & 0x1f) << 3 | (v.getUint8(17) & 0xe0) >> 5) / 255;
    const y = ((v.getUint8(17) & 0x1f) << 3 | (v.getUint8(18) & 0xe0) >> 5) / 255;
    Object.assign(this.daydream, {
      click: (b & 0x1) > 0, app: (b & 0x4) > 0, minus: (b & 0x8) > 0, plus: (b & 0x10) > 0,
      x, y, touched: x > 0 || y > 0,
    });
  }

  private buttons() {
    const style = document.createElement('style');
    style.textContent = `
      #vr-bar { position: fixed; left: 50%; top: 42%; transform: translateX(-50%); z-index: 50;
        display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; max-width: calc(100vw - 32px); }
      #vr-bar button { font: inherit; font-size: 16px; padding: 10px 16px; border-radius: 6px; border: 0;
        background: rgba(20, 16, 14, 0.85); color: #fff; cursor: pointer; }
      #vr-bar button.main { background: #c8352b; }
      #vr-bar p { flex-basis: 100%; margin: 0; text-align: center; color: #fff; font-size: 13px;
        text-shadow: 0 1px 2px #000; }
      body.in-vr #vr-bar, #vr-bar[hidden] { display: none; }`;
    document.head.appendChild(style);
    const bar = this.bar;
    bar.id = 'vr-bar';
    bar.hidden = true;
    const go = document.createElement('button');
    go.className = 'main';
    go.textContent = t('Play in VR');
    const plain = document.createElement('button');
    plain.textContent = t('Play without VR');
    plain.onclick = () => this.without();
    const note = document.createElement('p');
    const xr = (navigator as { xr?: XRish }).xr;
    const says = (s: string) => { note.textContent = t(s); };
    if (!xr) { go.disabled = true; says(isSecureContext ? 'This browser can’t show VR. Try Chrome on an Android phone.' : 'VR needs a secure (https) address.'); }
    else void xr.isSessionSupported('immersive-vr').then((ok) => {
      go.disabled = !ok;
      says(ok ? 'Tap Play in VR, then put the phone in the headset.' : 'This phone or browser can’t show VR.');
    }, () => says('This phone or browser can’t show VR.'));
    go.onclick = () => { void this.enter().catch((e) => { console.warn('VR', e); says('VR couldn’t start. Try again.'); }); };
    bar.append(go, plain);
    // (The Daydream controller doesn't work yet: docs/handbook.md. ?daydream offers it.)
    if ((navigator as { bluetooth?: unknown }).bluetooth && new URLSearchParams(location.search).has('daydream')) {
      const pad = document.createElement('button');
      pad.textContent = 'Connect Daydream controller';
      pad.onclick = () => { void this.pair((s) => { pad.textContent = s; }); };
      bar.append(pad);
    }
    bar.append(note);
    document.body.appendChild(bar);
  }
}

// The VR mode, when the page was opened for it. The tier sets the eyes' resolution
// at entry; ?vrscale=0.3…1 overrides it for this visit.
export function setupVR(params: URLSearchParams, renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, key: (code: string) => void, without: () => void) {
  if (initialView(params) !== 'vr') return null;
  const asked = Number(params.get('vrscale'));
  const scale = Number.isFinite(asked) && asked > 0 ? THREE.MathUtils.clamp(asked, 0.3, 1) : null;
  const vr = new VR(renderer, camera, key, scale, without);
  // ?vrlog=<port>: the controls' state, twice a second, to a listener on the computer (for
  // a phone whose Chrome can't be inspected remotely; `adb reverse` the port).
  const log = Number(params.get('vrlog'));
  if (log) setInterval(() => {
    const v = vr as unknown as Record<string, unknown>;
    navigator.sendBeacon(`http://localhost:${log}/`, JSON.stringify({
      active: vr.active, fps: vr.fps, loopMs: vr.loopMs, drawMs: vr.drawMs, move: vr.move, side: vr.side, run: vr.run, reports: v.reports, raw: v.raw, gatt: v.gatt, seen: v.seen, daydream: v.daydream,
      pads: [...(navigator.getGamepads?.() ?? [])].filter(Boolean).map((p) => ({ id: p!.id, mapping: p!.mapping, axes: p!.axes.map((a) => +a.toFixed(2)), pressed: p!.buttons.flatMap((b, i) => (b.pressed ? [i] : [])) })),
    }));
  }, 500);
  (window as { __vr?: VR }).__vr = vr; // (for checks from the console or scripts)
  return vr;
}
