import csv
import hashlib
import html
import io
import math
import json
import logging
import time
import wave
from pathlib import Path
from typing import Annotated

from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name(".env"))  # load backend/.env before detector reads env vars

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

try:
    from . import db
    from .voiceprint import EMBEDDING_FORMAT, compare_embeddings, extract_embedding
    from .detector import (
        HIVE_MODEL_VERSION,
        KEYWORD_MATCH_FLOOR,
        KEYWORD_RISK_BOOST,
        KEYWORD_RISK_CAP,
        LOCAL_MODEL_VERSION,
        analyze,
        analyze_with_hive,
        get_audio_metadata,
        google_stt_configured,
        hive_configured,
        is_ready,
        scan_keywords,
        scan_pii,
        transcribe_fallback,
        transcribe_with_google,
    )
except ImportError:  # supports `uvicorn main:app` from backend/
    import db
    from voiceprint import EMBEDDING_FORMAT, compare_embeddings, extract_embedding
    from detector import (
        HIVE_MODEL_VERSION,
        KEYWORD_MATCH_FLOOR,
        KEYWORD_RISK_BOOST,
        KEYWORD_RISK_CAP,
        LOCAL_MODEL_VERSION,
        analyze,
        analyze_with_hive,
        get_audio_metadata,
        google_stt_configured,
        hive_configured,
        is_ready,
        scan_keywords,
        scan_pii,
        transcribe_fallback,
        transcribe_with_google,
    )

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voiceguard")

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_BATCH_FILES = 20
FEEDBACK_LOG_PATH = Path(__file__).parent / "feedback_log.jsonl"
TRANSCRIPT_SUMMARY_MAX_CHARS = 280
REPORT_TTL_SECONDS = 90 * 24 * 3600  # verification links expire 90 days after creation

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
db.init_db()

# Internal status codes (GENUINE | SUSPICIOUS | AI_IMPERSONATION) are left
# unchanged everywhere they're used as a value - only how they're *shown*
# to a human changes here. Kept in one place so the report/verify page and
# /analytics/summary consumers can't drift from what the frontend shows.
CLASSIFICATION_LABELS = {
    "GENUINE": "Likely Genuine",
    "SUSPICIOUS": "Possibly Synthetic",
    "AI_IMPERSONATION": "Likely AI Clone",
}
ENGINE_LABELS = {
    "local": "Local model (Spectra-AASIST3)",
    "hive": "Hive API v3",
}

VALID_API_ROLES = {"reviewer", "analyst"}


def require_role(required_role: str):
    # NOTE: API-key auth disabled for local/solo use. Every route that used
    # to require a reviewer/analyst key now passes automatically. Restore
    # the original check (see project history) before exposing this server
    # beyond your own machine.
    if required_role not in VALID_API_ROLES:
        raise ValueError(f"Unknown API role: {required_role}")

    def dependency():
        return {"id": 0, "role": required_role, "label": "no-auth"}

    return dependency


def classify(risk_score: int):
    if risk_score < 40:
        return "GENUINE", "TRANSACTION_AUTHORIZED", "Voice verified as genuine. Transfer cleared."
    if risk_score < 75:
        return "SUSPICIOUS", "TRANSACTION_ON_HOLD", "Acoustic anomalies detected. Transfer on hold."
    return "AI_IMPERSONATION", "TRANSACTION_BLOCKED", "High impersonation risk. Transfer blocked."


@app.get("/api/status")
def status():
    return {"ready": is_ready()}


@app.get("/api/config")
def config():
    """Tells the frontend which detection providers it can actually offer,
    so the toggle can disable/hide options that aren't configured yet."""
    return {
        "providers": {
            "local": {"available": is_ready(), "label": "Local model (Spectra-AASIST3)"},
            "hive": {"available": hive_configured(), "label": "Hive API v3"},
        },
        "transcription": {
            "engine": "google" if google_stt_configured() else "fallback",
            "google_available": google_stt_configured(),
        },
    }


def _validate_provider(provider: str) -> str:
    provider = (provider or "local").lower()
    if provider not in ("local", "hive"):
        raise HTTPException(400, "provider must be 'local' or 'hive'.")
    if provider == "local" and not is_ready():
        raise HTTPException(503, "Model not ready. Did you run pip install -r requirements.txt?")
    if provider == "hive" and not hive_configured():
        raise HTTPException(400, "Hive API key not configured on the server. Set HIVE_API_KEY in backend/.env.")
    return provider


async def _score_audio(audio_bytes: bytes, content_type: str, provider: str) -> tuple[int, str]:
    """Runs the configured detector and returns (voice_risk_score, model_version)."""
    if provider == "hive":
        hive_result = await run_in_threadpool(analyze_with_hive, audio_bytes, content_type or "audio/wav")
        return hive_result["risk_score"], HIVE_MODEL_VERSION
    risk_score = await run_in_threadpool(analyze, audio_bytes)
    return risk_score, LOCAL_MODEL_VERSION


async def _transcribe(audio_bytes: bytes) -> tuple[str, str]:
    """Transcription is scam/PII-signal only, so it degrades gracefully:
    prefer Google STT, and fall back to the free unofficial endpoint
    (or an empty transcript) rather than failing the whole request."""
    transcript_provider = "google" if google_stt_configured() else "fallback"
    try:
        if google_stt_configured():
            transcript = await run_in_threadpool(transcribe_with_google, audio_bytes)
        else:
            transcript = await run_in_threadpool(transcribe_fallback, audio_bytes)
    except Exception as exc:
        logger.warning("Google STT failed (%s), falling back to the free endpoint", exc)
        transcript_provider = "fallback"
        try:
            transcript = await run_in_threadpool(transcribe_fallback, audio_bytes)
        except Exception:
            logger.exception("Fallback transcription also failed")
            transcript = ""
    return transcript, transcript_provider


