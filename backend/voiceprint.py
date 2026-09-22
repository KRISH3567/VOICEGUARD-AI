"""Dependency-light acoustic voiceprint baseline.

This is intentionally not a neural speaker-recognition model. It extracts a
fixed-length normalized acoustic feature vector from PCM WAV audio and compares
it with cosine similarity. It is suitable for structural integration and
unit-testing; production identity decisions should use a validated speaker
embedding model and calibrated threshold.
"""
from __future__ import annotations

import io
import math
import struct
import wave

EMBEDDING_FORMAT = "acoustic-v1-json"
EMBEDDING_SIZE = 48
MATCH_THRESHOLD = 0.82


def _read_wav_samples(audio_bytes: bytes) -> tuple[list[float], int]:
    with wave.open(io.BytesIO(audio_bytes), "rb") as wav:
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        sample_rate = wav.getframerate()
        frame_count = wav.getnframes()
        if channels < 1 or sample_rate < 1 or sample_width not in (1, 2, 4):
            raise ValueError("unsupported WAV parameters")
        raw = wav.readframes(frame_count)
    if sample_width == 1:
        values = [(b - 128) / 128.0 for b in raw]
    elif sample_width == 2:
        values = [v / 32768.0 for v in struct.unpack("<%dh" % (len(raw) // 2), raw)]
    else:
        values = [v / 2147483648.0 for v in struct.unpack("<%di" % (len(raw) // 4), raw)]
    mono = [sum(values[i:i + channels]) / channels for i in range(0, len(values), channels)]
    return mono, sample_rate


def _resample(values: list[float], target_size: int = 4096) -> list[float]:
    if not values:
        return [0.0] * target_size
    if len(values) <= target_size:
        return values + [0.0] * (target_size - len(values))
    step = len(values) / target_size
    return [values[min(len(values) - 1, int(i * step))] for i in range(target_size)]


def extract_embedding(audio_bytes: bytes) -> list[float]:
    """Extract a fixed-size normalized acoustic vector from PCM WAV bytes."""
    samples, sample_rate = _read_wav_samples(audio_bytes)
    samples = _resample(samples)
    frame_size = max(32, len(samples) // 16)
    features: list[float] = []
    for index in range(16):
        frame = samples[index * frame_size:(index + 1) * frame_size]
        if not frame:
            frame = [0.0]
        energy = math.sqrt(sum(v * v for v in frame) / len(frame))
        crossings = sum(1 for a, b in zip(frame, frame[1:]) if (a < 0) != (b < 0)) / max(1, len(frame) - 1)
        centroid = sum((i + 1) * abs(v) for i, v in enumerate(frame)) / max(1e-9, sum(abs(v) for v in frame))
        features.extend((energy, crossings, centroid / len(frame)))
    mean = sum(features) / len(features)
    centered = [v - mean for v in features]
    norm = math.sqrt(sum(v * v for v in centered)) or 1.0
    return [round(v / norm, 8) for v in centered]


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if len(left) != len(right) or not left:
        raise ValueError("embedding vectors must have the same non-zero length")
    left_norm = math.sqrt(sum(v * v for v in left)) or 1.0
    right_norm = math.sqrt(sum(v * v for v in right)) or 1.0
    return max(-1.0, min(1.0, sum(a * b for a, b in zip(left, right)) / (left_norm * right_norm)))


def compare_embeddings(incoming: list[float], enrolled: list[float], threshold: float = MATCH_THRESHOLD) -> dict:
    similarity = cosine_similarity(incoming, enrolled)
    score = round((similarity + 1.0) / 2.0, 4)
    matched = score >= threshold
    return {
        "score": score,
        "match": matched,
        "message": "voice matches enrolled sample for this account." if matched else "voice does not match enrolled sample for this account.",
    }
