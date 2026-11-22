---
read_when:
  - Thinking about drawing VR with the WebGPU renderer instead of the legacy WebGL one
  - Deciding whether to keep or delete the WebGL renderer and its GLSL
  - Planning VR on iPhone, a native app or wrapper, or a Cardboard mode without WebXR
---

# VR on WebGPU: options

Written 22 November 2026 from a discussion, before any prototype. Nothing here has been
measured.

## Why VR is drawn with WebGL today

- **The browser.** A page draws into a headset through a binding between WebXR and its
  graphics API. The WebGL binding has shipped for years. The WebGPU one (`XRGPUBinding`,
  the [WebXR/WebGPU Binding](https://immersive-web.github.io/WebXR-WebGPU-Binding/)
  module) is still an Editor's Draft, and Chrome offers it only for developer testing
  behind a flag (Windows and Android since Chrome 135). Players don't have it.
- **three.js is ready for it.** r187's `XRManager` uses `XRGPUBinding` when the session
  has the `webgpu` feature, but it warns that WebGPU XR has no multiview yet, so each eye
  would be a pass of its own.
- **The WebGPU renderer's WebGL mode was tried and dropped.** With `forceWebGL` the VR
  prototype drew no people and broken trees, so VR reloads the page into the legacy
  `WebGLRenderer` (`src/vr.ts`, the handbook's VR section).

Consequences:

- VR runs on the old GLSL shaders. The WebGL renderer can't be deleted while VR needs
  it, and its look can drift from the WebGPU one.
- WebGPU-only optimisations (compute culling, indirect draws) don't reach VR. What helps
  VR has to work in both renderers: fewer draws, fewer shadow casters, fewer triangles.

## A native app or wrapper

Not worth it for speed: the phone is held back by three.js's JavaScript for each object
and by the GPU's work on each pixel, and a wrapper runs the same JavaScript on the same
GPU. It would save only the hop to Chrome's GPU process, and a different JavaScript
engine (Hermes, QuickJS) would be slower than V8.

For VR on WebGPU the usual wrappers don't help:

| Wrapper | WebGPU | WebXR | VR on WebGPU |
|---|---|---|---|
| Trusted Web Activity | the player's Chrome | the player's Chrome | no: no binding, and no flags for players |
| Android WebView | yes | none | worse than today |
| Native app (Dawn or `react-native-wgpu` with three.js, Google's Cardboard SDK for lenses and head tracking) | yes | not needed | yes, but the interface, tile workers, MapLibre minimap and Web Audio would have to be replaced or bridged |

## Cardboard without WebXR, in the page

What a native app would really do is skip WebXR, and the page can do that itself.
Cardboard is two views side by side, a lens correction and the phone's motion sensors:

- draw the left and right eye into one WebGPU target;
- correct for the lenses in a last pass (start with the Cardboard v2 viewer's values;
  maybe read a viewer's QR profile later);
- follow the head from the gyroscope (Generic Sensor API, `DeviceOrientation` as the
  fallback);
- go fullscreen and lock the screen to landscape.

What it would bring:

- VR on the maintained WebGPU path, with its shared shader graphs and tuned materials.
- Every WebGPU optimisation reaches VR too.
- **VR on iPhone.** Safari has WebGPU but has never had WebXR, so no wrapper or flag gets
  Cardboard there any other way. iOS asks for permission before giving motion sensors.

Risks:

- **Head tracking.** Chrome's WebXR predicts where the head will be when the frame shows.
  Without that the view lags the head, which makes people sick. This is where most of the
  work would go.
- **Lenses differ between viewers.** One set of default values fits Cardboard v2 and is
  only roughly right for others.
- **Speed is unknown.** Two eyes cost about twice the draws on either renderer. Whether
  WebGPU stereo beats today's WebGL stereo (12–16 fps on the Pixel 5, performance log,
  22 November) has to be measured; draws and triangles stay the main cost on both.

## Next steps, if taken up

1. Check whether the Pixel 5's Chrome has `XRGPUBinding` behind a flag
   (`chrome://flags`, WebXR/WebGPU), only to learn how far off the real binding is.
2. A Cardboard mode behind a URL option on the WebGPU renderer: both eyes, the lens pass
   and gyroscope tracking, compared with today's WebXR VR on the Pixel 5 standing on the
   Old Town Square (frame times, draws, triangles), and judged in a viewer for lag.
3. Only if it holds up: head-movement prediction, the viewer's QR profile, iPhone.