def _persist_provenance(
    *,
    content_hash: str,
    filename: str,
    source_type: str,
    metadata: dict,
    size_bytes: int,
    provider: str,
    model_version: str,
    risk_score: int,
    voice_risk_score: int,
    status_label: str,
    batch_id: str | None,
    transcript_summary: str,
    pii_matches: list[str],
    matched_keywords: list[str],
) -> str:
    """Synchronous DB work for one analyzed clip, run off the event loop via
    run_in_threadpool (same pattern used for the detector/transcription
    calls above). Returns the new audio_id.

    transcript_summary/pii_matches/matched_keywords feed two later
    features without ever persisting the audio itself: Feature C (Trust
    Badge & Verification Report) reads them back when a report is
    generated, and Feature D (Risk Trends & Analytics Dashboard) reads
    the normalized keyword rows this writes to audio_keyword_hits."""
    with db.get_connection() as conn:
        prior = db.find_prior_event_for_hash(conn, content_hash)
        audio_id = db.create_audio_record(
            conn,
            content_hash=content_hash,
            filename=filename,
            source_type=source_type,
            format=metadata["format"],
            size_bytes=size_bytes,
            duration_seconds=metadata["duration_seconds"],
            provider=provider,
            model_version=model_version,
            risk_score=risk_score,
            voice_risk_score=voice_risk_score,
            status=status_label,
            batch_id=batch_id,
            transcript_summary=transcript_summary,
            pii_matches=pii_matches,
            matched_keywords=matched_keywords,
        )
        if prior is None:
            event_type, detail = "created", f"Analyzed via {provider} ({source_type})."
        elif source_type == "uploaded":
            event_type, detail = "re_uploaded", f"Same audio re-uploaded and analyzed via {provider}."
        else:
            event_type, detail = "re_analyzed", f"Same audio re-analyzed via {provider}."
        db.add_event(conn, audio_id=audio_id, content_hash=content_hash, event_type=event_type, detail=detail)
        db.append_audit_event(conn, event_type="ANALYSIS_COMPLETED", actor="system", resource_type="audio", resource_id=audio_id, detail={"filename": filename, "status": status_label, "risk_score": risk_score, "provider": provider})
    return audio_id


async def run_full_analysis(
    audio_bytes: bytes,
    filename: str,
    content_type: str,
    provider: str,
    source_type: str,
    batch_id: str | None = None,
    customer_id: str | None = None,
) -> dict:
    """Shared analysis core used by both /api/analyze and /api/batch-analyze:
    scores the clip, transcribes it for the keyword/PII scan, classifies
    the combined risk score, and records a provenance entry (Feature A).
    Raises HTTPException on failure, same as the single-file endpoint did
    before this refactor."""
    start_time = time.perf_counter()
    try:
        voice_risk_score, model_version = await _score_audio(audio_bytes, content_type, provider)
    except Exception as exc:
        logger.exception("Voice-cloning analysis failed for %s via %s", filename, provider)
        raise HTTPException(502 if provider == "hive" else 500, f"Analysis failed: {exc}") from exc

    transcript, transcript_provider = await _transcribe(audio_bytes)

    matched_keywords = scan_keywords(transcript)
    pii_matches = scan_pii(transcript)
    keyword_boost = min(len(matched_keywords) * KEYWORD_RISK_BOOST, KEYWORD_RISK_CAP)
    combined_risk_score = max(0, min(100, voice_risk_score + keyword_boost))
    if matched_keywords:
        combined_risk_score = max(combined_risk_score, KEYWORD_MATCH_FLOOR)

    status_label, action, message = classify(combined_risk_score)

    # --- Feature A: provenance & edit history ---
    # content_hash groups every analysis of the same underlying audio
    # (re-uploads, re-analyzes) without ever persisting the audio bytes
    # themselves — see the module docstring in db.py.
    content_hash = hashlib.sha256(audio_bytes).hexdigest()
    metadata = await run_in_threadpool(get_audio_metadata, audio_bytes, filename)

    # Short excerpt only - never the full transcript or the audio itself.
    # Long enough for a verification report to be meaningfully checkable,
    # short enough that it can't reconstruct the whole call.
    transcript_summary = (transcript or "")[:TRANSCRIPT_SUMMARY_MAX_CHARS]
    if transcript and len(transcript) > TRANSCRIPT_SUMMARY_MAX_CHARS:
        transcript_summary += "…"

    voice_match = None
    if customer_id:
        with db.get_connection() as conn:
            enrollment = db.get_voice_enrollment(conn, customer_id)
        if enrollment is not None:
            try:
                incoming_embedding = await run_in_threadpool(extract_embedding, audio_bytes)
                voice_match = compare_embeddings(incoming_embedding, json.loads(enrollment["embedding"]))
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                logger.warning("Voiceprint comparison skipped for %s: %s", customer_id, exc)

    audio_id = await run_in_threadpool(
        _persist_provenance,
        content_hash=content_hash,
        filename=filename,
        source_type=source_type,
        metadata=metadata,
        size_bytes=len(audio_bytes),
        provider=provider,
        model_version=model_version,
        risk_score=combined_risk_score,
        voice_risk_score=voice_risk_score,
        status_label=status_label,
        batch_id=batch_id,
        transcript_summary=transcript_summary,
        pii_matches=pii_matches,
        matched_keywords=matched_keywords,
    )

    return {
        "audio_id": audio_id,
        "filename": filename,
        "provider": provider,
        "model_version": model_version,
        "transcript_provider": transcript_provider,
        "risk_score": combined_risk_score,
        "voice_risk_score": voice_risk_score,
        "keyword_matches": matched_keywords,
        "pii_matches": pii_matches,
        "transcript": transcript,
        "status": status_label,
        "action": action,
        "message": message,
        "duration_seconds": metadata["duration_seconds"],
        "latency_ms": round((time.perf_counter() - start_time) * 1000),
        "voice_match": voice_match,
    }


