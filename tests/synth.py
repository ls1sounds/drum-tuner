"""Synthetic drum-hit generator used by the tests.

A real drum head vibrates in several "modes" at once. For an ideal circular
membrane the modes sit at these multiples of the fundamental (lowest) pitch:
1.00, 1.59, 2.14, 2.30, 2.65, 2.92 ... (not whole-number harmonics, which is
why drums sound less "pitched" than a guitar string).

We add: a noisy stick attack, a slight pitch drop right after the hit (real
heads do this), different decay rates per mode, optional second head slightly
detuned (causes beating), and background noise.
"""
import io
import wave

import numpy as np

MODE_RATIOS = [1.0, 1.594, 2.136, 2.296, 2.653, 2.918]
# Relative amplitude of each mode depending on where the head is struck.
CENTER_AMPS = [1.0, 0.15, 0.10, 0.45, 0.08, 0.20]  # centre hit: (0,n) modes strong
LUG_AMPS = [0.6, 1.0, 0.7, 0.35, 0.5, 0.3]  # near-edge tap: (1,1), (2,1) strong


def drum_hit(f0, sr=48000, dur=1.2, strike="center", decay=0.35, glide=0.03,
             second_head=None, attack_noise=0.6, seed=0):
    rng = np.random.default_rng(seed)
    t = np.arange(int(sr * dur)) / sr
    amps = CENTER_AMPS if strike == "center" else LUG_AMPS
    out = np.zeros_like(t)
    # pitch glide: starts a bit sharp, settles within ~60 ms
    bend = 1 + glide * np.exp(-t / 0.06)
    heads = [(f0, 1.0)]
    if second_head:
        heads.append((second_head, 0.6))
    for fh, ha in heads:
        for i, (r, a) in enumerate(zip(MODE_RATIOS, amps)):
            f = fh * r * bend
            phase = 2 * np.pi * np.cumsum(f) / sr
            tau = decay / (1 + 0.8 * i)  # higher modes die faster
            out += ha * a * np.exp(-t / tau) * np.sin(phase + rng.uniform(0, 6.28))
    # stick attack: short burst of filtered noise
    n_att = int(0.012 * sr)
    att = rng.normal(0, 1, n_att) * np.exp(-np.arange(n_att) / (0.003 * sr))
    out[:n_att] += attack_noise * att
    return out


def sequence(hits, sr=48000, gap=1.5, lead=0.8, noise=0.003, gain=0.25, seed=1):
    """Place several hits (list of arrays) in one signal with silence between."""
    rng = np.random.default_rng(seed)
    total = int(sr * (lead + gap * len(hits) + 0.5))
    sig = rng.normal(0, noise, total)
    for i, h in enumerate(hits):
        start = int(sr * (lead + gap * i))
        seg = h[: total - start]
        sig[start:start + len(seg)] += gain * seg / np.max(np.abs(seg))
    return sig.astype(np.float32)


def to_wav_bytes(sig, sr=48000):
    pcm = (np.clip(sig, -1, 1) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()
