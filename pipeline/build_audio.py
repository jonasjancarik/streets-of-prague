"""The game's recorded sounds: the trams, and the city around you, cut from Freesound
recordings (most of them made in Prague) into the clips the game plays (src/audio.ts).

    uv run build_audio.py        # → public/audio/*.wav, *.m4a (needs ffmpeg)

The recordings are Freesound's public previews (192 kbps Ogg), downloaded once into
.cache/audio/freesound/. The trams' are nearly all CC0, from two packs recorded by
students of a Prague school; the ones under CC BY are credited in the README. Every
clip's source is in public/audio/SOURCES.md.

Where each clip comes from was picked by measuring the recordings (loudness and the
strongest tone over time), not by ear:

- Loops (the rolling, the motor's whine, the wheels' squeal in a curve) are evened
  out to a steady level, so the game alone decides how loud they are, and crossfaded
  end into start so they repeat without a seam. They're WAV: compressed formats pad
  the start of a file, which leaves a gap in a loop.
- A car's engine (engine-*) is three loops of one car held at steady revs, which the
  game plays faster or slower and fades between as the revs change. An engine's sound
  repeats with every turn, so each loop ends where the recording best matches its own
  start: the seam falls on the same point of the engine's cycle.
- One-off sounds (the bell, pulling away, arriving at a stop) are AAC, faded in and
  out at the cuts.
- The city's sound (amb-*: the crowd, traffic, the night, birds) is long stereo loops,
  the steadiest stretch of each recording (no loud one-off sound, as even a level at
  the end as at the start), crossfaded over two seconds and only slowly evened out,
  so it keeps its own swell. Birdsong ("song") isn't evened out at all: it's phrases
  with quiet between them, which evening out would fill with noise. The Old Town crowds
  are walla, six stretches at once so no words come through (see WALLA). AAC: at 45 s or
  more a small gap at the seam wouldn't matter as much as the size, and browsers
  decode it without one.
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
    212034: "212/212034_3658882-hq.ogg",  # Prague, Staro Mesto, City Center part.2 (CC BY 3.0, vonfleisch)
    212035: "212/212035_3658882-hq.ogg",  # Prague, Staro Mesto, City Center part.1 (CC BY 3.0, vonfleisch)
    94309: "94/94309_542096-hq.ogg",  # Prague Atmo Traffic from 5th floor (CC BY 4.0, aUREa)
    572530: "572/572530_97550-hq.ogg",  # Night city rumble quiet distant traffic (TRP)
    116791: "116/116791_1088850-hq.ogg",  # Blackbird 252 (nigelcoop)
    475836: "475/475836_3374104-hq.ogg",  # Birds in the garden 1 (rionka, Brno)
    498378: "498/498378_10815958-hq.ogg",  # 01 - atmosphere, a garden in the morning (16FHermanovaB)
    845611: "845/845611_12846320-hq.ogg",  # Hyundai Kona, engine idle, exterior (CC BY 4.0, KVV_Audio)
    845607: "845/845607_12846320-hq.ogg",  # Hyundai Kona, engine at 2000 rpm, exterior (CC BY 4.0, KVV_Audio)
    845609: "845/845609_12846320-hq.ogg",  # Hyundai Kona, engine at 3000 rpm, exterior (CC BY 4.0, KVV_Audio)
}

# name: (source, channel (None: both mixed, "stereo": both kept), start s, end s, kind, rate, high-pass Hz)
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
    # The city (src/audio.ts, Ambience): the steadiest stretch of each, found by measuring.
    "amb-traffic": (94309, "stereo", 39.0, 86.0, "amb", SR, None),
    "amb-night": (572530, "stereo", 71.0, 123.0, "amb", SR, None),
    "amb-blackbird": (116791, "stereo", 30.0, 92.0, "song", SR, None),
    "amb-garden": (475836, "stereo", 0.0, 27.5, "song", SR, None),
    "amb-morning": (498378, "stereo", 20.0, 67.0, "amb", SR, None),
    # A petrol car's engine at steady revs (src/audio.ts, RecordedEngine). Measured, the
    # cylinders fire 24, 74.5 and 97 times a second in them: about 720, 2240 and 2910 rpm.
    "engine-idle": (845611, None, 10.0, 16.5, "engine", 32000, None),
    "engine-mid": (845607, None, 6.0, 12.5, "engine", 32000, None),
    "engine-high": (845609, None, 8.0, 14.5, "engine", 32000, None),
}


# The Old Town crowds, as walla: one recording played alone lets the voices close to the
# microphone through word for word, so each loop is six stretches of the two Old Town
# recordings at once (every other one with its sides swapped), which mask each other
# into a murmur. Then the moments louder than the last few seconds (a voice up close)
# are pulled back, the highs (the consonants) softened and a short reverb added, which
# puts the crowd at a distance. Measured with the sound-levels skill's speech.py: the
# rhythm of speech over plain noise went from 5.6 (one recording) to about 2.
# name: (length s, [(source, start s), ...]); the two loops layered repeat only every ~200 s.
WALLA = {
    "amb-crowd": (50.0, [(212034, 96), (212035, 3), (212034, 112), (212035, 22), (212034, 128), (212035, 45)]),
    "amb-crowd2": (40.0, [(212034, 90), (212035, 10), (212034, 106), (212035, 30), (212034, 140), (212035, 60)]),
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


def envelope_fft(x: np.ndarray, seconds: float) -> np.ndarray:
    # The same by FFT, far faster over long stretches (kept apart so the other clips
    # come out byte for byte as before).
    k = np.hanning(max(1, int(SR * seconds)))
    k /= k.sum()
    size = 1 << (len(x) + len(k) - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x * x, size) * np.fft.rfft(k, size), size)[len(k) // 2:len(k) // 2 + len(x)]
    return np.sqrt(np.maximum(y, 0)) + 1e-6


def loop(x: np.ndarray) -> np.ndarray:
    # Level out the swell of a passing tram, then fold the last half second over the
    # start: the end runs on into the beginning.
    x = x / envelope(x, 0.4)
    fade = int(SR * 0.5)
    body = x[:-fade].copy()
    r = np.linspace(0, 1, fade)
    body[:fade] = x[-fade:] * np.sqrt(1 - r) + x[:fade] * np.sqrt(r)
    return body / np.sqrt((body ** 2).mean()) * 0.1  # -20 dBFS


def engine(x: np.ndarray) -> np.ndarray:
    # As loop(), but the end is put where the next quarter second is most like the first
    # (looked for over the last 0.3 s), so the engine's cycle carries on over the seam.
    x = x / envelope(x, 0.4)
    fade, search = int(SR * 0.25), int(SR * 0.3)
    head = x[:fade]
    first = len(x) - fade - search
    score = [np.dot(x[e:e + fade], head) / np.sqrt((x[e:e + fade] ** 2).sum()) for e in range(first, len(x) - fade)]
    end = first + int(np.argmax(score))
    body = x[:end].copy()
    r = np.linspace(0, 1, fade)
    body[:fade] = x[end:end + fade] * (1 - r) + head * r
    body = dewhine(body)
    return body / np.sqrt((body ** 2).mean()) * 0.1  # -20 dBFS


def dewhine(x: np.ndarray) -> np.ndarray:
    # Thin, steady tones above 400 Hz (a 2 kHz whistle in the idle recording, the whine
    # of belts and electrics in the others) stand 14-20 dB over the sound around them, and
    # turn into a rising whistle once the game plays the loop faster. Each is cut down to
    # the level of its surroundings (the median within 60 Hz). Done on the finished loop,
    # which repeats exactly, so its spectrum can be changed without touching the seam.
    spec = np.fft.rfft(x)
    mag = np.abs(spec)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    half = int(60 * len(x) / SR)
    step = max(1, half // 8)  # the median every few bins is enough, then interpolated
    at = np.arange(0, len(mag), step)
    med = np.interp(np.arange(len(mag)), at, [np.median(mag[max(0, i - half):i + half + 1]) for i in at])
    limit = np.where(f > 400, med * 1.4, np.inf)
    return np.fft.irfft(spec * np.minimum(1, limit / (mag + 1e-12)), len(x))


def ambience(x: np.ndarray, even=True) -> np.ndarray:
    # Stereo: even out only the slow drift (a 6 s window over both channels), then fold
    # the last two seconds over the start.
    if even:
        x = x / envelope(x.mean(1), 6.0)[:, None]
    fade = int(SR * 2)
    body = x[:-fade].copy()
    r = np.linspace(0, 1, fade)[:, None]
    body[:fade] = x[-fade:] * np.sqrt(1 - r) + x[:fade] * np.sqrt(r)
    return body / np.sqrt((body ** 2).mean()) * 0.1  # -20 dBFS


def walla(parts: list[tuple[int, float]], length: float) -> np.ndarray:
    n = int((length + 2) * SR)  # (+2 s: folded over the start by ambience())
    mix = np.zeros((n, 2))
    for i, (sid, start) in enumerate(parts):
        seg = load(sid)[int(start * SR):int(start * SR) + n]
        seg = seg / envelope_fft(seg.mean(1), 6.0)[:, None]
        mix += (seg[:, ::-1] if i % 2 else seg) / np.sqrt(len(parts))
    # A slow, gentle compressor: what's louder than the last ~6 s comes back towards it.
    fast, slow = envelope_fft(mix.mean(1), 0.25), envelope_fft(mix.mean(1), 6.0)
    mix = mix / np.maximum(fast / slow, 1.0)[:, None] ** 0.7
    # Highs 8 dB down above ~2.5 kHz, then a 0.8 s reverb, a third of the sound.
    f = np.fft.rfftfreq(n, 1 / SR)
    shelf = 10 ** (-8 / 20 * np.clip((f - 1500) / 2500, 0, 1))
    rng = np.random.default_rng(1)
    t = np.arange(int(SR * 0.8)) / SR
    size = 1 << (n + len(t) - 1).bit_length()
    for c in (0, 1):
        ir = rng.standard_normal(len(t)) * np.exp(-t * 6.9 / 0.8)
        dry = np.fft.irfft(np.fft.rfft(mix[:, c]) * shelf, n)
        wet = np.fft.irfft(np.fft.rfft(dry, size) * np.fft.rfft(ir / np.sqrt((ir ** 2).sum()), size), size)[:n]
        mix[:, c] = dry * 0.65 + wet * 0.35
    return ambience(mix)


def once(x: np.ndarray) -> np.ndarray:
    fade_in, fade_out = int(SR * 0.01), int(SR * 0.3)
    x = x.copy()
    x[:fade_in] *= np.linspace(0, 1, fade_in)
    x[-fade_out:] *= np.linspace(1, 0, fade_out) ** 2
    return x / np.abs(x).max() * 0.89  # -1 dBFS


def write(name: str, x: np.ndarray, kind: str, rate: int):
    OUT.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(x, -1, 1).astype(np.float32).tobytes()
    out = OUT / (f"{name}.wav" if kind in ("loop", "engine") else f"{name}.m4a")
    codec = {"loop": ["-c:a", "pcm_s16le"], "engine": ["-c:a", "pcm_s16le"], "once": ["-c:a", "aac", "-b:a", "96k"], "amb": ["-c:a", "aac", "-b:a", "80k"], "song": ["-c:a", "aac", "-b:a", "80k"]}[kind]
    channels = "2" if x.ndim == 2 else "1"
    # (Resampled before the crossfade point matters: the loop's length changes with
    # the rate, not its seam.)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", channels, "-i", "-",
                    "-ar", str(rate), *codec, str(out)], input=pcm, check=True)
    return out


def main():
    for name, (sid, channel, start, end, kind, rate, hp) in CLIPS.items():
        s = load(sid)[int(start * SR):int(end * SR)]
        x = s if channel == "stereo" else s[:, channel] if channel is not None else s.mean(1)
        if hp:
            x = highpass(x, hp)
        x = {"loop": loop, "engine": engine, "once": once, "amb": ambience, "song": lambda x: ambience(x, even=False)}[kind](x)
        out = write(name, x, kind, rate)
        print(f"{out.name:14} {len(x) / SR:5.2f} s  {out.stat().st_size / 1000:6.0f} kB  from {sid}")
    for name, (length, parts) in WALLA.items():
        x = walla(parts, length)
        out = write(name, x, "amb", SR)
        print(f"{out.name:14} {len(x) / SR:5.2f} s  {out.stat().st_size / 1000:6.0f} kB  from {sorted({p[0] for p in parts})}")


if __name__ == "__main__":
    main()
