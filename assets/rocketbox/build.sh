#!/usr/bin/env bash
# Life-size people for the first-person view: Microsoft Rocketbox avatars and their own
# motion-captured walks, runs and ways of standing about (MIT, see LICENSE.md here), into
# public/rocketbox/. Needs curl and node (run from the repository, for three.js).
#
#   assets/rocketbox/build.sh
#
# The avatars come from the GLB repack on Hugging Face (codepawl/rocketbox-avatars-glb,
# lod1: half the triangles, KTX2 textures); the clips from Microsoft's own repository,
# converted by clips.mjs for the shared Bip01 skeleton.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../public/rocketbox"
work="${TMPDIR:-/tmp}/rocketbox-build"
mkdir -p "$out" "$work/anims"

# Who appears (AVATARS in src/rocketbox.ts lists the same, with f or m for the clips).
AVATARS="female-adult-01 female-adult-03 female-adult-05 female-adult-08 female-adult-11 female-adult-14
male-adult-01 male-adult-04 male-adult-07 male-adult-10 male-adult-13 male-adult-17
business-female-02 business-male-03"
HF=https://huggingface.co/datasets/codepawl/rocketbox-avatars-glb/resolve/main/lods
for a in $AVATARS; do
  [ -s "$out/$a.glb" ] || curl -sfL -o "$out/$a.glb" "$HF/$a/${a}_lod1.glb"
done

# The clips: walking, jogging (a slow run) and running, for men and women. These are the
# versions that travel (motextr_xy): src/rocketbox.ts takes the travel out and keeps the
# distance as the stride.
GH=https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets/Animations
for g in m f; do
  for c in walk_neutral_01 run_slow_01 run_neutral_01; do
    [ -s "$work/anims/${g}_$c.fbx" ] || curl -sfL -o "$work/anims/${g}_$c.fbx" "$GH/all_animations_max_motextr_xy/${g}_$c.max.fbx"
  done
done
# Standing about (on the spot, motextr_static): the ways of waiting that src/rocketbox.ts
# (STANDING) takes turns with, and holding an umbrella up.
for c in f_idle_neutral_01 f_idle_neutral_02 f_idle_neutral_09 f_idle_look_around_01 f_cell_phone_textmessage f_umbrella_idle_01 \
  m_idle_neutral_01 m_idle_neutral_02 m_idle_neutral_09 m_idle_look_around_01 m_cell_phone_textmessage m_cell_phone_talk_01 m_umbrella_idle_02; do
  [ -s "$work/anims/$c.fbx" ] || curl -sfL -o "$work/anims/$c.fbx" "$GH/all_animations_max_motextr_static/$c.max.fbx"
done

# The clips in the avatars' own bone axes (clips.mjs says why), measured on one avatar that
# also comes as Rocketbox's original FBX.
[ -s "$work/Female_Adult_01.fbx" ] || curl -sfL -o "$work/Female_Adult_01.fbx" \
  "https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/0943055db6ec570bcef9f2c8b41c9e5467c808f9/Assets/Avatars/Adults/Female_Adult_01/Export/Female_Adult_01.fbx"
node "$here/clips.mjs" "$work/anims" "$work/Female_Adult_01.fbx" "$out/female-adult-01.glb" "$out/clips.bin"
rm -f "$out/clips.glb"

# KTX2 textures are decoded in the browser by three.js's Basis transcoder.
cp "$here/../../node_modules/three/examples/jsm/libs/basis/basis_transcoder."{js,wasm} "$out/"
cp "$here/LICENSE.md" "$out/LICENSE.md"
du -sh "$out"
