"""Lightweight SQLite persistence for VoiceGuard.

The app previously stored nothing at all (see the footer note in
index.html: "audio isn't stored"). Several features need durable state:

  * Feature A - Clip History & Verification Log: metadata + an event log
    per analyzed clip.
  * Feature B - Bulk Scan: per-batch job records and aggregate stats.
  * Feature C - Trust Badge & Verification Report: shareable, tokenized
    snapshots of a single analysis that a third party can look up without
    any authentication.
  * Feature D - Risk Trends & Analytics Dashboard: aggregate stats
    (classification mix, average risk over time, most common scam
    phrases) computed with SQL over everything analyzed so far.

No ORM (Prisma/SQLAlchemy/etc.) was already in use, so this adds a thin
module around the stdlib `sqlite3` rather than pulling in a new
dependency for what is a handful of tables. The DB file lives next to
the backend code and is created automatically on first run.

Design note on privacy: VoiceGuard's stated position is that raw audio
is never persisted. To keep that promise while still giving "same clip
re-analyzed / re-uploaded" history, a report's evidence trail, and
scam-keyword analytics, we never store audio bytes here - only a
SHA-256 `content_hash` of the bytes, a short (280-char) transcript
excerpt, and which scam phrases / PII categories were detected. The
full transcript itself is never persisted, only the excerpt used for
the human-readable verification report.

Migrations: this module targets a database that may already exist from
before Features C and D were added. `init_db()` always (a) creates any
brand-new tables via `CREATE TABLE IF NOT EXISTS`, so a fresh install
gets the full schema, and (b) runs `_upgrade_schema()`, which adds any
columns that a pre-existing `voiceguard.db` is missing via `ALTER TABLE
... ADD COLUMN`, guarded by a check against `PRAGMA table_info`, so it's
safe to run on every startup. There is no separate "migration file" to
run by hand - `init_db()` is the migration.
"""

from __future__ import annotations

import json
import hashlib
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

DB_PATH = Path(__file__).parent / "voiceguard.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS audio_records (
    id                TEXT PRIMARY KEY,
    content_hash      TEXT NOT NULL,
    filename          TEXT,
    source_type       TEXT NOT NULL,      -- 'recorded' | 'uploaded'
    format            TEXT,
    size_bytes        INTEGER,
    duration_seconds  REAL,
    created_at        REAL NOT NULL,
    provider          TEXT NOT NULL,      -- 'local' | 'hive'
    model_version     TEXT,
    risk_score        INTEGER,
    voice_risk_score  INTEGER,
    status            TEXT,               -- GENUINE | SUSPICIOUS | AI_IMPERSONATION
    flagged           INTEGER NOT NULL DEFAULT 0,
    batch_id          TEXT,
    transcript_summary TEXT,              -- short excerpt only, never the raw audio
    pii_matches       TEXT                -- JSON list of PII category labels
);

CREATE INDEX IF NOT EXISTS idx_audio_records_hash ON audio_records(content_hash);
CREATE INDEX IF NOT EXISTS idx_audio_records_batch ON audio_records(batch_id);
CREATE INDEX IF NOT EXISTS idx_audio_records_created_at ON audio_records(created_at);
CREATE INDEX IF NOT EXISTS idx_audio_records_status ON audio_records(status);

CREATE TABLE IF NOT EXISTS audio_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id     TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    event_type   TEXT NOT NULL,          -- created | re_analyzed | re_uploaded | flagged | unflagged
    detail       TEXT,
    created_at   REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audio_events_hash ON audio_events(content_hash);

CREATE TABLE IF NOT EXISTS batches (
    id                TEXT PRIMARY KEY,
    created_at        REAL NOT NULL,
    provider          TEXT NOT NULL,
    total_count       INTEGER NOT NULL,
    genuine_count     INTEGER NOT NULL,
    suspicious_count  INTEGER NOT NULL,
    blocked_count     INTEGER NOT NULL,
    avg_risk_score    REAL
);