@app.post("/api/enroll/{customer_id}")
async def enroll_voice(customer_id: str, file: UploadFile = File(...), _actor: dict = Depends(require_role("reviewer"))):
    customer_id = customer_id.strip()
    if not customer_id or len(customer_id) > 160:
        raise HTTPException(400, "customer_id must be between 1 and 160 characters.")
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(400, "Reference clip is empty.")
    if len(audio_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Reference clip is too large (25 MB max).")
    try:
        embedding = await run_in_threadpool(extract_embedding, audio_bytes)
    except (ValueError, wave.Error) as exc:
        raise HTTPException(400, "Enrollment requires a readable PCM WAV reference clip.") from exc
    with db.get_connection() as conn:
        created_at, updated_at = db.upsert_voice_enrollment(
            conn, customer_id=customer_id, embedding=json.dumps(embedding), format=EMBEDDING_FORMAT
        )
    return {"customer_id": customer_id, "format": EMBEDDING_FORMAT, "created_at": created_at, "updated_at": updated_at}


@app.post("/api/analyze")
async def analyze_voice(
    file: UploadFile = File(...),
    provider: str = Form("local"),
    source_type: str = Form("uploaded"),
    customer_id: str = Form(""),
):
    provider = _validate_provider(provider)
    source_type = source_type if source_type in ("recorded", "uploaded") else "uploaded"

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(400, "Uploaded file is empty.")
    if len(audio_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File too large (25 MB max).")

    return await run_full_analysis(
        audio_bytes, file.filename or "clip.wav", file.content_type or "audio/wav", provider, source_type, customer_id=customer_id.strip() or None
    )


# --- Feature A: Audio Provenance & Edit History ---

def _audio_record_to_dict(row) -> dict:
    return {
        "id": row["id"],
        "filename": row["filename"],
        "source_type": row["source_type"],
        "format": row["format"],
        "size_bytes": row["size_bytes"],
        "duration_seconds": row["duration_seconds"],
        "created_at": row["created_at"],
        "provider": row["provider"],
        "model_version": row["model_version"],
        "risk_score": row["risk_score"],
        "voice_risk_score": row["voice_risk_score"],
        "status": row["status"],
        "flagged": bool(row["flagged"]),
        "batch_id": row["batch_id"],
    }


def _event_to_dict(row) -> dict:
    return {
        "event_type": row["event_type"],
        "detail": row["detail"],
        "created_at": row["created_at"],
    }


def _review_case_to_dict(row) -> dict:
    return {
        "id": row["id"], "audio_id": row["audio_id"], "filename": row["filename"],
        "created_at": row["created_at"], "updated_at": row["updated_at"],
        "status": row["status"], "priority": row["priority"], "title": row["title"],
        "resolution": row["resolution"] or "", "risk_score": row["risk_score"],
        "voice_risk_score": row["voice_risk_score"], "audio_status": row["audio_status"],
        "provider": row["provider"], "model_version": row["model_version"],
        "analyzed_at": row["analyzed_at"], "flagged": bool(row["flagged"]),
    }


def _case_note_to_dict(row) -> dict:
    return {"id": row["id"], "case_id": row["case_id"], "note": row["note"], "created_at": row["created_at"]}


def _get_record_or_404(conn, audio_id: str):
    record = db.get_audio_record(conn, audio_id)
    if record is None:
        raise HTTPException(404, "No audio record found for that id.")
    return record


@app.get("/api/audio/{audio_id}/provenance")
def get_provenance(audio_id: str, _actor: dict = Depends(require_role("reviewer"))):
    with db.get_connection() as conn:
        record = _get_record_or_404(conn, audio_id)
        events = db.get_events_for_hash(conn, record["content_hash"])
        return {
            "record": _audio_record_to_dict(record),
            "history": [_event_to_dict(e) for e in events],
        }


class FlagRequest(BaseModel):
    flagged: bool


@app.post("/api/audio/{audio_id}/flag")
def flag_audio(audio_id: str, body: FlagRequest = FlagRequest(flagged=True), _actor: dict = Depends(require_role("reviewer"))):
    with db.get_connection() as conn:
        record = _get_record_or_404(conn, audio_id)
        db.set_flagged(conn, audio_id, body.flagged)
        db.add_event(
            conn,
            audio_id=audio_id,
            content_hash=record["content_hash"],
            event_type="flagged" if body.flagged else "unflagged",
            detail="Marked by reviewer." if body.flagged else "Unmarked by reviewer.",
        )
        db.append_audit_event(conn, event_type="CLIP_FLAGGED" if body.flagged else "CLIP_UNFLAGGED", actor="reviewer", resource_type="audio", resource_id=audio_id, detail={"flagged": body.flagged, "risk_score": record["risk_score"]})
        case = db.get_open_case_for_audio(conn, audio_id)
        if body.flagged and case is None:
            priority = "CRITICAL" if (record["risk_score"] or 0) >= 75 else "HIGH"
            title = f"Review flagged clip: {record['filename'] or 'Voice clip'}"
            case_id = db.create_review_case(conn, audio_id=audio_id, title=title, priority=priority)
            case = db.get_review_case(conn, case_id)
        return {"id": audio_id, "flagged": body.flagged,
                "review_case": _review_case_to_dict(case) if case else None}


class ReviewCaseCreate(BaseModel):
    title: str | None = None
    priority: str = "HIGH"


class ReviewCaseUpdate(BaseModel):
    status: str
    priority: str
    title: str
    resolution: str = ""


class CaseNoteCreate(BaseModel):
    note: str


REVIEW_STATUSES = {"OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"}
REVIEW_PRIORITIES = {"LOW", "MEDIUM", "HIGH", "CRITICAL"}


def _validate_case_fields(*, status: str, priority: str) -> None:
    if status not in REVIEW_STATUSES:
        raise HTTPException(400, f"status must be one of: {', '.join(sorted(REVIEW_STATUSES))}.")
    if priority not in REVIEW_PRIORITIES:
        raise HTTPException(400, f"priority must be one of: {', '.join(sorted(REVIEW_PRIORITIES))}.")


@app.get("/api/review-cases")
def list_review_cases(status: str | None = None, limit: int = 100, _actor: dict = Depends(require_role("reviewer"))):
    status = status.upper() if status else None
    if status is not None and status not in REVIEW_STATUSES:
        raise HTTPException(400, "Unknown review case status.")
    if limit < 1 or limit > 200:
        raise HTTPException(400, "limit must be between 1 and 200.")
    with db.get_connection() as conn:
        cases = db.list_review_cases(conn, status=status, limit=limit)
        return {"cases": [_review_case_to_dict(case) for case in cases], "count": len(cases)}


@app.post("/api/audio/{audio_id}/review-case")
def create_audio_review_case(audio_id: str, payload: ReviewCaseCreate = ReviewCaseCreate(), _actor: dict = Depends(require_role("reviewer"))):
    priority = payload.priority.upper()
    _validate_case_fields(status="OPEN", priority=priority)
    title = (payload.title or "").strip()
    if len(title) > 160:
        raise HTTPException(400, "title must be 160 characters or fewer.")
    with db.get_connection() as conn:
        record = _get_record_or_404(conn, audio_id)
        existing = db.get_open_case_for_audio(conn, audio_id)
        if existing:
            return _review_case_to_dict(existing)
        case_id = db.create_review_case(
            conn, audio_id=audio_id,
            title=title or f"Review flagged clip: {record['filename'] or 'Voice clip'}",
            priority=priority,
        )
        db.set_flagged(conn, audio_id, True)
        db.add_event(conn, audio_id=audio_id, content_hash=record["content_hash"],
                     event_type="flagged", detail="Review case opened.")
        db.append_audit_event(conn, event_type="REVIEW_CASE_CREATED", actor="reviewer", resource_type="review_case", resource_id=case_id, detail={"audio_id": audio_id, "priority": priority})
        return _review_case_to_dict(db.get_review_case(conn, case_id))


@app.get("/api/review-cases/{case_id}")
def get_review_case(case_id: str, _actor: dict = Depends(require_role("reviewer"))):
    with db.get_connection() as conn:
        case = db.get_review_case(conn, case_id)
        if case is None:
            raise HTTPException(404, "No review case found for that id.")
        return {"case": _review_case_to_dict(case),
                "notes": [_case_note_to_dict(note) for note in db.get_case_notes(conn, case_id)]}


@app.patch("/api/review-cases/{case_id}")
def update_review_case(case_id: str, payload: ReviewCaseUpdate, _actor: dict = Depends(require_role("reviewer"))):
    status = payload.status.upper()
    priority = payload.priority.upper()
    _validate_case_fields(status=status, priority=priority)
    title = payload.title.strip()
    resolution = payload.resolution.strip()
    if not title or len(title) > 160:
        raise HTTPException(400, "title must be between 1 and 160 characters.")
    if len(resolution) > 1000:
        raise HTTPException(400, "resolution must be 1000 characters or fewer.")
    with db.get_connection() as conn:
        if db.get_review_case(conn, case_id) is None:
            raise HTTPException(404, "No review case found for that id.")
        db.update_review_case(conn, case_id=case_id, status=status, priority=priority,
                              title=title, resolution=resolution)
        db.append_audit_event(conn, event_type="REVIEW_CASE_UPDATED", actor="reviewer", resource_type="review_case", resource_id=case_id, detail={"status": status, "priority": priority})
        return {"case": _review_case_to_dict(db.get_review_case(conn, case_id))}


@app.post("/api/review-cases/{case_id}/notes")
def add_review_case_note(case_id: str, payload: CaseNoteCreate, _actor: dict = Depends(require_role("reviewer"))):
    note = payload.note.strip()
    if not note or len(note) > 2000:
        raise HTTPException(400, "note must be between 1 and 2000 characters.")
    with db.get_connection() as conn:
        if db.get_review_case(conn, case_id) is None:
            raise HTTPException(404, "No review case found for that id.")
        note_id = db.add_case_note(conn, case_id=case_id, note=note)
        db.append_audit_event(conn, event_type="REVIEW_NOTE_ADDED", actor="reviewer", resource_type="review_case", resource_id=case_id, detail={"note_id": note_id})
        row = conn.execute("SELECT id, case_id, note, created_at FROM case_notes WHERE id = ?", (note_id,)).fetchone()
        return {"note": _case_note_to_dict(row)}


# --- Feature B: Batch Analysis & Summary Report ---

@app.post("/api/batch-analyze")
async def batch_analyze(files: list[UploadFile] = File(...), provider: str = Form("local"), customer_id: str = Form("")):
    provider = _validate_provider(provider)
    if not files:
        raise HTTPException(400, "No files provided.")
    if len(files) > MAX_BATCH_FILES:
        raise HTTPException(400, f"Batch is limited to {MAX_BATCH_FILES} files at a time.")

    results = []
    for f in files:
        audio_bytes = await f.read()
        if not audio_bytes:
            results.append({"filename": f.filename, "error": "File is empty."})
            continue
        if len(audio_bytes) > MAX_UPLOAD_BYTES:
            results.append({"filename": f.filename, "error": "File too large (25 MB max)."})
            continue
        try:
            result = await run_full_analysis(
                audio_bytes, f.filename or "clip", f.content_type or "audio/wav", provider, "uploaded", customer_id=customer_id.strip() or None
            )
            results.append(result)
        except HTTPException as exc:
            results.append({"filename": f.filename, "error": exc.detail})

    scored = [r for r in results if "risk_score" in r]
    total = len(results)
    genuine = sum(1 for r in scored if r["status"] == "GENUINE")
    suspicious = sum(1 for r in scored if r["status"] == "SUSPICIOUS")
    blocked = sum(1 for r in scored if r["status"] == "AI_IMPERSONATION")
    avg_risk_score = round(sum(r["risk_score"] for r in scored) / len(scored), 1) if scored else None

    def _persist_batch() -> str:
        with db.get_connection() as conn:
            new_batch_id = db.create_batch(
                conn,
                provider=provider,
                total_count=total,
                genuine_count=genuine,
                suspicious_count=suspicious,
                blocked_count=blocked,
                avg_risk_score=avg_risk_score or 0,
            )
            # Backfill batch_id on the records this batch just created so
            # the CSV report / batch lookup below can find them by batch alone.
            for r in scored:
                conn.execute("UPDATE audio_records SET batch_id = ? WHERE id = ?", (new_batch_id, r["audio_id"]))
        return new_batch_id

    batch_id = await run_in_threadpool(_persist_batch)

    return {
        "batch_id": batch_id,
        "summary": {
            "total_count": total,
            "genuine_count": genuine,
            "suspicious_count": suspicious,
            "blocked_count": blocked,
            "failed_count": total - len(scored),
            "avg_risk_score": avg_risk_score,
        },
        "results": results,
    }


@app.get("/api/batch/{batch_id}")
def get_batch(batch_id: str, _actor: dict = Depends(require_role("reviewer"))):
    with db.get_connection() as conn:
        batch = db.get_batch(conn, batch_id)
        if batch is None:
            raise HTTPException(404, "No batch found for that id.")
        records = db.get_records_for_batch(conn, batch_id)
        return {
            "batch_id": batch_id,
            "created_at": batch["created_at"],
            "provider": batch["provider"],
            "summary": {
                "total_count": batch["total_count"],
                "genuine_count": batch["genuine_count"],
                "suspicious_count": batch["suspicious_count"],
                "blocked_count": batch["blocked_count"],
                "avg_risk_score": batch["avg_risk_score"],
            },
            "records": [_audio_record_to_dict(r) for r in records],
        }


@app.get("/api/batch/{batch_id}/report.csv")
def download_batch_report(batch_id: str, _actor: dict = Depends(require_role("reviewer"))):
    with db.get_connection() as conn:
        batch = db.get_batch(conn, batch_id)
        if batch is None:
            raise HTTPException(404, "No batch found for that id.")
        records = db.get_records_for_batch(conn, batch_id)

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["filename", "status", "risk_score", "voice_risk_score", "provider",
                      "duration_seconds", "size_bytes", "flagged", "analyzed_at"])
    for r in records:
        writer.writerow([
            r["filename"], r["status"], r["risk_score"], r["voice_risk_score"], r["provider"],
            r["duration_seconds"], r["size_bytes"], bool(r["flagged"]),
            time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r["created_at"])),
        ])
    writer.writerow([])
    writer.writerow(["Summary", "", "", "", "", "", "", "", ""])
    writer.writerow(["total", batch["total_count"]])
    writer.writerow(["genuine", batch["genuine_count"]])
    writer.writerow(["suspicious", batch["suspicious_count"]])
    writer.writerow(["ai_impersonation", batch["blocked_count"]])
    writer.writerow(["avg_risk_score", batch["avg_risk_score"]])

    buffer.seek(0)
    headers = {"Content-Disposition": f'attachment; filename="voiceguard-batch-{batch_id[:8]}.csv"'}
    return StreamingResponse(buffer, media_type="text/csv", headers=headers)


