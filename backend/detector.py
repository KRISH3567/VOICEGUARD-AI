import base64
import io
import logging
import os
import re
from pathlib import Path

from dotenv import load_dotenv

# Load backend/.env here too (not just in main.py) so the HIVE_API_KEY /
# GOOGLE_STT_* module-level constants below are populated correctly no
# matter what order main.py imports this module vs. calls load_dotenv().
load_dotenv()

logger = logging.getLogger("voiceguard.detector")

SAMPLE_RATE = 16000
CLIP_LENGTH = 64600
MODEL_ID = os.environ.get("XLSR_MODEL_ID", "lab260/Spectra-AASIST3")

# Human-readable "model version" strings recorded in provenance history
# (backend/db.py) so a later audit can tell which detector produced a
# given score. HIVE_MODEL_VERSION is a label, not an API parameter — Hive
# doesn't expose a version number through this endpoint.
LOCAL_MODEL_VERSION = MODEL_ID
HIVE_MODEL_VERSION = "hive-ai-generated-and-deepfake-detection-v3"

# --- Hive AI-Generated & Deepfake Content Detection (v3) ---
# https://docs.thehive.ai/docs/ai-generated-and-deepfake-content-detection-playground
# Generate a "Service API Key" in the Hive dashboard and put it in backend/.env
# as HIVE_API_KEY. The model key below covers image/video/audio in one endpoint.
HIVE_API_KEY = os.environ.get("HIVE_API_KEY", "")
HIVE_API_URL = os.environ.get(
    "HIVE_API_URL",
    "https://api.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection",
)
HIVE_TIMEOUT_SECONDS = 60

# --- Google Cloud Speech-to-Text (v1) ---
# Transcribes the call and feeds scan_keywords()/scan_pii(). Needs the
# Speech-to-Text API enabled on a GCP project and either an API key
# (GOOGLE_STT_API_KEY, simplest) or an OAuth access token (GOOGLE_STT_ACCESS_TOKEN,
# e.g. from `gcloud auth application-default print-access-token` on a service
# account — more suitable for production than a bare API key).
GOOGLE_STT_API_KEY = os.environ.get("GOOGLE_STT_API_KEY", "")
GOOGLE_STT_ACCESS_TOKEN = os.environ.get("GOOGLE_STT_ACCESS_TOKEN", "")
GOOGLE_STT_URL = "https://speech.googleapis.com/v1/speech:recognize"
GOOGLE_STT_PRIMARY_LANGUAGE = os.environ.get("GOOGLE_STT_PRIMARY_LANGUAGE", "en-IN")
GOOGLE_STT_ALT_LANGUAGES = [
    lang.strip() for lang in os.environ.get("GOOGLE_STT_ALT_LANGUAGES", "hi-IN").split(",") if lang.strip()
]
GOOGLE_STT_TIMEOUT_SECONDS = 60

model = None

# Languages tried in order when transcribing. Most VoiceGuard calls mix
# Hindi and English mid-sentence, so we try English first and fall back
# to Hindi rather than guessing a single language up front.
TRANSCRIPTION_LANGUAGES = os.environ.get("TRANSCRIPTION_LANGUAGES", "en-IN,hi-IN").split(",")

SCAM_KEYWORDS = [
    "money laundering", "credit card", "debit card", "card number", "cvv",
    "otp", "one time password", "pin number", "wire transfer", "urgent transfer",
    "emergency", "gift card", "bitcoin", "cryptocurrency", "social security",
    "bank account", "bank details", "routing number", "verify your account",
    "account suspended", "account blocked", "act now", "act immediately",
    "don't tell anyone", "keep this secret", "phone number", "share your",
    "lakh", "crore", "prize", "reward", "cash prize", "lottery",
    "you have won", "you will get", "congratulations", "claim your",
    "processing fee", "aadhar", "pan card", "kyc", "verification code",
    "confirm your identity", "sim swap", "remote access", "screen share",
    "anydesk", "teamviewer",
]

# Flat points per distinct scam phrase found. A phrase only counts once no
# matter how many times it's repeated in the transcript — scan_keywords
# already returns each phrase at most once, so repeats never add points.
KEYWORD_RISK_BOOST = 20
KEYWORD_RISK_CAP = 90
KEYWORD_MATCH_FLOOR = 45

REQUIRED_MODULES = (
    "torch", "scipy", "transformers", "huggingface_hub",
    "safetensors", "soundfile", "speech_recognition",
)