-- Feature D: one row per (audio_id, scam keyword) match. Normalized out of
-- audio_records so /analytics/summary can do a plain SQL GROUP BY instead
-- of parsing JSON in Python for every row.
CREATE TABLE IF NOT EXISTS audio_keyword_hits (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_id   TEXT NOT NULL,
    keyword    TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_keyword_hits_audio ON audio_keyword_hits(audio_id);
CREATE INDEX IF NOT EXISTS idx_keyword_hits_keyword ON audio_keyword_hits(keyword);

-- Feature C: a report is an immutable snapshot of one analysis at the
-- moment "Generate Verification Report" was clicked, addressed by an
-- unguessable token (see new_token()) rather than the analysis id, so
-- the public /verify/{token} page can't be used to enumerate every
-- analysis the server has ever run.
CREATE TABLE IF NOT EXISTS reports (
    token                  TEXT PRIMARY KEY,
    analysis_id            TEXT NOT NULL,
    created_at             REAL NOT NULL,
    filename               TEXT,
    classification         TEXT NOT NULL,   -- display label, e.g. "Likely Genuine"
    risk_score             INTEGER NOT NULL,
    engine                 TEXT NOT NULL,   -- display label, e.g. "Local model (Spectra-AASIST3)"
    duration_seconds       REAL,
    transcript_summary     TEXT,
    keyword_flags          TEXT,            -- JSON list of matched scam phrases
    pii_flags              TEXT,            -- JSON list of matched PII category labels
    verification_statement TEXT NOT NULL,
    evidence_breakdown     TEXT,            -- JSON list of graph signal objects
    action_playbook        TEXT             -- JSON list of recommended next steps
);

CREATE INDEX IF NOT EXISTS idx_reports_analysis ON reports(analysis_id);

-- Feature E: server-backed review queue and incident cases.
CREATE TABLE IF NOT EXISTS review_cases (
    id             TEXT PRIMARY KEY,
    audio_id       TEXT NOT NULL,
    created_at     REAL NOT NULL,
    updated_at     REAL NOT NULL,
    status         TEXT NOT NULL,
    priority       TEXT NOT NULL,
    title          TEXT NOT NULL,
    resolution     TEXT,
    FOREIGN KEY(audio_id) REFERENCES audio_records(id)
);

CREATE INDEX IF NOT EXISTS idx_review_cases_status ON review_cases(status);
CREATE INDEX IF NOT EXISTS idx_review_cases_priority ON review_cases(priority);
CREATE INDEX IF NOT EXISTS idx_review_cases_audio ON review_cases(audio_id);

CREATE TABLE IF NOT EXISTS case_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id    TEXT NOT NULL,
    note       TEXT NOT NULL,
    created_at REAL NOT NULL,
    FOREIGN KEY(case_id) REFERENCES review_cases(id)
);

CREATE INDEX IF NOT EXISTS idx_case_notes_case ON case_notes(case_id);

-- Feature I: customer-facing safety action sessions.
CREATE TABLE IF NOT EXISTS safety_sessions (
    id           TEXT PRIMARY KEY,
    audio_id     TEXT NOT NULL UNIQUE,
    created_at   REAL NOT NULL,
    updated_at   REAL NOT NULL,
    status       TEXT NOT NULL,
    customer_note TEXT NOT NULL DEFAULT '',
    tasks        TEXT NOT NULL,
    FOREIGN KEY(audio_id) REFERENCES audio_records(id)
);

CREATE INDEX IF NOT EXISTS idx_safety_sessions_audio ON safety_sessions(audio_id);

-- Feature J: tamper-evident security audit trail.
CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    REAL NOT NULL,
    event_type    TEXT NOT NULL,
    actor         TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id   TEXT NOT NULL,
    detail        TEXT NOT NULL,
    previous_hash TEXT NOT NULL,
    event_hash    TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id);

