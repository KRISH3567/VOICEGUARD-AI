# What's new

Two features added on top of the existing VoiceGuard app. Nothing existing
was removed — recording, upload, local/Hive analysis, live call monitor,
and feedback logging all still work exactly as before.

## 1. Audio Provenance & Edit History

**Update:** this is now implemented entirely client-side (see note below on
why), and shown as an inline panel in the page instead of a modal popup.

- Every successful analysis (single clip or a batch item) is logged to the
  browser's own `localStorage`, keyed by a SHA-256 hash of the audio bytes
  (computed in-browser with `crypto.subtle.digest`, the same idea as a
  content hash — nothing about the audio itself is stored, only metadata).
  Re-uploading or re-analyzing the same clip appends to that clip's
  existing history instead of starting a new one, the same way the backend
  version did.
- Each record tracks: source (recorded/uploaded), format, duration, size,
  detection engine + model version, risk score, flagged state, and a full
  event log (`created`, `re_uploaded`, `re_analyzed`, `flagged`,
  `unflagged`) with timestamps.
- Frontend (`script.js`, `#provenance-panel` in `index.html`): a
  "Clip History & Verification Log" link and a flag toggle appear on the verdict card
  after analyzing. Clicking the link opens an **inline panel** right below
  the card — a normal part of the page, not an overlay/modal and not a
  toast/notification — showing the facts and a reverse-chronological
  timeline. The same panel is reused by the batch results table's "View
  history" button, which scrolls it into view.
- The backend's `db.py` module and its `/api/audio/{id}/provenance` /
  `/api/audio/{id}/flag` endpoints are still present and still get written
  to during `/api/analyze` and `/api/batch-analyze` — they're just no
  longer what the frontend reads from, so the feature works the same way
  whether or not that part of the backend is deployed/reachable. A future
  pass could sync the two (e.g. use the local log as an optimistic cache
  and reconcile with the server copy) if a shared/server-backed history
  across browsers and devices becomes a requirement.

## 2. Batch Analysis & Summary Report