# --- Feature C: Trust Badge & Verification Report ---
#
# Test scenarios:
#   1. Valid analysis_id (just returned by /api/analyze) -> POST /reports
#      succeeds, returns a token, and GET /verify/{token} renders a 200
#      HTML page with matching classification/risk score.
#   2. Unknown analysis_id (typo'd or from a different server/db) ->
#      POST /reports returns 404 with a clear message; no row written.
#   3. Unknown token -> GET /verify/{token} returns a friendly 404 page,
#      not a raw FastAPI error.
#   4. Token older than REPORT_TTL_SECONDS -> GET /verify/{token} returns
#      the same friendly 404 page with an "expired" message.
#   5. Two reports generated for the same analysis_id -> two independent
#      tokens, each independently valid (reports are immutable snapshots,
#      not a single mutable "latest report" per analysis).

class ReportCreateRequest(BaseModel):
    analysis_id: str


def _build_verification_statement(record, classification_label: str, engine_label: str) -> str:
    when = time.strftime("%B %d, %Y at %H:%M UTC", time.gmtime(record["created_at"]))
    return (
        f"VoiceGuard analyzed this audio clip on {when} using the {engine_label} detection engine. "
        f"It received an Impersonation Risk Score of {record['risk_score']}/100 and was classified as "
        f"\"{classification_label}\". This statement was generated automatically by VoiceGuard AI and "
        f"reflects the result of that single analysis; it is not a guarantee about any other use of this "
        f"audio."
    )


