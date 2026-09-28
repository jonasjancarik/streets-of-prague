"""The trams' recorded sounds: cut from Freesound recordings of Prague trams into the
short clips the game plays (src/audio.ts).

    uv run build_audio.py        # → public/audio/*.wav, *.m4a (needs ffmpeg)

The recordings are Freesound's public previews (192 kbps Ogg), downloaded once into
.cache/audio/freesound/; nearly all are CC0 from two packs recorded by students of a
Prague school, and one (the motor) is CC BY 4.0, credited in the README. Every clip's
source is in public/audio/SOURCES.md.

Where each clip comes from was picked by measuring the recordings (loudness and the
strongest tone over time), not by ear:

- Loops (the rolling, the motor's whine, the wheels' squeal in a curve) are evened
  out to a steady level, so the game alone decides how loud they are, and crossfaded
  end into start so they repeat without a seam. They're WAV: compressed formats pad
  the start of a file, which leaves a gap in a loop.
- One-off sounds (the bell, pulling away, arriving at a stop) are AAC, faded in and
  out at the cuts.
"""

import subprocess
from pathlib import Path

import numpy as np
import requests

HERE = Path(__file__).parent
CACHE = HERE / ".cache" / "audio" / "freesound"
OUT = HERE.parent / "public" / "audio"
SR = 44100

# Freesound id: preview file (the path under cdn.freesound.org/previews/).
SOURCES = {
    497561: "497/497561_10809263-hq.ogg",  # 11-3 Tram bell
    497557: "497/497557_10809263-hq.ogg",  # 11-2 Tram bell
    497559: "497/497559_10809263-hq.ogg",  # 11-1 Tram bell
    497560: "497/497560_10809263-hq.ogg",  # 15_Tram passing by
    621068: "621/621068_2059089-hq.ogg",  # tramvaj nova prujezd nabrezi MS (CC BY 4.0, ozvuk)
    497551: "497/497551_10809263-hq.ogg",  # 08 Sound of railway
    497564: "497/497564_10809263-hq.ogg",  # 14 Tram leaving the station
    461311: "461/461311_9677231-hq.ogg",  # 09-1_departure-close
    461320: "461/461320_9677231-hq.ogg",  # 10_arrival
}

# name: (source, channel (None: both mixed), start s, end s, kind, rate, high-pass Hz)
# The bells are recorded with the two microphones out of phase, so mixing them
# would cancel much of the ring: one channel. 621068 is mid-side: its left channel
# is the mid, a plain mono recording.
CLIPS = {
    "bell-1": (497561, 0, 0.2, 1.95, "once", SR, None),
    "bell-2": (497557, 0, 0.2, 1.25, "once", SR, None),
    "bell-3": (497559, 0, 0.7, 1.9, "once", SR, None),
    "roll": (497560, None, 9.0, 17.5, "loop", 22050, None),  # the tram going by, closest
    "motor": (621068, 0, 6.25, 9.25, "loop", 32000, None),  # a new tram's whine, ~900 Hz
    "squeal": (497551, None, 1.0, 3.0, "loop", 32000, 1500),  # ~5 kHz
    "depart-1": (497564, None, 2.2, 16.2, "once", SR, None),
    "depart-2": (461311, None, 3.4, 10.3, "once", SR, None),
    "arrive": (461320, None, 6.5, 15.0, "once", SR, None),
}


def fetch(sid: int) -> Path:
    path = CACHE / f"{sid}.ogg"
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        r = requests.get(f"https://cdn.freesound.org/previews/{SOURCES[sid]}", timeout=60)
        r.raise_for_status()
        path.write_bytes(r.content)
    return path


def load(sid: int) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(fetch(sid)), "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).astype(np.float64)


def highpass(x: np.ndarray, hz: float) -> np.ndarray:
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    spec *= np.clip((f - hz * 0.7) / (hz * 0.3), 0, 1)
    return np.fft.irfft(spec, len(x))


def envelope(x: np.ndarray, seconds: float) -> np.ndarray:
    n = max(1, int(SR * seconds))
    k = np.hanning(n)
    return np.sqrt(np.convolve(x * x, k / k.sum(), mode="same")) + 1e-6


def loop(x: np.ndarray) -> np.ndarray:
    # Level out the swell of a passing tram, then fold the last half second over the
    # start: the end runs on into the beginning.
    x = x / envelope(x, 0.4)
    fade = int(SR * 0.5)
    body = x[:-fade].copy()
    r = np.linspace(0, 1, fade)
    body[:fade] = x[-fade:] * np.sqrt(1 - r) + x[:fade] * np.sqrt(r)
    return body / np.sqrt((body ** 2).mean()) * 0.1  # -20 dBFS


def once(x: np.ndarray) -> np.ndarray:
    fade_in, fade_out = int(SR * 0.01), int(SR * 0.3)
    x = x.copy()
    x[:fade_in] *= np.linspace(0, 1, fade_in)
    x[-fade_out:] *= np.linspace(1, 0, fade_out) ** 2
    return x / np.abs(x).max() * 0.89  # -1 dBFS


def write(name: str, x: np.ndarray, kind: str, rate: int):
    OUT.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(x, -1, 1).astype(np.float32).tobytes()
    out = OUT / (f"{name}.wav" if kind == "loop" else f"{name}.m4a")
    codec = ["-c:a", "pcm_s16le"] if kind == "loop" else ["-c:a", "aac", "-b:a", "96k"]
    # (Resampled before the crossfade point matters: the loop's length changes with
    # the rate, not its seam.)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-",
                    "-ar", str(rate), *codec, str(out)], input=pcm, check=True)
    return out


def main():
    for name, (sid, channel, start, end, kind, rate, hp) in CLIPS.items():
        s = load(sid)
        x = (s[:, channel] if channel is not None else s.mean(1))[int(start * SR):int(end * SR)]
        if hp:
            x = highpass(x, hp)
        x = loop(x) if kind == "loop" else once(x)
        out = write(name, x, kind, rate)
        print(f"{out.name:14} {len(x) / SR:5.2f} s  {out.stat().st_size / 1000:6.0f} kB  from {sid}")


if __name__ == "__main__":
    main()