def load_model():
    global model
    if model is None:
        from huggingface_hub import hf_hub_download
        import importlib.util

        path = hf_hub_download(repo_id=MODEL_ID, filename="model.py")
        spec = importlib.util.spec_from_file_location("spectra_aasist3", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        model = module.SpectraAASIST3.from_pretrained(MODEL_ID)
        model.eval()
    return model


def prepare_audio(audio_bytes: bytes):
    import math

    import numpy as np
    import soundfile as sf
    import torch
    from scipy.signal import resample_poly

    data, sample_rate = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=True)
    mono = np.mean(data, axis=1)
    if mono.size == 0:
        raise ValueError("Decoded audio has no samples — file may be corrupt or an unsupported format.")

    if sample_rate != SAMPLE_RATE:
        # Resample with scipy instead of torchaudio: torchaudio's compiled
        # extension is unreliable on some Windows/Python builds, and scipy
        # does the same job (rational-ratio polyphase resampling) without it.
        divisor = math.gcd(SAMPLE_RATE, sample_rate)
        up, down = SAMPLE_RATE // divisor, sample_rate // divisor
        mono = resample_poly(mono, up, down).astype(np.float32)

    waveform = torch.from_numpy(mono)

    boosted = waveform.clone()
    boosted[1:] = waveform[1:] - 0.97 * waveform[:-1]

    if boosted.numel() < CLIP_LENGTH:
        boosted = boosted.repeat(CLIP_LENGTH // boosted.numel() + 1)
    return boosted[:CLIP_LENGTH]


def get_audio_metadata(audio_bytes: bytes, filename: str = "") -> dict:
    """Best-effort metadata for provenance records: duration, sample rate,
    channel count, and a format guess. Uses the same decoder (soundfile)
    as prepare_audio()/analyze(), so anything that can be scored can also
    be described here. Never raises — analysis should not fail just
    because provenance metadata couldn't be computed, so decode errors
    fall back to a duration of None and a format guessed from the
    filename extension."""
    fmt = Path(filename).suffix.lstrip(".").lower() or None
    try:
        import soundfile as sf

        with sf.SoundFile(io.BytesIO(audio_bytes)) as f:
            duration = round(f.frames / f.samplerate, 2) if f.samplerate else None
            return {
                "duration_seconds": duration,
                "sample_rate": f.samplerate,
                "channels": f.channels,
                "format": (f.format or fmt or "unknown").lower(),
            }
    except Exception:
        logger.warning("Could not read audio metadata for %s; storing size/format only", filename)
        return {"duration_seconds": None, "sample_rate": None, "channels": None, "format": fmt or "unknown"}


def analyze(audio_bytes: bytes) -> int:
    import torch
    import torch.nn.functional as F

    waveform = prepare_audio(audio_bytes)
    with torch.inference_mode():
        probabilities = F.softmax(load_model()(waveform.unsqueeze(0)), dim=1)[0]
    return max(0, min(100, round(float(probabilities[0]) * 100)))


def hive_configured() -> bool:
    return bool(HIVE_API_KEY)


def analyze_with_hive(audio_bytes: bytes, content_type: str = "audio/wav") -> dict:
    """Send the clip to Hive's v3 AI-Generated & Deepfake Content Detection
    API and return a risk score normalized to VoiceGuard's 0-100 scale.

    Raises RuntimeError if no key is configured, and requests.HTTPError /
    requests.RequestException on transport or API errors — callers should
    catch and translate those into an HTTP response.
    """
    import requests

    if not HIVE_API_KEY:
        raise RuntimeError("HIVE_API_KEY is not set — add it to backend/.env.")

    encoded = base64.b64encode(audio_bytes).decode("ascii")
    payload = {"input": [{"media_base64": f"data:{content_type};base64,{encoded}"}]}

    response = requests.post(
        HIVE_API_URL,
        headers={
            "Authorization": f"Bearer {HIVE_API_KEY}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=HIVE_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    data = response.json()

    # Hive returns nested chunk/frame classifications rather than one flat
    # score. Walk the whole response and take the single highest confidence
    # reported for the "ai_generated" class, across every chunk returned.
    best_confidence = 0.0

    def walk(node):
        nonlocal best_confidence
        if isinstance(node, dict):
            if node.get("class") == "ai_generated" and isinstance(node.get("score"), (int, float)):
                best_confidence = max(best_confidence, node["score"])
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(data)
    risk_score = max(0, min(100, round(best_confidence * 100)))
    return {"risk_score": risk_score, "raw": data}


# --- Lightweight PII detection on the call transcript ---
# This is a regex layer, not an NLP model — it exists to flag the moment a
# caller asks for or states sensitive identifiers during a call, which is a
# strong scam signal on its own. It has real limits: speech-to-text often
# spells digits as words ("one two three"), so _normalize_spoken_digits
# collapses runs of spoken-word digits into numerals before matching.
_WORD_DIGITS = {
    "zero": "0", "oh": "0", "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
}
_WORD_DIGIT_PATTERN = re.compile(
    r"\b(" + "|".join(_WORD_DIGITS.keys()) + r")\b(?:[\s,-]+\b(" +
    "|".join(_WORD_DIGITS.keys()) + r")\b)+",
    re.IGNORECASE,
)

PII_PATTERNS = {
    "email_address": re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),
    "phone_number": re.compile(r"(?:\+?\d{1,3}[-.\s]?)?\d{10}\b"),
    "card_number": re.compile(r"\b(?:\d[ -]?){13,16}\b"),
    "aadhaar_number": re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b"),
    "pan_card": re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b"),
    "cvv_or_otp_spoken": re.compile(r"\b(?:cvv|otp|pin)\D{0,10}\d{3,6}\b", re.IGNORECASE),
}


def _normalize_spoken_digits(transcript: str) -> str:
    def replace(match: "re.Match") -> str:
        words = re.split(r"[\s,-]+", match.group(0).strip())
        return "".join(_WORD_DIGITS[w.lower()] for w in words if w.lower() in _WORD_DIGITS)

    return _WORD_DIGIT_PATTERN.sub(replace, transcript)


def scan_pii(transcript: str) -> list[str]:
    if not transcript:
        return []
    normalized = _normalize_spoken_digits(transcript)
    return [label for label, pattern in PII_PATTERNS.items() if pattern.search(normalized)]


def scan_keywords(transcript: str) -> list[str]:
    if not transcript:
        return []
    lowered = transcript.lower()
    return [kw for kw in SCAM_KEYWORDS if kw in lowered]


def _to_wav_16k_mono_pcm16(audio_bytes: bytes) -> bytes:
    """Decode whatever format was uploaded (webm/mp3/wav/...) into a clean
    16kHz mono 16-bit PCM WAV — the format Google STT's LINEAR16 config
    expects. Kept separate from prepare_audio(), which additionally applies
    pre-emphasis and pads/truncates to CLIP_LENGTH for the spoof model only;
    that shaping would hurt transcription quality."""
    import math

    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly

    data, sample_rate = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=True)
    mono = np.mean(data, axis=1)
    if mono.size == 0:
        raise ValueError("Decoded audio has no samples — file may be corrupt or an unsupported format.")

    if sample_rate != SAMPLE_RATE:
        divisor = math.gcd(SAMPLE_RATE, sample_rate)
        up, down = SAMPLE_RATE // divisor, sample_rate // divisor
        mono = resample_poly(mono, up, down).astype(np.float32)

    pcm16 = (np.clip(mono, -1.0, 1.0) * 32767).astype(np.int16)
    buffer = io.BytesIO()
    sf.write(buffer, pcm16, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def google_stt_configured() -> bool:
    return bool(GOOGLE_STT_API_KEY or GOOGLE_STT_ACCESS_TOKEN)


def transcribe_with_google(audio_bytes: bytes) -> str:
    """Transcribe via Google Cloud Speech-to-Text v1 (speech:recognize).
    Raises RuntimeError if no credential is configured, and
    requests.HTTPError / requests.RequestException on API errors — callers
    should catch and translate those into an HTTP response."""
    import requests

    if not google_stt_configured():
        raise RuntimeError("Neither GOOGLE_STT_API_KEY nor GOOGLE_STT_ACCESS_TOKEN is set — add one to backend/.env.")

    wav_bytes = _to_wav_16k_mono_pcm16(audio_bytes)
    payload = {
        "config": {
            "encoding": "LINEAR16",
            "sampleRateHertz": SAMPLE_RATE,
            "languageCode": GOOGLE_STT_PRIMARY_LANGUAGE,
            "alternativeLanguageCodes": GOOGLE_STT_ALT_LANGUAGES,
            "enableAutomaticPunctuation": True,
        },
        "audio": {"content": base64.b64encode(wav_bytes).decode("ascii")},
    }

    headers = {"Content-Type": "application/json"}
    params = {}
    if GOOGLE_STT_ACCESS_TOKEN:
        headers["Authorization"] = f"Bearer {GOOGLE_STT_ACCESS_TOKEN}"
    else:
        params["key"] = GOOGLE_STT_API_KEY

    response = requests.post(
        GOOGLE_STT_URL, headers=headers, params=params, json=payload, timeout=GOOGLE_STT_TIMEOUT_SECONDS
    )
    response.raise_for_status()
    data = response.json()

    parts = []
    for result in data.get("results", []):
        alternatives = result.get("alternatives", [])
        if alternatives and alternatives[0].get("transcript"):
            parts.append(alternatives[0]["transcript"].strip())
    return " ".join(parts)


def transcribe_fallback(audio_bytes: bytes) -> str:
    """Free, unofficial fallback used only when Google STT isn't configured
    — Google's public web-speech endpoint via SpeechRecognition. Lower
    accuracy and no uptime guarantee; keep GOOGLE_STT_API_KEY set in
    production."""
    import speech_recognition as sr

    recognizer = sr.Recognizer()
    try:
        with sr.AudioFile(io.BytesIO(audio_bytes)) as source:
            audio = recognizer.record(source)
    except Exception:
        logger.exception("Could not read audio for transcription")
        return ""

    for language in TRANSCRIPTION_LANGUAGES:
        language = language.strip()
        if not language:
            continue
        try:
            return recognizer.recognize_google(audio, language=language)
        except sr.UnknownValueError:
            # No clear speech in this language — try the next one.
            continue
        except sr.RequestError as exc:
            logger.warning("Speech recognition service unavailable: %s", exc)
            return ""

    return ""


def is_ready() -> bool:
    try:
        for module_name in REQUIRED_MODULES:
            __import__(module_name)
        return True
    except ImportError:
        return False