CREATE TABLE IF NOT EXISTS api_keys (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash   TEXT NOT NULL UNIQUE,
    role       TEXT NOT NULL CHECK (role IN ('reviewer', 'analyst')),
    label      TEXT NOT NULL,
    created_at REAL NOT NULL,
    revoked_at REAL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_role ON api_keys(role);

CREATE TABLE IF NOT EXISTS voice_enrollments (
    customer_id TEXT PRIMARY KEY,
    embedding   TEXT NOT NULL,
    format      TEXT NOT NULL,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);
"""


def _column_names(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _upgrade_schema(conn: sqlite3.Connection) -> None:
    """Adds columns that a pre-existing voiceguard.db (created before
    Features C/D existed) is missing. Safe to call on every startup:
    each ALTER TABLE is guarded by a check against PRAGMA table_info, so
    it's a no-op once the column is already there."""
    audio_columns = _column_names(conn, "audio_records")
    if "transcript_summary" not in audio_columns:
        conn.execute("ALTER TABLE audio_records ADD COLUMN transcript_summary TEXT")
    if "pii_matches" not in audio_columns:
        conn.execute("ALTER TABLE audio_records ADD COLUMN pii_matches TEXT")
    report_columns = _column_names(conn, "reports")
    if "evidence_breakdown" not in report_columns:
        conn.execute("ALTER TABLE reports ADD COLUMN evidence_breakdown TEXT")
    if "action_playbook" not in report_columns:
        conn.execute("ALTER TABLE reports ADD COLUMN action_playbook TEXT")


def init_db() -> None:
    with get_connection() as conn:
        conn.executescript(SCHEMA)
        _upgrade_schema(conn)


@contextmanager
def get_connection() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def new_id() -> str:
    return uuid.uuid4().hex


def new_token() -> str:
    """Unguessable token for public verification links - longer and from
    a CSPRNG (unlike new_id()'s uuid4, which is fine for internal primary
    keys but not intended as a security boundary)."""
    return secrets.token_urlsafe(24)


def hash_api_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


def create_api_key(conn: sqlite3.Connection, *, key_hash: str, role: str, label: str) -> int:
    cursor = conn.execute(
        "INSERT INTO api_keys (key_hash, role, label, created_at) VALUES (?, ?, ?, ?)",
        (key_hash, role, label, time.time()),
    )
    return int(cursor.lastrowid)


def upsert_voice_enrollment(conn: sqlite3.Connection, *, customer_id: str, embedding: str, format: str) -> tuple[float, float]:
    now = time.time()
    existing = conn.execute("SELECT created_at FROM voice_enrollments WHERE customer_id = ?", (customer_id,)).fetchone()
    created_at = existing["created_at"] if existing else now
    conn.execute(
        """INSERT INTO voice_enrollments (customer_id, embedding, format, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(customer_id) DO UPDATE SET embedding=excluded.embedding, format=excluded.format, updated_at=excluded.updated_at""",
        (customer_id, embedding, format, created_at, now),
    )
    return created_at, now


def get_voice_enrollment(conn: sqlite3.Connection, customer_id: str) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM voice_enrollments WHERE customer_id = ?", (customer_id,)).fetchone()


def find_prior_event_for_hash(conn: sqlite3.Connection, content_hash: str) -> Optional[sqlite3.Row]:
    """Returns the most recent event for this content hash, if any, so a
    fresh analysis of already-seen audio can be logged as a re-analysis
    (or re-upload) instead of a brand-new clip."""
    return conn.execute(
        "SELECT * FROM audio_events WHERE content_hash = ? ORDER BY created_at DESC LIMIT 1",
        (content_hash,),
    ).fetchone()


def create_audio_record(
    conn: sqlite3.Connection,
    *,
    content_hash: str,
    filename: str,
    source_type: str,
    format: str | None,
    size_bytes: int,
    duration_seconds: float | None,
    provider: str,
    model_version: str,
    risk_score: int,
    voice_risk_score: int,
    status: str,
    batch_id: str | None = None,
    transcript_summary: str | None = None,
    pii_matches: list[str] | None = None,
    matched_keywords: list[str] | None = None,
) -> str:
    audio_id = new_id()
    conn.execute(
        """INSERT INTO audio_records
           (id, content_hash, filename, source_type, format, size_bytes, duration_seconds,
            created_at, provider, model_version, risk_score, voice_risk_score, status,
            flagged, batch_id, transcript_summary, pii_matches)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)""",
        (
            audio_id, content_hash, filename, source_type, format, size_bytes, duration_seconds,
            time.time(), provider, model_version, risk_score, voice_risk_score, status, batch_id,
            transcript_summary or "", json.dumps(pii_matches or []),
        ),
    )
    # Feature D: normalize each matched scam phrase into its own row so
    # /analytics/summary's top_scam_keywords can GROUP BY in SQL.
    now = time.time()
    for keyword in matched_keywords or []:
        conn.execute(
            "INSERT INTO audio_keyword_hits (audio_id, keyword, created_at) VALUES (?, ?, ?)",
            (audio_id, keyword, now),
        )
    return audio_id


def add_event(
    conn: sqlite3.Connection,
    *,
    audio_id: str,
    content_hash: str,
    event_type: str,
    detail: str = "",
) -> None:
    conn.execute(
        "INSERT INTO audio_events (audio_id, content_hash, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?)",
        (audio_id, content_hash, event_type, detail, time.time()),
    )


def get_audio_record(conn: sqlite3.Connection, audio_id: str) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM audio_records WHERE id = ?", (audio_id,)).fetchone()


def get_events_for_hash(conn: sqlite3.Connection, content_hash: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM audio_events WHERE content_hash = ? ORDER BY created_at ASC",
        (content_hash,),
    ).fetchall()


def set_flagged(conn: sqlite3.Connection, audio_id: str, flagged: bool) -> None:
    conn.execute("UPDATE audio_records SET flagged = ? WHERE id = ?", (1 if flagged else 0, audio_id))


def get_keywords_for_audio(conn: sqlite3.Connection, audio_id: str) -> list[str]:
    rows = conn.execute(
        "SELECT keyword FROM audio_keyword_hits WHERE audio_id = ? ORDER BY id ASC", (audio_id,)
    ).fetchall()
    return [r["keyword"] for r in rows]


# --- Feature E: Review queue and incident cases ---
def _review_case_select() -> str:
    return """SELECT rc.*, ar.filename, ar.risk_score, ar.voice_risk_score,
                     ar.status AS audio_status, ar.provider, ar.model_version,
                     ar.created_at AS analyzed_at, ar.flagged
              FROM review_cases rc
              JOIN audio_records ar ON ar.id = rc.audio_id"""


def list_review_cases(conn: sqlite3.Connection, *, status: str | None = None, limit: int = 100) -> list[sqlite3.Row]:
    query = _review_case_select()
    params: list[object] = []
    if status:
        query += " WHERE rc.status = ?"
        params.append(status)
    query += " ORDER BY CASE rc.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, rc.updated_at DESC LIMIT ?"
    params.append(limit)
    return conn.execute(query, params).fetchall()


def get_review_case(conn: sqlite3.Connection, case_id: str) -> Optional[sqlite3.Row]:
    return conn.execute(_review_case_select() + " WHERE rc.id = ?", (case_id,)).fetchone()


def get_open_case_for_audio(conn: sqlite3.Connection, audio_id: str) -> Optional[sqlite3.Row]:
    return conn.execute(_review_case_select() + " WHERE rc.audio_id = ? AND rc.status IN ('OPEN', 'IN_REVIEW') ORDER BY rc.updated_at DESC LIMIT 1", (audio_id,)).fetchone()


def create_review_case(conn: sqlite3.Connection, *, audio_id: str, title: str, priority: str) -> str:
    case_id = new_id()
    now = time.time()
    conn.execute("INSERT INTO review_cases (id, audio_id, created_at, updated_at, status, priority, title, resolution) VALUES (?, ?, ?, ?, 'OPEN', ?, ?, '')", (case_id, audio_id, now, now, priority, title))
    return case_id


def update_review_case(conn: sqlite3.Connection, *, case_id: str, status: str, priority: str, title: str, resolution: str) -> None:
    conn.execute("UPDATE review_cases SET updated_at = ?, status = ?, priority = ?, title = ?, resolution = ? WHERE id = ?", (time.time(), status, priority, title, resolution, case_id))


def get_case_notes(conn: sqlite3.Connection, case_id: str) -> list[sqlite3.Row]:
    return conn.execute("SELECT id, case_id, note, created_at FROM case_notes WHERE case_id = ? ORDER BY created_at DESC, id DESC", (case_id,)).fetchall()


def add_case_note(conn: sqlite3.Connection, *, case_id: str, note: str) -> int:
    cursor = conn.execute("INSERT INTO case_notes (case_id, note, created_at) VALUES (?, ?, ?)", (case_id, note, time.time()))
    conn.execute("UPDATE review_cases SET updated_at = ? WHERE id = ?", (time.time(), case_id))
    return int(cursor.lastrowid)


# --- Feature I: Customer Safety Action Center ---
def get_safety_session(conn: sqlite3.Connection, audio_id: str) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM safety_sessions WHERE audio_id = ?", (audio_id,)).fetchone()


def create_safety_session(conn: sqlite3.Connection, *, audio_id: str, tasks: list[dict]) -> str:
    session_id = new_id()
    now = time.time()
    conn.execute(
        """INSERT INTO safety_sessions
           (id, audio_id, created_at, updated_at, status, customer_note, tasks)
           VALUES (?, ?, ?, ?, 'OPEN', '', ?)""",
        (session_id, audio_id, now, now, json.dumps(tasks)),
    )
    return session_id


def update_safety_session(conn: sqlite3.Connection, audio_id: str, *, status: str, tasks: list[dict], customer_note: str) -> None:
    conn.execute(
        """UPDATE safety_sessions SET updated_at = ?, status = ?, tasks = ?, customer_note = ?
           WHERE audio_id = ?""",
        (time.time(), status, json.dumps(tasks), customer_note, audio_id),
    )


# --- Feature J: Tamper-evident Security Audit Trail ---
def append_audit_event(conn: sqlite3.Connection, *, event_type: str, actor: str, resource_type: str, resource_id: str, detail: dict | str) -> dict:
    created_at = time.time()
    detail_text = detail if isinstance(detail, str) else json.dumps(detail, sort_keys=True, separators=(",", ":"))
    previous = conn.execute("SELECT event_hash FROM audit_log ORDER BY id DESC LIMIT 1").fetchone()
    previous_hash = previous["event_hash"] if previous else "GENESIS"
    canonical = json.dumps({"created_at": created_at, "event_type": event_type, "actor": actor, "resource_type": resource_type, "resource_id": resource_id, "detail": detail_text, "previous_hash": previous_hash}, sort_keys=True, separators=(",", ":"))
    event_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    conn.execute("INSERT INTO audit_log (created_at, event_type, actor, resource_type, resource_id, detail, previous_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (created_at, event_type, actor, resource_type, resource_id, detail_text, previous_hash, event_hash))
    return {"created_at": created_at, "event_type": event_type, "actor": actor, "resource_type": resource_type, "resource_id": resource_id, "detail": detail_text, "previous_hash": previous_hash, "event_hash": event_hash}


def list_audit_events(conn: sqlite3.Connection, *, limit: int = 100) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()


def verify_audit_chain(conn: sqlite3.Connection) -> dict:
    rows = conn.execute("SELECT * FROM audit_log ORDER BY id ASC").fetchall()
    previous_hash = "GENESIS"
    for row in rows:
        canonical = json.dumps({"created_at": row["created_at"], "event_type": row["event_type"], "actor": row["actor"], "resource_type": row["resource_type"], "resource_id": row["resource_id"], "detail": row["detail"], "previous_hash": row["previous_hash"]}, sort_keys=True, separators=(",", ":"))
        expected = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        if row["previous_hash"] != previous_hash or row["event_hash"] != expected:
            return {"valid": False, "event_count": len(rows), "broken_event_id": row["id"]}
        previous_hash = row["event_hash"]
    return {"valid": True, "event_count": len(rows), "latest_hash": previous_hash if rows else "GENESIS"}


def create_batch(
    conn: sqlite3.Connection,
    *,
    provider: str,
    total_count: int,
    genuine_count: int,
    suspicious_count: int,
    blocked_count: int,
    avg_risk_score: float,
) -> str:
    batch_id = new_id()
    conn.execute(
        """INSERT INTO batches
           (id, created_at, provider, total_count, genuine_count, suspicious_count, blocked_count, avg_risk_score)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (batch_id, time.time(), provider, total_count, genuine_count, suspicious_count, blocked_count, avg_risk_score),
    )
    return batch_id


def get_batch(conn: sqlite3.Connection, batch_id: str) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()


def get_records_for_batch(conn: sqlite3.Connection, batch_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM audio_records WHERE batch_id = ? ORDER BY created_at ASC", (batch_id,)
    ).fetchall()


# --- Feature C: Trust Badge & Verification Report ---

def create_report(
    conn: sqlite3.Connection,
    *,
    analysis_id: str,
    filename: str | None,
    classification: str,
    risk_score: int,
    engine: str,
    duration_seconds: float | None,
    transcript_summary: str,
    keyword_flags: list[str],
    pii_flags: list[str],
    verification_statement: str,
    evidence_breakdown: list[dict] | None = None,
    action_playbook: list[dict] | None = None,
) -> tuple[str, float]:
    """Creates an immutable report snapshot and returns (token, created_at)."""
    token = new_token()
    created_at = time.time()
    conn.execute(
        """INSERT INTO reports
           (token, analysis_id, created_at, filename, classification, risk_score, engine,
            duration_seconds, transcript_summary, keyword_flags, pii_flags, verification_statement,
            evidence_breakdown, action_playbook)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            token, analysis_id, created_at, filename, classification, risk_score, engine,
            duration_seconds, transcript_summary, json.dumps(keyword_flags), json.dumps(pii_flags),
            verification_statement, json.dumps(evidence_breakdown or []), json.dumps(action_playbook or []),
        ),
    )
    return token, created_at


def get_report(conn: sqlite3.Connection, token: str) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM reports WHERE token = ?", (token,)).fetchone()


# --- Feature D: Risk Trends & Analytics Dashboard ---

def get_analytics_summary(conn: sqlite3.Connection) -> dict:
    """Pure SQL aggregation over audio_records / audio_keyword_hits - no
    raw audio, and no per-row Python looping for the headline numbers.

    Test scenarios (see also main.py's /analytics/summary docstring):
      1. Empty database (no analyses yet) -> total_analyses == 0,
         classification_distribution == {}, every avg_risk_score is
         None, top_scam_keywords == [], daily_trend == [].
      2. Single analysis -> counts of 1, avg == that one risk_score,
         last_7d/last_30d == overall (it's within both windows).
      3. Multi-day data spanning >30 days -> last_30d excludes rows
         older than 30 days while `overall` still includes them.
      4. Several clips sharing a scam phrase -> that phrase's count in
         top_scam_keywords reflects one row per audio_id (not per
         repeated mention within a single transcript - scan_keywords()
         already dedupes per clip before it reaches this table).
      5. A batch run mixing GENUINE/SUSPICIOUS/AI_IMPERSONATION ->
         classification_distribution keys/values sum to total_analyses.
    """
    now = time.time()
    total_row = conn.execute("SELECT COUNT(*) AS c FROM audio_records").fetchone()
    total_analyses = total_row["c"] if total_row else 0

    dist_rows = conn.execute(
        "SELECT status, COUNT(*) AS c FROM audio_records WHERE status IS NOT NULL GROUP BY status"
    ).fetchall()
    classification_distribution = {row["status"]: row["c"] for row in dist_rows}

    def avg_risk_since(cutoff: float | None) -> float | None:
        if cutoff is None:
            row = conn.execute("SELECT AVG(risk_score) AS a FROM audio_records").fetchone()
        else:
            row = conn.execute(
                "SELECT AVG(risk_score) AS a FROM audio_records WHERE created_at >= ?", (cutoff,)
            ).fetchone()
        return round(row["a"], 1) if row and row["a"] is not None else None

    avg_risk_score = {
        "overall": avg_risk_since(None),
        "last_7d": avg_risk_since(now - 7 * 86400),
        "last_30d": avg_risk_since(now - 30 * 86400),
    }

    keyword_rows = conn.execute(
        """SELECT keyword, COUNT(*) AS c FROM audio_keyword_hits
           GROUP BY keyword ORDER BY c DESC, keyword ASC LIMIT 10"""
    ).fetchall()
    top_scam_keywords = [{"keyword": r["keyword"], "count": r["c"]} for r in keyword_rows]

    # Daily trend for the last 14 days, bucketed by local calendar day, so
    # the dashboard's chart has something meaningful to draw even for a
    # short-lived dev database. Days with zero analyses simply don't
    # appear in the result - the frontend fills the gaps when it draws.
    trend_rows = conn.execute(
        """SELECT CAST(created_at / 86400 AS INTEGER) AS day_bucket,
                  AVG(risk_score) AS avg_score, COUNT(*) AS c
           FROM audio_records
           WHERE created_at >= ?
           GROUP BY day_bucket
           ORDER BY day_bucket ASC""",
        (now - 14 * 86400,),
    ).fetchall()
    daily_trend = [
        {
            "date": time.strftime("%Y-%m-%d", time.localtime(row["day_bucket"] * 86400)),
            "avg_risk_score": round(row["avg_score"], 1) if row["avg_score"] is not None else 0,
            "count": row["c"],
        }
        for row in trend_rows
    ]

    return {
        "total_analyses": total_analyses,
        "classification_distribution": classification_distribution,
        "avg_risk_score": avg_risk_score,
        "top_scam_keywords": top_scam_keywords,
        "daily_trend": daily_trend,
    }
