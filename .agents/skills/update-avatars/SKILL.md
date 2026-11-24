---
name: update-avatars
description: Modernize an existing Streets of Prague Rocketbox avatar for first- and third-person views. Use for civilian clothing, face and hair textures, garment fit, and visible seams or duplicate layers on the skinned model.
---

# Update a street avatar

Start with one named avatar in `AVATARS` in `src/rocketboxClips.ts`. Follow its catalogue entry through the close model, its middle-distance crowd bake and any uniforms or seated drivers that reuse it. Riding is a pose available to the same civilian. Keep their identity through mounting and dismounting. The overhead crowd has its own lightweight figures.

## Capture the donor

With the game running, use the helper from the repository root. It selects the named player and photographs the full outfit, face, left and right sides of the chest, and nape in the same daylight. Use separate output directories before and after the edit. Add `--motion` for walking, running, bicycle and motorbike shots when the changed garment or shoes need a movement check.

```sh
node .agents/skills/update-avatars/capture.mjs male-adult-07 screenshots/avatars/male-adult-07/before
```

Inspect the actual pictures. Use an ordinary third-person view to judge the silhouette and a street-level close-up for the face, fabric and seams. Keep a pristine donor GLB outside `public/`. A shipped GLB may already contain a refit. Use the upstream LOD1 location in `assets/rocketbox/build.sh` when you need the original.

## Inspect the mesh and textures

Unpack the donor’s body, head and any masked hair maps at their native size. Follow each material’s base-color texture through `KHR_texture_basisu` to the embedded image. The unpacking code in `assets/rocketbox/crowd_atlas.py` shows the lookup. Take the level-zero image before the crowd resize and preserve alpha on hair or glasses. For generated artwork, request a flat base-colour atlas with neutral lighting, the original aspect ratio and the same UV island layout.

When an edge looks wrong, hold the pose and light fixed. In a temporary preview, hide the suspect faces or give the UV islands distinct flat colours. A painted collar point follows the texture. A folded lapel has its own faces, lining and silhouette. A hair card can cast a stripe on a correctly aligned scalp. Trace each visible layer before deciding what to edit.

- **Outfit.** Choose a contemporary cut and fabrics that read in the game’s daylight. Use the donor UV atlas as the reference when generating replacement artwork with ImageGen. Keep island placement, hands and openings aligned. Ask for plain fabric beneath modeled collars or pockets. Check the result on the mesh for a second painted collar, buttons on the tee, or features that cross a seam.
- **Face.** Use the head atlas as the reference for a fictional face. Keep the eye openings, ears, nostrils, lip split, hairline and separate eye or mouth islands registered. Inspect the face head-on and in profile. Compare the jaw and nape with the hands under the same light. Record the native artwork size separately from the packed texture size.
- **Fit.** Use Blender or Blender MCP for silhouette changes. Work in bind pose and carry joint weights across new seams. For a layered garment, model the continuous surface beneath an open collar and check the underside and nape as the head turns. Preserve the skeleton, inverse bind matrices, facial targets and animation names. Use geometry for the garment’s outline and folds. Bake weave and stitching into the maps.

The navy overshirt in `assets/rocketbox/overshirt/` is a worked example. `build.mjs` checks the donor hash and writes the GLB. Its Blender script, `tailor.py`, fits the panels, and `materials.py` aligns and packs the artwork. Its vertex numbers, bind transform and UV coordinates belong to `male-adult-07`. Measure those again for another donor. Keep editable art and its recipe under `assets/rocketbox/`. Wire new refits into `build.sh` for clean builds and credit the donor and generated artwork in `assets/SOURCES.md`.

## Bake and verify

Rebuild the close GLB from the pristine input. Keep meshopt compression, mipmapped KTX2 textures, and the material name suffixes the crowd baker reads (`_body`, `_head`, and, where used, `_opacity` or `_glasses`). Compare triangles, material primitives and download size with the donor. For a frame-time question, use the project’s performance skill.

After a clothing, face or geometry change, run `node assets/rocketbox/crowd.mjs` to regenerate `public/rocketbox/crowd.bin.gz` and `crowd.webp`. Repeat the capture against the rebuilt assets. Approach a passer-by in first person to check that their face and outfit agree across the switch to the close model. Check the established figures at normal overhead zoom. For a full refit, use the existing scene checks for vehicle contacts, dismounts and the crowd handoff.

```sh
node scripts/scene.mjs run riding-avatars street-crowd --fresh
```

For edits to leg or shoe weights, `node scripts/check-riding-poses.mjs` checks grip and shoe contact across the catalogue. Use `avatar-footwork` for gait changes. Keep the most informative matched screenshots in the ignored `screenshots/` directory.