def _build_report_evidence(record, keyword_flags: list[str], pii_flags: list[str]) -> list[dict]:
    """Build explainable, immutable signal values for the report graph.

    These are evidence indicators, not a second risk score: the final risk
    remains the detector/transcript score already stored on the analysis.
    """
    keyword_signal = min(len(keyword_flags) * KEYWORD_RISK_BOOST, KEYWORD_RISK_CAP)
    pii_signal = min(len(pii_flags) * 10, 20)
    return [
        {"key": "acoustic", "label": "Acoustic model", "value": max(0, min(100, record["voice_risk_score"] or 0)), "tone": "bad" if (record["voice_risk_score"] or 0) >= 75 else "warn" if (record["voice_risk_score"] or 0) >= 40 else "good"},
        {"key": "language", "label": "Scam-language signal", "value": keyword_signal, "tone": "bad" if keyword_signal >= 20 else "warn" if keyword_signal else "good"},
        {"key": "pii", "label": "Sensitive-info signal", "value": pii_signal, "tone": "bad" if pii_signal >= 20 else "warn" if pii_signal else "good"},
        {"key": "final", "label": "Final risk score", "value": max(0, min(100, record["risk_score"] or 0)), "tone": "bad" if (record["risk_score"] or 0) >= 75 else "warn" if (record["risk_score"] or 0) >= 40 else "good"},
    ]


def _build_action_playbook(status: str, keyword_flags: list[str], pii_flags: list[str]) -> list[dict]:
    flags = bool(keyword_flags or pii_flags)
    if status == "AI_IMPERSONATION":
        return [
            {"priority": "now", "title": "Do not approve the request", "detail": "Pause transfers, password resets, or account changes until identity is confirmed."},
            {"priority": "next", "title": "Call back through a trusted channel", "detail": "Use a saved number or an official contact page, not the number or link in the conversation."},
            {"priority": "log", "title": "Open or update a review case", "detail": "Preserve this report link and record the requested action for your fraud or security team."},
        ]
    if status == "SUSPICIOUS":
        return [
            {"priority": "now", "title": "Keep the request on hold", "detail": "Do not release funds or sensitive information while the voice remains unverified."},
            {"priority": "next", "title": "Use a second-channel challenge", "detail": "Ask for a one-time phrase or confirm the request through a known contact method."},
            {"priority": "log", "title": "Document the context", "detail": "Capture the report, caller claim, and any requested payment or account change." if flags else "Capture the report and the surrounding call context for review."},
        ]
    return [
        {"priority": "now", "title": "Confirm the request context", "detail": "A genuine-sounding voice is not proof that the request itself is legitimate."},
        {"priority": "next", "title": "Use normal approval controls", "detail": "Follow your usual callback, authorization, and transaction limits before acting."},
        {"priority": "log", "title": "Keep the verification record", "detail": "Save the report link if the decision may need to be audited later."},
    ]