- `POST /api/batch-analyze` — accepts up to 20 files at once, runs each
  through the same analysis path as the single-file endpoint (refactored
  into a shared `run_full_analysis()` so the two can't drift apart), and
  returns per-file results plus aggregate stats (counts by verdict, average
  risk score).
- `GET /api/batch/{id}` and `GET /api/batch/{id}/report.csv` — look up a
  batch's results, or download them as CSV.
- Frontend: a new "Bulk Scan" section (bottom of the page) with a
  drag-and-drop multi-file zone, a progress indicator, a results table
  (with a per-row link into that clip's history & verification log), and a
  "Download summary report (CSV)" button.

## 3. Trust Badge & Verification Report

- `POST /reports` (`backend/main.py`) — takes `{ "analysis_id": "..." }`
  (the `audio_id` returned by `/api/analyze` / `/api/batch-analyze`), looks
  up that clip's DB record, and writes an **immutable snapshot** — risk
  score, classification, engine, a short transcript excerpt, matched scam
  keywords/PII flags, and a generated verification statement — into a new
  `reports` table, addressed by an unguessable token
  (`secrets.token_urlsafe`, not the analysis id, so the public page can't
  be used to enumerate every analysis on the server).
- `GET /verify/{token}` — a self-contained, styled public HTML page (no
  auth, no dependency on the frontend's `style.css`) showing the
  verification statement, metrics, and a "Verified by VoiceGuard" badge.
  Returns a friendly 404 page (not a raw FastAPI error) for an unknown
  token or one older than the 90-day TTL.
- Frontend: a "Generate Verification Report" button on the verdict card
  and on each row of the Bulk Scan results table. Clicking it calls
  `POST /reports` and opens the inline `#verification-report-panel` in
  `index.html` with the summary, a "Copy verification link" button, an
  "Open public page" link, a "Print / save as PDF" button, and the
  verified badge.
- No raw audio is ever stored for this — only a ≤280-character transcript
  excerpt (see `TRANSCRIPT_SUMMARY_MAX_CHARS` in `main.py`) and which scam
  phrases / PII categories were detected.

## 4. Risk Trends & Analytics Dashboard

- `GET /analytics/summary` (`backend/main.py` -> `db.get_analytics_summary`)
  — pure SQL aggregation over `audio_records` / a new normalized
  `audio_keyword_hits` table: `total_analyses`, `classification_distribution`,
  `avg_risk_score` (overall / last 7 days / last 30 days), `top_scam_keywords`
  (top 10, via `GROUP BY`), and a 14-day `daily_trend` for the chart.
- `analytics.html` + `analytics.js` — a new page (linked from the main
  page's header) with metric cards (total checks, % suspicious/blocked,
  average Impersonation Risk Score with 7d/30d breakdown, Likely-AI-Clone
  count), a canvas-drawn bar chart of the daily risk trend, and a top-scam-
  keywords table with a relative-frequency bar per row. Handles the empty
  DB case (friendly "no analyses yet" messages instead of a blank chart)
  and backend-unreachable errors.

## Notes / limitations (Features 3 & 4)

- Every matched scam keyword is written to `audio_keyword_hits` (one row
  per clip per keyword) at analysis time, so the keyword leaderboard is a
  real `GROUP BY`, not something reconstructed from JSON at read time.
- `backend/db.py`'s `init_db()` doubles as the migration: it always runs
  `CREATE TABLE IF NOT EXISTS` for the full schema (fresh installs), then
  `_upgrade_schema()`, which `ALTER TABLE ... ADD COLUMN`s anything a
  pre-existing `voiceguard.db` (from before these features existed) is
  missing, guarded by a `PRAGMA table_info` check so it's a safe no-op on
  every subsequent startup. I exercised this directly (seeded a DB using
  the *old* schema, then ran the new `init_db()` against it) rather than
  just reading the code — see test output in the delivery notes.
- I traced every request/response field between frontend and backend by
  hand and unit-tested `db.py` directly (all `get_analytics_summary` /
  `create_report` / `get_report` / migration scenarios described in the
  code comments actually ran, against a real SQLite file, not just
  reasoned about) — see delivery notes for the exact commands. I still
  didn't have a way to boot the full FastAPI server or a real browser in
  this sandbox (no network, `fastapi`/`torch` aren't installed), so a
  manual run-through is still worth doing:
  1. Analyze a clip → click "Generate Verification Report" → the inline
     report panel opens with a token and a verification statement; "Copy verification link"
     copies a working `/verify/{token}` URL.
  2. Open that link in a new tab (or logged out / incognito) → public page
     renders with matching risk score/classification, no login needed.
  3. Hit `/verify/not-a-real-token` → friendly 404 page, not a stack trace.
  4. With zero analyses run yet, open `analytics.html` → metric cards show
     0 / — instead of erroring, chart and keyword table show their empty
     states.
  5. Run a few single analyses and a Bulk Scan with a mix of genuine and
     scam-flagged clips → `analytics.html` reloaded shows the right
     totals, distribution, and at least one entry in "Top scam keywords".

## 5. Server-backed Review Queue & Incident Cases

- Added `review_cases` and `case_notes` tables to the existing SQLite schema. Startup-safe `CREATE TABLE IF NOT EXISTS` behavior matches the existing migration pattern; raw audio is never stored.
- `POST /api/audio/{audio_id}/flag` now persists the flag and opens an `OPEN` review case automatically when a clip is flagged. Critical-risk clips default to `CRITICAL` priority; other flagged clips default to `HIGH`.
- Added explicit case endpoints: `GET /api/review-cases`, `POST /api/audio/{audio_id}/review-case`, `GET /api/review-cases/{case_id}`, `PATCH /api/review-cases/{case_id}`, and `POST /api/review-cases/{case_id}/notes`.
- Cases support `OPEN`, `IN_REVIEW`, `RESOLVED`, and `DISMISSED` states; priorities are `LOW`, `MEDIUM`, `HIGH`, and `CRITICAL`. Titles, resolution text, and notes are validated server-side.
- Added a shared Review Queue panel to `index.html`, with filtering, refresh, case detail editing, resolution tracking, and reviewer notes. The existing verdict flag button now calls the server instead of relying only on localStorage.
- Verified Python and JavaScript syntax, SQLite persistence, FastAPI route registration, review-case HTTP round trip, and existing analytics/report database paths. Full model-backed audio analysis could not run in this sandbox because the archive's ML dependencies are not installed here.

## 6. Inline Verification Report Panel

- Replaced the fixed verification-report popup/overlay with an inline `verification-report-panel` directly beneath the analysis and provenance panels.
- The report keeps the existing `POST /reports` contract and still supports loading/error states, copied verification links, opening the public verification page, and printing/saving as PDF.
- The panel scrolls into view after generation and can be closed without blocking the rest of the website. Report fields are HTML-escaped before insertion into the DOM.

## 7. Evidence Signal Graph & Action Playbook

- Verification reports now include an immutable evidence breakdown for the acoustic model, scam-language signal, sensitive-info signal, and final risk score. The inline frontend renders these as a graphical bar chart, and the public verification page renders the same graph.
- Reports also include a unique Action Playbook generated from the classification: high-risk clips recommend pausing the request, using a trusted callback channel, and opening a review case; suspicious clips recommend a second-channel challenge; genuine clips retain normal approval safeguards.
- The `reports` table adds `evidence_breakdown` and `action_playbook` JSON columns through the existing startup-safe schema upgrade pattern.

## 8. Main Page Information Architecture

- Removed the scam keyword watchlist UI, API routes, SQLite table, and detector integration so the product remains focused on verification, review, and response.
- Moved Risk Trends & Analytics into a full-width inline panel on the main page with metric cards, a 14-day risk chart, detected-signal table, refresh control, loading/error states, and the existing `/analytics/summary` backend contract.
- Added a left-side information rail with a three-step Detect / Explain / Respond narrative, privacy note, larger VoiceGuard mark, and responsive layout behavior.

## 9. Incident Response Pack

- Added a one-click `Download incident pack` action to each generated verification report.
- The portable JSON handoff includes the public verification URL, report metadata, risk classification, evidence graph, detected signal categories, action playbook, and privacy note.
- The pack intentionally excludes original audio and full transcripts, making it suitable for sharing with a fraud, trust-and-safety, or security team.

## 10. Customer Safety Action Center

- Replaced the removed watchlist concept with a customer-facing, server-backed safety session created for each analyzed clip.
- The guided center includes three practical steps: pause the requested action, verify through a trusted channel, and save the decision record. Customers can check items off, add a short note, resume after refresh, or escalate the session for review.
- Added the `safety_sessions` SQLite table and `POST /api/safety-sessions`, `GET /api/safety-sessions/{audio_id}`, and `PATCH /api/safety-sessions/{audio_id}` APIs with validation and automatic completion tracking.

## 11. Stability and Deployment Bug Fixes

- Serialized Safety Action Center updates so rapid checklist clicks, note saves, and escalation requests cannot overwrite one another out of order.
- Bound queued safety writes and session responses to their originating analysis, preventing stale responses from appearing after a customer switches clips.
- Replaced the hard-coded placeholder backend URL with `window.VOICEGUARD_API_URL` support and a same-origin fallback for deployed environments.

## 12. Customer Workflow Ordering

- Reordered the main page into the customer flow: record or upload and analyze first, then Live Call Monitor, Bulk Scan, Risk Trends & Analytics, and finally the Review Queue.
- Live monitoring and bulk analysis remain fully wired to their existing controls and backend endpoints, while the graph and review workflow now appear as the final operational sections.

## 13. Tamper-Evident Security Audit Trail

- Added a hash-chained `audit_log` SQLite table that records analysis completion, report creation, clip flags, review case activity, and customer safety actions without storing raw audio.
- Added `GET /api/security/audit` for recent events plus chain status and `GET /api/security/audit/verify` for an integrity-only check. Any modified event or broken link is reported with the broken event ID.
- Added a final Security Audit & Evidence Integrity panel so customers and reviewers can see the event count, latest chain hash, recent actions, and whether the evidence trail is verified.

## 14. API-Key Authentication and Role-Based Access

- Added an `api_keys` table (created via `db.init_db()`, `CREATE TABLE IF NOT EXISTS`, matching the existing migration pattern). Only SHA-256 hashes are stored; keys are generated once with `python -m backend.create_key --role reviewer --label "ops-team"`, which prints the plaintext key a single time.
- Two roles: reviewer keys protect review cases, clip provenance/flagging, reports, batch reads, safety sessions, and case notes; analyst keys protect analytics and security-audit reads. Analysis endpoints and the public `/verify/{token}` page stay open.
- Protected routes require an `X-API-Key` header via role-specific FastAPI dependencies; missing or wrong-role requests get an explicit 401/403, not a silent failure.
- The browser-side key field keeps the key in JavaScript memory only for the current page session — never written to `localStorage`.
- Verified: Python compilation and JS syntax checks pass; a FastAPI smoke test confirmed missing-key rejection, wrong-role rejection, and public-endpoint access.

## 15. Voiceprint Enrollment (Independent Signal)

- Added `backend/voiceprint.py` — a dependency-light acoustic feature extractor over PCM WAV audio, compared by cosine similarity. This is a second, independent signal; it never replaces or alters the existing AI-clone `risk_score`.
- `POST /api/enroll/{customer_id}` (reviewer-authenticated) accepts a reference clip and stores only a JSON numeric embedding in the new `voice_enrollments` table — no raw audio, consistent with the rest of the app. Re-enrollment replaces the embedding while preserving `created_at` and updating `updated_at`.
- `/api/analyze` and `/api/batch-analyze` accept an optional `customer_id`; when an enrollment exists, the response includes a `voice_match` field (otherwise `null`). Frontend adds enrollment controls and a separate verdict badge for this signal.
- The extractor and similarity math were unit-tested in-sandbox with generated WAV samples. Real-world speaker discrimination, MP3 decoding, threshold calibration, and noisy-call behavior still need manual validation with real recordings, and may need a validated neural speaker-embedding model down the line.

## 16. Visual Verdict Redesign

- The live verdict now renders an animated SVG risk ring (using the existing 0/40/75 classification thresholds), a four-axis evidence radar, single-clip keyword-strength bars, and compact color-coded detection checks — no npm package or chart dependency, everything is hand-rendered SVG/CSS.
- The same evidence shape and keyword bars carry through to the inline verification report and the public `/verify/{token}` page, so what a reviewer sees and what gets shared externally stay visually consistent.
- Incident packs include the structured `voice_match` field when available, alongside the existing evidence/action data.

## 17. Bug Fixes — Auth, Review Queue, Analytics

Reproduced root causes and the smallest fix applied for each:

- **Verdict crashed on render** — `script.js` still referenced the old horizontal-meter element (`verdictFillEl`) after the markup moved to the SVG risk ring, so the lookup returned `null` mid-update. Fixed by removing the stale reference; `renderRiskRing()` already owns that update.
- **Review Queue failed on its first authenticated request** — `main.py` called seven review-case helpers that didn't exist in `db.py` (`list_review_cases`, `get_review_case`, `get_open_case_for_audio`, `create_review_case`, `update_review_case`, `get_case_notes`, `add_case_note`). Added the missing CRUD/query helpers against the existing schema.
- **Flagging failed after auth was added** — the flag request in `script.js` sent only `Content-Type`, not the shared `voiceguardAuthHeaders()` helper, so the protected endpoint rejected it. Fixed by routing that request through the existing helper.
- **Standalone analytics page threw on load** — `analytics.js` depended on `voiceguardAuthHeaders()`/`voiceguardUnauthorized()` from `script.js`, but `analytics.html` never loads `script.js`. Added page-local key state and header/unauthorized handling to `analytics.html`, falling back to the shared key when run from the main page.

Verified with: Python compilation across backend modules, JS syntax checks across all frontend scripts, a FastAPI HTTP regression against a temporary SQLite database (auth, listing, flagging, notes, unauthenticated rejection), a public-verification regression confirming the radar/ring/keyword-bar markup renders, and a full audit of `db.*` call sites and stale DOM references.

Still needs a manual browser pass for microphone permissions, MediaRecorder behavior, waveform rendering, and animation timing — the sandbox can't exercise a live browser or a production ML provider call.

## 18. Risk Trends & Analytics Redesign

- The analytics page now reads as an executive-style risk operations dashboard — stronger hero and analyst-key area, KPI cards, a threshold-aware risk trend line with green/amber/red points tied to the same 40/75 thresholds used everywhere else, a data-driven risk-mix donut, an analyst insight panel, and ranked scam-keyword volume bars.
- No npm, build step, or charting dependency added — same vanilla canvas approach as before, same `/analytics/summary` response contract, same cyber-dark theme variables.
- Verified: backend compilation, frontend syntax, a DOM-reference audit, and an HTTP contract test against seeded SQLite data with a real analyst API key. Font loading, responsive breakpoints, and canvas rendering on the actual deployment still need a manual browser check.
