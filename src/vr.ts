import * as THREE from 'three';

// VR on a phone in a headset (a Daydream View, a Cardboard), behind ?vr: the game's own
// first-person view, drawn once per eye by the browser's WebXR (Chrome on Android draws the
// lenses' correction and follows the head with the phone's sensors). The game places a
// "rig" each frame, where your eyes are and which way is straight ahead, and the head turns
// round it. Drawn with the WebGL renderer (renderer.ts): three.js has no WebXR for WebGPU.
//
// Moving: a gamepad's left stick (right stick turns in steps), the Daydream controller over
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
const DAYDREAM_SERVICE = 0xfe55;
const DAYDREAM_DATA = '00000001-1000-1000-8000-00805f9b34fb';

const ahead = new THREE.Vector3();

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
  private frames = 0;
  private since = 0;
  private padSnap = false;
  private bar = document.createElement('div');
  private ddClick = false; private ddPlus = false; private ddMinus = false;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private camera: THREE.PerspectiveCamera,
    private key: (code: string) => void,
    private scale: number,
  ) {
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local');
    renderer.xr.setFramebufferScaleFactor(scale);
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

  // The game has begun: the buttons show.
  ready() { this.bar.hidden = false; }

  // Into the headset (the browser asks for this from a tap).
  async enter() {
    const xr = (navigator as { xr?: XRish }).xr;
    if (!xr) return;
    const session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local'] });
    session.addEventListener('end', () => this.leave());
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
    document.body.classList.remove('in-vr');
    window.requestAnimationFrame = this.nativeRAF;
    const waiting = this.queue; this.queue = [];
    for (const cb of waiting) this.nativeRAF(cb);
  }

  // At the start of each frame: the frames others asked for, and this frame's controls.
  frame(now: number, dt: number, pad: { move: number; turn: number }) {
    if (!this.active) return;
    // Frames per second in the headset, for checking (window.__vr.fps).
    this.frames++;
    if (now - this.since >= 1000) { this.fps = Math.round(this.frames * 1000 / (now - this.since)); this.frames = 0; this.since = now; }
    this.xrTarget = this.renderer.getRenderTarget();
    const waiting = this.queue; this.queue = [];
    for (const cb of waiting) { try { cb(now); } catch (e) { console.error(e); } }

    let move = 0, side = 0, run = false;
    // A gamepad: the left stick walks (forward is ahead of your eyes), the right one turns.
    for (const p of navigator.getGamepads?.() ?? []) {
      if (!p || p.mapping !== 'standard') continue;
      const dead = (v = 0) => (Math.abs(v) < 0.2 ? 0 : v);
      move = move || -dead(p.axes[1]); side = side || -dead(p.axes[0]);
      const sx = dead(p.axes[2]);
      if (sx && !this.padSnap) this.turned -= Math.sign(sx) * SNAP;
      this.padSnap = Math.abs(p.axes[2] ?? 0) > 0.5;
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
    try { render(); } finally {
      rig.remove(camera);
      // The game reads the camera as it was drawn, in the city's own coordinates.
      camera.matrix.copy(camera.matrixWorld);
      camera.matrix.decompose(camera.position, camera.quaternion, camera.scale);
    }
    camera.getWorldDirection(ahead);
    this.headH = Math.atan2(-ahead.z, ahead.x);
    this.headPitch = Math.asin(THREE.MathUtils.clamp(ahead.y, -1, 1));
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
    go.textContent = 'Play in VR';
    const note = document.createElement('p');
    const xr = (navigator as { xr?: XRish }).xr;
    const says = (s: string) => { note.textContent = s; };
    if (!xr) { go.disabled = true; says(isSecureContext ? 'This browser has no VR. Try Chrome on Android.' : 'VR needs a secure (https) address.'); }
    else void xr.isSessionSupported('immersive-vr').then((ok) => {
      go.disabled = !ok;
      says(ok ? 'Tap Play in VR, then put the phone in the headset.' : 'This phone or browser can\'t show VR.');
    }, () => says('This phone or browser can\'t show VR.'));
    go.onclick = () => { void this.enter().catch((e) => { console.warn('VR', e); says('VR couldn\'t start. Try again.'); }); };
    bar.append(go);
    if ((navigator as { bluetooth?: unknown }).bluetooth) {
      const pad = document.createElement('button');
      pad.textContent = 'Connect Daydream controller';
      pad.onclick = () => { void this.pair((s) => { pad.textContent = s; }); };
      bar.append(pad);
    }
    bar.append(note);
    document.body.appendChild(bar);
  }
}

// The VR mode, where it is asked for (?vr; ?vrscale=0.5…1 sets how sharp, less for speed).
export function setupVR(params: URLSearchParams, renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, key: (code: string) => void) {
  if (!params.has('vr')) return null;
  const scale = THREE.MathUtils.clamp(Number(params.get('vrscale')) || 0.75, 0.3, 1);
  const vr = new VR(renderer, camera, key, scale);
  (window as { __vr?: VR }).__vr = vr; // (for checks from the console or scripts)
  return vr;
}