@app.post("/reports")
def create_report(payload: ReportCreateRequest, _actor: dict = Depends(require_role("reviewer"))):
    with db.get_connection() as conn:
        record = db.get_audio_record(conn, payload.analysis_id)
        if record is None:
            raise HTTPException(
                404,
                "No analysis found for that id. Analyze a clip first, then generate its verification report.",
            )

        classification_label = CLASSIFICATION_LABELS.get(record["status"], record["status"] or "Unknown")
        engine_label = ENGINE_LABELS.get(record["provider"], record["provider"])
        keyword_flags = db.get_keywords_for_audio(conn, payload.analysis_id)
        try:
            pii_flags = json.loads(record["pii_matches"]) if record["pii_matches"] else []
        except (TypeError, ValueError):
            pii_flags = []
        transcript_summary = record["transcript_summary"] or ""
        evidence_breakdown = _build_report_evidence(record, keyword_flags, pii_flags)
        action_playbook = _build_action_playbook(record["status"], keyword_flags, pii_flags)

        verification_statement = _build_verification_statement(record, classification_label, engine_label)

        token, created_at = db.create_report(
            conn,
            analysis_id=payload.analysis_id,
            filename=record["filename"],
            classification=classification_label,
            risk_score=record["risk_score"],
            engine=engine_label,
            duration_seconds=record["duration_seconds"],
            transcript_summary=transcript_summary,
            keyword_flags=keyword_flags,
            pii_flags=pii_flags,
            verification_statement=verification_statement,
            evidence_breakdown=evidence_breakdown,
            action_playbook=action_playbook,
        )
        db.append_audit_event(conn, event_type="REPORT_CREATED", actor="reviewer", resource_type="report", resource_id=token, detail={"analysis_id": payload.analysis_id, "classification": classification_label, "risk_score": record["risk_score"]})

    return {
        "token": token,
        "verify_path": f"/verify/{token}",
        "analysis_id": payload.analysis_id,
        "filename": record["filename"],
        "classification": classification_label,
        "risk_score": record["risk_score"],
        "engine": engine_label,
        "duration_seconds": record["duration_seconds"],
        "transcript_summary": transcript_summary,
        "keyword_flags": keyword_flags,
        "pii_flags": pii_flags,
        "verification_statement": verification_statement,
        "evidence_breakdown": evidence_breakdown,
        "action_playbook": action_playbook,
        "created_at": created_at,
    }


def _verify_page(*, status_code: int, title: str, body_html: str) -> HTMLResponse:
    page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{html.escape(title)} — VoiceGuard verification</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@500;600&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {{
    --ink: #14121a; --ink-panel: #0e0c13; --text: #f1ece3; --muted: #9a9184;
    --line: #34303d; --action-strong: #6a79ff; --good: #4fa876; --warn: #f2b705; --bad: #e8432b;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; min-height: 100vh; background: var(--ink); color: var(--text);
    font-family: "Inter", system-ui, sans-serif; display: flex; align-items: center;
    justify-content: center; padding: 24px;
  }}
  .card {{
    max-width: 560px; width: 100%; background: var(--ink-panel); border: 1px solid var(--line);
    border-radius: 12px; padding: 32px 30px;
  }}
  h1 {{ font-family: "Fraunces", Georgia, serif; font-weight: 600; font-size: 1.5rem; margin: 0 0 14px; }}
  .badge {{
    display: inline-flex; align-items: center; gap: 6px; font-size: 0.78rem; font-weight: 600;
    letter-spacing: 0.02em; color: var(--good); border: 1px solid var(--good); border-radius: 999px;
    padding: 4px 12px; margin-bottom: 18px;
  }}
  p {{ line-height: 1.55; color: var(--muted); }}
  .facts {{ display: grid; grid-template-columns: 1fr 1fr; gap: 14px 20px; margin: 22px 0; }}
  .fact-label {{ font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); display: block; }}
  .fact-value {{ font-family: "IBM Plex Mono", monospace; font-size: 0.92rem; color: var(--text); }}
  .statement {{
    background: rgba(255,255,255,0.03); border-left: 3px solid var(--action-strong); padding: 14px 16px;
    border-radius: 6px; color: var(--text); font-size: 0.9rem;
  }}
  .evidence {{ margin: 22px 0; }}
  .evidence h2, .playbook h2 {{ font-size: 0.92rem; margin: 0 0 12px; }}
  .evidence-row {{ margin: 10px 0; }}
  .evidence-row-head {{ display:flex; justify-content:space-between; font-size:0.78rem; color:var(--muted); margin-bottom:5px; }}
  .evidence-track {{ height:8px; background:#282430; border-radius:999px; overflow:hidden; }}
  .evidence-fill {{ height:100%; border-radius:999px; background:var(--action-strong); }}
  .evidence-fill.good {{ background:var(--good); }} .evidence-fill.warn {{ background:var(--warn); }} .evidence-fill.bad {{ background:var(--bad); }}
  .public-radar {{ display:block; width:100%; max-height:240px; margin:0 auto 12px; }}
  .radar-grid {{ fill:none; stroke:var(--line); stroke-width:1; }} .radar-axis {{ stroke:var(--line); stroke-width:1; }} .radar-value {{ fill:rgba(106,121,255,.22); stroke:var(--action-strong); stroke-width:2; }} .radar-label {{ fill:var(--muted); font:500 8px monospace; }}
  .keyword-bar-row {{ margin:12px 0; }} .keyword-bar-row > div {{ display:flex; justify-content:space-between; color:var(--muted); font:500 .72rem monospace; margin-bottom:5px; }} .keyword-bar-row b {{ color:var(--text); }} .keyword-bar-track {{ display:block; height:9px; background:#282430; border-radius:99px; overflow:hidden; }} .keyword-bar-track i {{ display:block; height:100%; background:linear-gradient(90deg,var(--warn),var(--bad)); border-radius:99px; }} .visual-empty {{ color:var(--muted); font-size:.8rem; text-align:center; }}
  .playbook {{ margin-top: 22px; }} .playbook ol {{ margin:0; padding-left:22px; }} .playbook li {{ padding:7px 0 7px 4px; color:var(--text); }} .playbook small {{ display:block; color:var(--muted); margin-top:3px; line-height:1.45; }}
  .transcript {{ font-style: italic; color: var(--muted); font-size: 0.88rem; }}
  .flags {{ font-size: 0.85rem; color: var(--warn); }}
  .footer-note {{ margin-top: 26px; font-size: 0.76rem; color: var(--muted); }}
  a {{ color: var(--action-strong); }}
  @media print {{ body {{ background: #fff; color: #000; }} .card {{ border: none; }} }}
</style>
</head>
<body>
  <div class="card">
    {body_html}
  </div>
</body>
</html>"""
    return HTMLResponse(page, status_code=status_code)


@app.get("/verify/{token}", response_class=HTMLResponse)
def verify_report(token: str):
    with db.get_connection() as conn:
        report = db.get_report(conn, token)

    if report is None:
        return _verify_page(
            status_code=404,
            title="Report not found",
            body_html="""
              <h1>Verification link not found</h1>
              <p>This link doesn't match a VoiceGuard verification report. It may have been
              mistyped, or the report may never have been generated. Ask the sender to
              re-share the correct link, or generate a new report from VoiceGuard.</p>
            """,
        )

    age_seconds = time.time() - report["created_at"]
    if age_seconds > REPORT_TTL_SECONDS:
        return _verify_page(
            status_code=404,
            title="Report expired",
            body_html="""
              <h1>Verification link expired</h1>
              <p>This VoiceGuard verification report is more than 90 days old and is no longer
              available. Ask the sender to generate a fresh report for the current status of
              this clip.</p>
            """,
        )

    try:
        keyword_flags = json.loads(report["keyword_flags"] or "[]")
    except (TypeError, ValueError):
        keyword_flags = []
    try:
        pii_flags = json.loads(report["pii_flags"] or "[]")
    except (TypeError, ValueError):
        pii_flags = []
    try:
        evidence_breakdown = json.loads(report["evidence_breakdown"] or "[]")
    except (TypeError, ValueError, KeyError):
        evidence_breakdown = []
    try:
        action_playbook = json.loads(report["action_playbook"] or "[]")
    except (TypeError, ValueError, KeyError):
        action_playbook = []

    tone = {"Likely Genuine": "var(--good)", "Possibly Synthetic": "var(--warn)"}.get(
        report["classification"], "var(--bad)"
    )
    when = time.strftime("%B %d, %Y at %H:%M UTC", time.gmtime(report["created_at"]))
    flags_html = ""
    all_flags = [*keyword_flags, *pii_flags]
    if all_flags:
        pretty_flags = ", ".join(html.escape(f.replace("_", " ")) for f in all_flags)
        flags_html = f'<p class="flags">⚠ Scam / sensitive-info signals detected in the transcript: {pretty_flags}</p>'

    transcript_html = ""
    if report["transcript_summary"]:
        transcript_html = f'<p class="transcript">Transcript excerpt: "{html.escape(report["transcript_summary"])}"</p>'

    evidence_html = ""
    if evidence_breakdown:
        values = [max(0, min(100, int(item.get("value", 0)))) for item in evidence_breakdown]
        points = []
        for index, value in enumerate(values[:4]):
            angle = -math.pi / 2 + index * math.pi / 2
            points.append(f"{120 + math.cos(angle) * 72 * value / 100:.1f},{106 + math.sin(angle) * 72 * value / 100:.1f}")
        grid = "".join(f'<polygon points="{' '.join(f"{120 + math.cos(-math.pi / 2 + i * math.pi / 2) * 72 * level / 100:.1f},{106 + math.sin(-math.pi / 2 + i * math.pi / 2) * 72 * level / 100:.1f}" for i in range(4))}" class="radar-grid" />' for level in (25, 50, 75, 100))
        axes = "".join(f'<line x1="120" y1="106" x2="{120 + math.cos(-math.pi / 2 + i * math.pi / 2) * 72:.1f}" y2="{106 + math.sin(-math.pi / 2 + i * math.pi / 2) * 72:.1f}" class="radar-axis" />' for i in range(4))
        labels = "".join(f'<text x="{120 + math.cos(-math.pi / 2 + i * math.pi / 2) * 90:.1f}" y="{106 + math.sin(-math.pi / 2 + i * math.pi / 2) * 90:.1f}" class="radar-label" text-anchor="middle">{html.escape(label)}</text>' for i, label in enumerate(("Acoustic", "Language", "PII", "Final")))
        radar = f'<svg viewBox="0 0 240 220" class="public-radar" role="img" aria-label="Evidence radar chart">{grid}{axes}{labels}<polygon points="{' '.join(points)}" class="radar-value" /></svg>'
        keyword_bars = "".join(f'<div class="keyword-bar-row"><div><span>{html.escape(str(keyword).replace("_", " "))}</span><b>{max(28, 100 - index * 18)}</b></div><span class="keyword-bar-track"><i style="width:{max(28, 100 - index * 18)}%"></i></span></div>' for index, keyword in enumerate(keyword_flags)) or '<p class="visual-empty">No scam-language signals detected</p>'
        evidence_html = f'<section class="evidence"><h2>Evidence signal shape</h2>{radar}<h3>Keyword strength</h3>{keyword_bars}</section>'

    playbook_html = ""
    if action_playbook:
        steps = "".join(
            f'<li><strong>{html.escape(str(item.get("title", "Next step")))}</strong><small>{html.escape(str(item.get("detail", "")))}</small></li>'
            for item in action_playbook
        )
        playbook_html = f'<section class="playbook"><h2>Action playbook</h2><ol>{steps}</ol></section>'

    body_html = f"""
      <span class="badge" style="color:{tone}; border-color:{tone};">✓ Verified by VoiceGuard</span>
      <h1>{html.escape(report["filename"] or "Voice clip")} — verification report</h1>
      <div class="facts">
        <div><span class="fact-label">Classification</span><span class="fact-value" style="color:{tone};">{html.escape(report["classification"])}</span></div>
        <div><span class="fact-label">Impersonation Risk Score</span><span class="fact-value">{report["risk_score"]}/100</span></div>
        <div><span class="fact-label">Detection engine</span><span class="fact-value">{html.escape(report["engine"])}</span></div>
        <div><span class="fact-label">Generated</span><span class="fact-value">{when}</span></div>
      </div>
      {transcript_html}
      {flags_html}
      {evidence_html}
      {playbook_html}
      <p class="statement">{html.escape(report["verification_statement"])}</p>
      <p class="footer-note">Report id: {html.escape(token)} · VoiceGuard never stores the original audio — only this analysis summary.</p>
    """
    return _verify_page(status_code=200, title=f"Verification report — {report['classification']}", body_html=body_html)


# --- Feature D: Risk Trends & Analytics Dashboard ---
#
# Test scenarios:
#   1. Empty database -> GET /analytics/summary returns total_analyses: 0
#      and empty/-null structures without erroring (exercised directly by
#      db.get_analytics_summary's own docstring scenarios).
#   2. After a handful of single-clip analyses across GENUINE/SUSPICIOUS/
#      AI_IMPERSONATION -> classification_distribution reflects the exact
#      counts and its values sum to total_analyses.
#   3. After a batch run -> total_analyses includes every batch item,
#      since batch items are persisted the same way as single analyses.
#   4. A clip whose transcript matches multiple scam phrases -> each
#      phrase appears once in top_scam_keywords, not stacked into a
#      single combined string.
#   5. Data seeded across several distinct days -> daily_trend has one
#      entry per day with analyses, in ascending date order.

@app.get("/analytics/summary")
def analytics_summary(_actor: dict = Depends(require_role("analyst"))):
    with db.get_connection() as conn:
        return db.get_analytics_summary(conn)


def _audit_event_to_dict(row) -> dict:
    return {"id": row["id"], "created_at": row["created_at"], "event_type": row["event_type"], "actor": row["actor"], "resource_type": row["resource_type"], "resource_id": row["resource_id"], "detail": row["detail"], "event_hash": row["event_hash"]}


@app.get("/api/security/audit")
def security_audit(limit: int = 50, _actor: dict = Depends(require_role("analyst"))):
    if limit < 1 or limit > 200:
        raise HTTPException(400, "limit must be between 1 and 200.")
    with db.get_connection() as conn:
        return {"events": [_audit_event_to_dict(row) for row in db.list_audit_events(conn, limit=limit)], "integrity": db.verify_audit_chain(conn)}


@app.get("/api/security/audit/verify")
def verify_security_audit(_actor: dict = Depends(require_role("analyst"))):
    with db.get_connection() as conn:
        return db.verify_audit_chain(conn)


SAFETY_STATUSES = {"OPEN", "PAUSED", "COMPLETED", "ESCALATED"}
SAFETY_TASK_IDS = {"pause", "verify", "document"}


class SafetySessionCreate(BaseModel):
    audio_id: str


class SafetySessionUpdate(BaseModel):
    task_id: str | None = None
    completed: bool | None = None
    status: str | None = None
    customer_note: str | None = None


def _safety_tasks_for(record) -> list[dict]:
    high_risk = record["status"] == "AI_IMPERSONATION" or (record["risk_score"] or 0) >= 75
    return [
        {"id": "pause", "title": "Pause the requested action", "detail": "Do not send money, codes, passwords, or personal information until you finish this check.", "completed": False},
        {"id": "verify", "title": "Verify through a trusted channel", "detail": "Call a saved number or use an official app/site. Never use contact details from the suspicious message.", "completed": False},
        {"id": "document", "title": "Save the decision record", "detail": "Keep the verification link and note what the caller asked you to do." if high_risk else "Keep the verification link if this decision may need to be reviewed later.", "completed": False},
    ]


def _safety_session_to_dict(row) -> dict:
    try:
        tasks = json.loads(row["tasks"] or "[]")
    except (TypeError, ValueError):
        tasks = []
    return {"id": row["id"], "audio_id": row["audio_id"], "created_at": row["created_at"], "updated_at": row["updated_at"], "status": row["status"], "customer_note": row["customer_note"], "tasks": tasks}


@app.post("/api/safety-sessions")
def create_safety_session(payload: SafetySessionCreate, _actor: dict = Depends(require_role("reviewer"))):
    with db.get_connection() as conn:
        record = db.get_audio_record(conn, payload.audio_id)
        if record is None:
            raise HTTPException(404, "Analyze this clip before starting a safety session.")
        existing = db.get_safety_session(conn, payload.audio_id)
        if existing is not None:
            return _safety_session_to_dict(existing)
        session_id = db.create_safety_session(conn, audio_id=payload.audio_id, tasks=_safety_tasks_for(record))
        db.append_audit_event(conn, event_type="SAFETY_SESSION_CREATED", actor="customer", resource_type="safety_session", resource_id=session_id, detail={"audio_id": payload.audio_id})
        return _safety_session_to_dict(db.get_safety_session(conn, payload.audio_id))


@app.get("/api/safety-sessions/{audio_id}")
def get_safety_session(audio_id: str, _actor: dict = Depends(require_role("reviewer"))):
    with db.get_connection() as conn:
        row = db.get_safety_session(conn, audio_id)
        if row is None:
            raise HTTPException(404, "No safety session exists for this analysis.")
        return _safety_session_to_dict(row)


@app.patch("/api/safety-sessions/{audio_id}")
def update_safety_session(audio_id: str, payload: SafetySessionUpdate, _actor: dict = Depends(require_role("reviewer"))):
    with db.get_connection() as conn:
        row = db.get_safety_session(conn, audio_id)
        if row is None:
            raise HTTPException(404, "No safety session exists for this analysis.")
        session = _safety_session_to_dict(row)
        if payload.task_id is not None:
            if payload.task_id not in SAFETY_TASK_IDS:
                raise HTTPException(400, "Unknown safety task.")
            for task in session["tasks"]:
                if task["id"] == payload.task_id:
                    task["completed"] = bool(payload.completed)
        status = payload.status or session["status"]
        if status not in SAFETY_STATUSES:
            raise HTTPException(400, "Invalid safety session status.")
        note = payload.customer_note if payload.customer_note is not None else session["customer_note"]
        if len(note) > 1000:
            raise HTTPException(400, "Customer note must be 1000 characters or fewer.")
        if payload.status is None and all(task.get("completed") for task in session["tasks"]):
            status = "COMPLETED"
        db.update_safety_session(conn, audio_id, status=status, tasks=session["tasks"], customer_note=note)
        db.append_audit_event(conn, event_type="SAFETY_SESSION_UPDATED", actor="customer", resource_type="safety_session", resource_id=session["id"], detail={"audio_id": audio_id, "status": status, "task_id": payload.task_id})
        return _safety_session_to_dict(db.get_safety_session(conn, audio_id))



class Feedback(BaseModel):
    filename: str
    risk_score: int
    status: str
    correct: bool
    comment: str | None = None


@app.post("/api/feedback")
async def submit_feedback(feedback: Feedback):
    entry = feedback.model_dump()
    entry["submitted_at"] = time.time()
    try:
        with FEEDBACK_LOG_PATH.open("a", encoding="utf-8") as log_file:
            log_file.write(json.dumps(entry) + "\n")
    except OSError as exc:
        logger.exception("Could not write feedback")
        raise HTTPException(500, f"Could not save feedback: {exc}") from exc

    return {"saved": True}


# Serve static frontend assets from repository root
_FRONTEND_DIR = Path(__file__).resolve().parent.parent

if (_FRONTEND_DIR / "index.html").exists():
    @app.get("/", include_in_schema=False)
    def serve_index():
        return FileResponse(_FRONTEND_DIR / "index.html")

    app.mount("/", StaticFiles(directory=_FRONTEND_DIR, html=True), name="static")

