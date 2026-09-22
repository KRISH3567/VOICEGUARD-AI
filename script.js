const API_BASE_URL = window.VOICEGUARD_API_URL || (
  window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost"
    ? "http://127.0.0.1:8000"
    : window.location.origin
);
let voiceguardApiKey = "";

// Keep the session key in memory only. This listener is registered by the
// first script on the page so every feature can react to key changes.
const voiceguardKeyInput = document.getElementById("api-key-input");
const voiceguardKeyStatus = document.getElementById("api-key-status");

function announceVoiceguardApiKeyChange() {
  window.dispatchEvent(new CustomEvent("voiceguard:api-key-changed", {
    detail: { hasKey: Boolean(voiceguardApiKey) },
  }));
}

voiceguardKeyInput?.addEventListener("input", () => {
  setVoiceguardApiKey(voiceguardKeyInput.value);
  if (voiceguardKeyStatus) {
    voiceguardKeyStatus.hidden = true;
    voiceguardKeyStatus.textContent = "";
  }
  announceVoiceguardApiKeyChange();
});

function getVoiceguardApiKey() {
  return voiceguardApiKey;
}

function setVoiceguardApiKey(value) {
  voiceguardApiKey = String(value || "").trim();
}

function voiceguardAuthHeaders(extra = {}) {
  const headers = { ...extra };
  if (voiceguardApiKey) headers["X-API-Key"] = voiceguardApiKey;
  return headers;
}

function voiceguardUnauthorized(message = "Unauthorized: enter a valid API key to use this feature.") {
  const target = document.getElementById("api-key-status");
  if (target) { target.hidden = false; target.textContent = message; }
}

const MAX_RECORD_SECONDS = 30;
const LIVE_CHUNK_SECONDS = 5;
const LIVE_SMOOTHING = 0.4; // weight given to each new chunk when smoothing the live score
const SILENCE_RMS_THRESHOLD = 0.012; // chunks quieter than this are treated as silence and skipped

// Tightened microcopy: internal status codes (GENUINE | SUSPICIOUS |
// AI_IMPERSONATION) never change — only how they're displayed. Mirrors
// CLASSIFICATION_LABELS in backend/main.py so a Verification Report and
// its /verify/{token} page always agree with what the app showed live.
const CLASSIFICATION_LABELS = {
  GENUINE: "Likely Genuine",
  SUSPICIOUS: "Possibly Synthetic",
  AI_IMPERSONATION: "Likely AI Clone",
};

const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const btnAnalyze = document.getElementById("btn-analyze");
const timerEl = document.getElementById("timer");
const fileInput = document.getElementById("file-input");
const dropzone = document.getElementById("dropzone");
const clipNameEl = document.getElementById("clip-name");
const clipPlayerEl = document.getElementById("clip-player");
const canvas = document.getElementById("wave");
const canvasCtx = canvas.getContext("2d");
const freqCanvas = document.getElementById("freq");
const freqCtx = freqCanvas.getContext("2d");

const verdictEl = document.getElementById("verdict");
const verdictScoreEl = document.getElementById("verdict-score");
const verdictLabelEl = document.getElementById("verdict-label");
const verdictMessageEl = document.getElementById("verdict-message");
const verdictFootnoteEl = document.getElementById("verdict-footnote");
const verdictTranscriptEl = document.getElementById("verdict-transcript");
const verdictPiiEl = document.getElementById("verdict-pii");
const riskRingFillEl = document.getElementById("risk-ring-fill");
const verdictRadarEl = document.getElementById("verdict-radar");
const verdictKeywordsEl = document.getElementById("verdict-keywords");
const checkEls = {
  transcript: [document.getElementById("check-transcript"), document.getElementById("check-transcript-text")],
  keywords: [document.getElementById("check-keywords"), document.getElementById("check-keywords-text")],
  pii: [document.getElementById("check-pii"), document.getElementById("check-pii-text")],
  voice: [document.getElementById("check-voice"), document.getElementById("check-voice-text")],
};
const voiceMatchBadgeEl = document.getElementById("voice-match-badge");
const customerIdInput = document.getElementById("customer-id-input");
const enrollmentCustomerIdInput = document.getElementById("enrollment-customer-id");
const enrollVoiceBtn = document.getElementById("btn-enroll-voice");
const enrollmentStatusEl = document.getElementById("enrollment-status");

const providerLocalBtn = document.getElementById("provider-local");
const providerHiveBtn = document.getElementById("provider-hive");
const providerNoteEl = document.getElementById("provider-note");
const transcriptionNoteEl = document.getElementById("transcription-note");
let selectedProvider = "local";

const feedbackEl = document.getElementById("feedback");
const feedbackYesBtn = document.getElementById("feedback-yes");
const feedbackNoBtn = document.getElementById("feedback-no");
const feedbackThanksEl = document.getElementById("feedback-thanks");

const backendDot = document.getElementById("backend-dot");
const backendText = document.getElementById("backend-text");

const btnLiveStart = document.getElementById("btn-live-start");
const btnLiveStop = document.getElementById("btn-live-stop");
const liveStatusEl = document.getElementById("live-status");
const liveMeterEl = document.getElementById("live-meter");
const liveScoreEl = document.getElementById("live-score");
const liveLabelEl = document.getElementById("live-label");
const liveFillEl = document.getElementById("live-fill");
const liveLogEl = document.getElementById("live-log");

let mediaRecorder = null, recordedChunks = [], recordSeconds = 0, timerInterval = null;
let audioBlob = null, audioFilename = "clip.wav", audioSourceType = "uploaded";
let audioCtx = null, analyser = null, waveDataArray = null, waveAnimationId = null;
let freqDataArray = null, freqAnimationId = null;
let clipPlayerUrl = null;

let liveDisplayStream = null, liveRecorder = null, liveChunkTimer = null;
let liveChunkParts = [], liveChunkCount = 0, liveSmoothedScore = null;

let lastResult = null;

// --- Provenance & history (Feature A) ---
// Fully client-side: history is tracked in the browser's localStorage,
// keyed by a SHA-256 hash of the audio bytes (computed with
// crypto.subtle, the same idea as the backend's content_hash, just kept
// local so this feature works even when the backend's history endpoints
// aren't reachable). It's shown inline as a panel in the page — not a
// popup/modal and not a toast-style notification — and is shared by both
// the single-clip flow and the batch results table below.
const PROVENANCE_STORAGE_KEY = "voiceguard_provenance_v1";

const btnOpenProvenance = document.getElementById("btn-open-provenance");
const btnFlagToggle = document.getElementById("btn-flag-toggle");
const provenancePanel = document.getElementById("provenance-panel");
const provenancePanelTitle = document.getElementById("provenance-panel-title");
const provenanceBody = document.getElementById("provenance-body");
const provenancePanelClose = document.getElementById("provenance-panel-close");

let activeProvenanceId = null; // id (content hash) currently rendered in the panel

function loadProvenanceStore() {
  try {
    return JSON.parse(localStorage.getItem(PROVENANCE_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveProvenanceStore(store) {
  try {
    localStorage.setItem(PROVENANCE_STORAGE_KEY, JSON.stringify(store));
  } catch (err) {
    console.warn("Couldn't save provenance history locally:", err);
  }
}

async function hashAudio(blob) {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fileFormat(filename, blob) {
  const ext = (filename || "").split(".").pop();
  if (ext && ext.length <= 5 && ext !== filename) return ext.toLowerCase();
  if (blob?.type) return blob.type.split("/").pop();
  return "unknown";
}

function engineLabelFor(provider) {
  return provider === "hive" ? "Hive API v3" : "Local model";
}

// Records (or updates, for a re-upload/re-analysis of the same audio) one
// analyzed clip in the local provenance store. Returns the full record,
// whose `id` (a content hash) is what the rest of the app uses to look
// the clip's history back up.
async function recordProvenance({ blob, filename, sourceType, provider, modelVersion, riskScore, status, durationSeconds }) {
  const id = await hashAudio(blob);
  const store = loadProvenanceStore();
  const existing = store[id];
  const now = Date.now();

  let eventType, detail;
  if (!existing) {
    eventType = "created";
    detail = `Analyzed via ${engineLabelFor(provider)} (${sourceType}).`;
  } else if (sourceType === "uploaded") {
    eventType = "re_uploaded";
    detail = `Same audio re-uploaded and analyzed via ${engineLabelFor(provider)}.`;
  } else {
    eventType = "re_analyzed";
    detail = `Same audio re-analyzed via ${engineLabelFor(provider)}.`;
  }

  const record = {
    id,
    filename,
    source_type: sourceType,
    format: fileFormat(filename, blob),
    size_bytes: blob.size,
    duration_seconds: durationSeconds ?? existing?.duration_seconds ?? null,
    provider,
    model_version: modelVersion,
    risk_score: riskScore,
    status,
    flagged: existing?.flagged || false,
    created_at: existing?.created_at || now,
    updated_at: now,
    history: [...(existing?.history || []), { event_type: eventType, detail, created_at: now }],
  };

  store[id] = record;
  saveProvenanceStore(store);
  return record;
}

function setFlagButtonState(flagged) {
  btnFlagToggle.textContent = flagged ? "Unflag this clip" : "Flag this clip";
  btnFlagToggle.classList.toggle("is-flagged", flagged);
  btnFlagToggle.dataset.flagged = flagged ? "1" : "0";
}

function renderProvenancePanel(record) {
  provenancePanelTitle.textContent = `Clip History & Verification Log — ${record.filename}`;

  const facts = [
    ["Source", formatLabel(record.source_type)],
    ["Format", (record.format || "unknown").toUpperCase()],
    ["Duration", record.duration_seconds ? `${record.duration_seconds}s` : "—"],
    ["Size", record.size_bytes ? `${(record.size_bytes / 1024).toFixed(1)} KB` : "—"],
    ["Engine", engineLabelFor(record.provider)],
    ["Model version", record.model_version || "—"],
    ["Risk score", `${record.risk_score} (${formatLabel(record.status)})`],
    ["Flagged", record.flagged ? "Yes" : "No"],
  ];

  const factsHtml = facts.map(([label, value]) => `
    <div class="provenance-fact">
      <span class="provenance-fact-label">${label}</span>
      <span class="provenance-fact-value">${value}</span>
    </div>
  `).join("");

  // Most recent event first, since that's what a reviewer opening the
  // panel usually wants to see without scrolling.
  const timelineHtml = [...record.history].reverse().map((event) => {
    const time = new Date(event.created_at).toLocaleString();
    return `
      <li class="event-${event.event_type}">
        <div class="timeline-event">${formatLabel(event.event_type)}</div>
        <div class="timeline-detail">${event.detail || ""}</div>
        <div class="timeline-time">${time}</div>
      </li>
    `;
  }).join("");

  provenanceBody.innerHTML = `
    <div class="provenance-facts">${factsHtml}</div>
    <ul class="timeline">${timelineHtml}</ul>
  `;
}

// Shows the inline panel populated with one clip's history. Used both by
// the "Provenance & history" link under a fresh verdict and by each
// batch-results row's "View history" button.
function showProvenancePanel(id) {
  const store = loadProvenanceStore();
  const record = store[id];
  if (!record) {
    provenancePanelTitle.textContent = "Clip History & Verification Log";
    provenanceBody.innerHTML = `<p class="muted-note">No local history found for this clip (it may have been cleared from this browser).</p>`;
    provenancePanel.hidden = false;
    return;
  }
  activeProvenanceId = id;
  renderProvenancePanel(record);
  provenancePanel.hidden = false;
  btnOpenProvenance.setAttribute("aria-expanded", "true");
  if (lastResult?.localId === id) btnOpenProvenance.textContent = "Hide clip history & verification log";
  provenancePanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideProvenancePanel() {
  provenancePanel.hidden = true;
  activeProvenanceId = null;
  btnOpenProvenance.textContent = "Clip History & Verification Log";
  btnOpenProvenance.setAttribute("aria-expanded", "false");
}

provenancePanelClose.addEventListener("click", hideProvenancePanel);

btnOpenProvenance.addEventListener("click", () => {
  if (!lastResult?.localId) return;
  if (!provenancePanel.hidden && activeProvenanceId === lastResult.localId) {
    hideProvenancePanel();
  } else {
    showProvenancePanel(lastResult.localId);
  }
});

btnFlagToggle.addEventListener("click", async () => {
  if (!lastResult?.localId) return;
  const store = loadProvenanceStore();
  const record = store[lastResult.localId];
  if (!record) return;

  const nextFlagged = !record.flagged;
  if (!lastResult.audio_id) {
    alert("This clip has no server analysis id, so it cannot enter the shared review queue.");
    return;
  }
  btnFlagToggle.disabled = true;
  const originalText = btnFlagToggle.textContent;
  btnFlagToggle.textContent = nextFlagged ? "Opening case…" : "Updating…";
  try {
    const res = await fetch(`${API_BASE_URL}/api/audio/${lastResult.audio_id}/flag`, {
      method: "POST",
      headers: voiceguardAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ flagged: nextFlagged }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Request failed (${res.status})`);
    }
    const flagResult = await res.json();
    record.flagged = flagResult.flagged;
  } catch (err) {
    btnFlagToggle.textContent = originalText;
    alert(`Couldn't update the shared review queue: ${err.message}`);
    return;
  } finally {
    btnFlagToggle.disabled = false;
  }
  record.flagged = nextFlagged;
  record.updated_at = Date.now();
  record.history.push({
    event_type: nextFlagged ? "flagged" : "unflagged",
    detail: nextFlagged ? "Marked by reviewer." : "Unmarked by reviewer.",
    created_at: Date.now(),
  });
  store[lastResult.localId] = record;
  saveProvenanceStore(store);

  setFlagButtonState(nextFlagged);
  if (!provenancePanel.hidden && activeProvenanceId === lastResult.localId) {
    renderProvenancePanel(record);
  }
  loadReviewQueue();
});

// --- Trust Badge & Verification Report ---
// Talks to the backend's POST /reports + GET /verify/{token} (main.py),
// unlike the Clip History & Verification Log panel above, which is
// entirely local. A report needs a server-side `audio_id` (returned as
// `audio_id` on every /api/analyze and /api/batch-analyze result), so it
// only works for clips that were actually sent to the backend.
const btnGenerateReport = document.getElementById("btn-generate-report");
const reportPanel = document.getElementById("verification-report-panel");
const reportPanelBody = document.getElementById("verification-report-body");
const reportPanelTitle = document.getElementById("report-panel-title");
const reportPanelClose = document.getElementById("report-panel-close");
const reportCopyLinkBtn = document.getElementById("report-copy-link");
const reportOpenLinkEl = document.getElementById("report-open-link");
const reportPrintBtn = document.getElementById("report-print");
const reportDownloadPackBtn = document.getElementById("report-download-pack");
const safetyCenter = document.getElementById("safety-center");
const safetyProgress = document.getElementById("safety-progress");
const safetyTasks = document.getElementById("safety-tasks");
const safetyNote = document.getElementById("safety-note");
const safetySaveStatus = document.getElementById("safety-save-status");
const safetyEscalate = document.getElementById("safety-escalate");

let currentReport = null;
let currentSafetySession = null;
let safetyUpdateQueue = Promise.resolve();

function verifyUrlFor(token) {
  return `${API_BASE_URL}/verify/${token}`;
}

function reportEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[ch]));
}

function openReportPanel() {
  reportPanel.hidden = false;
  reportPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeReportPanel() {
  reportPanel.hidden = true;
}

function renderSafetySession(session) {
  currentSafetySession = session;
  const completed = session.tasks.filter((task) => task.completed).length;
  safetyProgress.textContent = `${completed} / ${session.tasks.length} complete`;
  safetyNote.value = session.customer_note || "";
  safetyTasks.innerHTML = session.tasks.map((task) => `
    <button type="button" class="safety-task ${task.completed ? "is-complete" : ""}" data-safety-task="${reportEscape(task.id)}">
      <span class="safety-task-check">${task.completed ? "✓" : ""}</span>
      <span><strong>${reportEscape(task.title)}</strong><small>${reportEscape(task.detail)}</small></span>
    </button>`).join("");
  safetyCenter.hidden = false;
  safetySaveStatus.textContent = session.status === "ESCALATED" ? "Sent to review queue" : session.status === "COMPLETED" ? "Safety check complete" : "Saved to your safety session";
}

async function loadSafetySession(audioId) {
  if (!audioId) return;
  try {
    const response = await fetch(`${API_BASE_URL}/api/safety-sessions`, {
      method: "POST", headers: voiceguardAuthHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ audio_id: audioId }) });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) voiceguardUnauthorized("Unauthorized: enter a valid reviewer API key.");
      throw new Error(`Safety session request failed (${response.status})`);
    }
    const session = await response.json();
    if (lastResult?.audio_id === audioId) renderSafetySession(session);
  } catch (err) {
    safetyCenter.hidden = false;
    safetyTasks.innerHTML = `<p class="safety-error">Safety checklist unavailable: ${reportEscape(err.message)}</p>`;
  }
}

async function updateSafetySession(payload, audioId = lastResult?.audio_id) {
  if (!audioId) return;
  safetySaveStatus.textContent = "Saving…";
  const response = await fetch(`${API_BASE_URL}/api/safety-sessions/${encodeURIComponent(audioId)}`, { method: "PATCH", headers: voiceguardAuthHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(payload) });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || `Save failed (${response.status})`);
  }
  const session = await response.json();
  if (lastResult?.audio_id === audioId) renderSafetySession(session);
}

function queueSafetyUpdate(payload) {
  const audioId = lastResult?.audio_id;
  const request = safetyUpdateQueue.then(() => updateSafetySession(payload, audioId));
  safetyUpdateQueue = request.catch(() => {});
  return request;
}

safetyTasks.addEventListener("click", async (event) => {
  const taskButton = event.target.closest("[data-safety-task]");
  if (!taskButton) return;
  const task = currentSafetySession?.tasks.find((item) => item.id === taskButton.dataset.safetyTask);
  if (!task) return;
  taskButton.disabled = true;
  try { await queueSafetyUpdate({ task_id: task.id, completed: !task.completed }); }
  catch (err) { safetySaveStatus.textContent = `Couldn't save: ${err.message}`; }
  finally { taskButton.disabled = false; }
});

safetyNote.addEventListener("blur", async () => {
  try { await queueSafetyUpdate({ customer_note: safetyNote.value }); }
  catch (err) { safetySaveStatus.textContent = `Couldn't save: ${err.message}`; }
});

safetyEscalate.addEventListener("click", async () => {
  safetyEscalate.disabled = true;
  try { await queueSafetyUpdate({ status: "ESCALATED", customer_note: safetyNote.value }); }
  catch (err) { safetySaveStatus.textContent = `Couldn't escalate: ${err.message}`; }
  finally { safetyEscalate.disabled = false; }
});

function visualEscape(value) { return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[ch])); }
function setCheck(name, state, text) { const [card, label] = checkEls[name]; card.className = `detection-check ${state || ""}`; label.textContent = text; }
function toneForScore(score) { return score >= 75 ? "bad" : score >= 40 ? "warn" : "good"; }
function renderRiskRing(score) {
  const circumference = 2 * Math.PI * 50;
  riskRingFillEl.style.strokeDasharray = `${circumference}`;
  riskRingFillEl.style.strokeDashoffset = `${circumference}`;
  riskRingFillEl.style.setProperty("--ring-target", `${circumference * (1 - Math.max(0, Math.min(100, score)) / 100)}`);
  requestAnimationFrame(() => { riskRingFillEl.style.strokeDashoffset = `${circumference * (1 - Math.max(0, Math.min(100, score)) / 100)}`; });
}
function renderRadar(container, values) {
  const labels = ["Acoustic", "Language", "PII", "Final"];
  const cx = 120, cy = 106, radius = 72;
  const point = (value, r = radius) => { const angle = -Math.PI / 2 + (values.indexOf(value) * Math.PI * 2 / 4); return [cx + Math.cos(angle) * r * (value / 100), cy + Math.sin(angle) * r * (value / 100)]; };
  const axisPoint = (i, r) => [cx + Math.cos(-Math.PI / 2 + i * Math.PI / 2) * r, cy + Math.sin(-Math.PI / 2 + i * Math.PI / 2) * r];
  const polygon = values.map((v, i) => { const [x, y] = axisPoint(i, radius * v / 100); return `${x},${y}`; }).join(" ");
  const grid = [25, 50, 75, 100].map((level) => `<polygon points="${[0,1,2,3].map((i) => axisPoint(i, radius * level / 100).join(",")).join(" ")}" class="radar-grid"></polygon>`).join("");
  const axes = [0,1,2,3].map((i) => { const [x, y] = axisPoint(i, radius); return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="radar-axis"></line><text x="${axisPoint(i, radius + 18)[0]}" y="${axisPoint(i, radius + 18)[1]}" class="radar-label" text-anchor="middle">${labels[i]}</text>`; }).join("");
  container.innerHTML = `<svg viewBox="0 0 240 220" role="img" aria-label="Evidence radar chart">${grid}${axes}<polygon points="${polygon}" class="radar-value"></polygon>${values.map((v, i) => { const [x, y] = axisPoint(i, radius * v / 100); return `<circle cx="${x}" cy="${y}" r="3" class="radar-point"></circle>`; }).join("")}</svg>`;
}
function renderKeywordBars(container, keywords) {
  if (!keywords?.length) { container.innerHTML = `<p class="visual-empty">No scam-language signals detected</p>`; return; }
  const max = Math.max(1, keywords.length);
  container.innerHTML = keywords.map((keyword, i) => { const strength = Math.max(28, 100 - i * (62 / max)); return `<div class="keyword-bar-row"><div><span>${visualEscape(String(keyword).replace(/_/g, " "))}</span><b>${Math.round(strength)}</b></div><span class="keyword-bar-track"><i style="width:${strength}%"></i></span></div>`; }).join("");
}
function renderVerdictVisuals(result) {
  const score = Number(result.risk_score) || 0;
  renderRiskRing(score);
  const keywordValues = result.keyword_matches || [];
  const piiValues = result.pii_matches || [];
  const evidence = [Number(result.voice_risk_score) || 0, Math.min(100, keywordValues.length * 20), Math.min(100, piiValues.length * 20), score];
  renderRadar(verdictRadarEl, evidence);
  renderKeywordBars(verdictKeywordsEl, keywordValues);
  setCheck("transcript", result.transcript ? "good" : "muted", result.transcript ? "Detected" : "No speech");
  setCheck("keywords", keywordValues.length ? (keywordValues.length > 2 ? "bad" : "warn") : "good", keywordValues.length ? `${keywordValues.length} signal${keywordValues.length === 1 ? "" : "s"}` : "Clear");
  setCheck("pii", piiValues.length ? "warn" : "good", piiValues.length ? `${piiValues.length} flag${piiValues.length === 1 ? "" : "s"}` : "Clear");
  setCheck("voice", result.voice_match ? (result.voice_match.match ? "good" : "bad") : "muted", result.voice_match ? `${result.voice_match.match ? "Match" : "No match"} · ${Math.round(result.voice_match.score * 100)}%` : "Not enrolled");
}

function renderReportPanel(report) {
  report.voice_match = report.voice_match || lastResult?.voice_match || null;
  const verifyUrl = verifyUrlFor(report.token);
  const generatedAt = new Date(report.created_at * 1000).toLocaleString();
  const allFlags = [...(report.keyword_flags || []), ...(report.pii_flags || [])];
  const evidence = report.evidence_breakdown || [];
  const playbook = report.action_playbook || [];
  const evidenceValues = evidence.map((item) => Math.max(0, Math.min(100, Number(item.value) || 0)));
  const reportRadar = evidenceValues.length === 4 ? `<div class="report-radar" data-values="${evidenceValues.join(",")}"></div>` : "";
  const reportKeywordBars = (report.keyword_flags || []).length ? `<div class="report-keyword-bars">${report.keyword_flags.map((keyword, index) => `<div class="keyword-bar-row"><div><span>${reportEscape(String(keyword).replace(/_/g, " "))}</span><b>${Math.max(28, 100 - index * 18)}</b></div><span class="keyword-bar-track"><i style="width:${Math.max(28, 100 - index * 18)}%"></i></span></div>`).join("")}</div>` : `<p class="visual-empty">No scam-language signals detected</p>`;
  const evidenceHtml = evidence.length ? `<section class="report-evidence"><div class="report-section-heading"><span>Evidence signal shape</span><small>Independent indicators; final risk remains the detector output.</small></div>${reportRadar}<div class="report-keyword-heading">Keyword strength</div>${reportKeywordBars}</section>` : "";
  const playbookHtml = playbook.length
    ? `<section class="report-playbook"><div class="report-section-heading"><span>Action playbook</span><small>A practical next step based on this verdict and its signals.</small></div><ol>${playbook.map((step) => `<li><strong>${reportEscape(step.title)}</strong><span>${reportEscape(step.detail)}</span></li>`).join("")}</ol></section>`
    : "";

  reportPanelTitle.textContent = `Verification report — ${report.filename || "Voice clip"}`;
  reportPanelBody.innerHTML = `
    <span class="verified-badge">✓ Verified by VoiceGuard</span>
    <h3 class="report-filename">${reportEscape(report.filename || "Voice clip")}</h3>
    <div class="provenance-facts">
      <div class="provenance-fact">
        <span class="provenance-fact-label">Classification</span>
        <span class="provenance-fact-value">${reportEscape(report.classification)}</span>
      </div>
      <div class="provenance-fact">
        <span class="provenance-fact-label">Impersonation Risk Score</span>
        <span class="provenance-fact-value">${reportEscape(report.risk_score)}/100</span>
      </div>
      <div class="provenance-fact">
        <span class="provenance-fact-label">Engine</span>
        <span class="provenance-fact-value">${reportEscape(report.engine)}</span>
      </div>
      <div class="provenance-fact">
        <span class="provenance-fact-label">Generated</span>
        <span class="provenance-fact-value">${reportEscape(generatedAt)}</span>
      </div>
    </div>
    ${report.transcript_summary
      ? `<p class="report-transcript">Transcript excerpt: "${reportEscape(report.transcript_summary)}"</p>`
      : ""}
    ${allFlags.length
      ? `<p class="verdict-pii">⚠ Scam / sensitive-info signals: ${reportEscape(allFlags.join(", ").replace(/_/g, " "))}</p>`
      : ""}
    ${evidenceHtml}
    ${playbookHtml}
    <p class="report-statement">${reportEscape(report.verification_statement)}</p>
    <label class="report-link-label" for="report-link-input">Public verification link</label>
    <input type="text" class="report-link-input" id="report-link-input" value="${reportEscape(verifyUrl)}" readonly>
  `;

  reportOpenLinkEl.href = verifyUrl;
  const radar = reportPanelBody.querySelector(".report-radar");
  if (radar) renderRadar(radar, (radar.dataset.values || "0,0,0,0").split(",").map(Number));
}

async function generateReport(analysisId, triggerBtn) {
  if (!analysisId) {
    alert("This clip hasn't been analyzed by the backend yet, so no verification report can be generated.");
    return;
  }
  const originalText = triggerBtn ? triggerBtn.textContent : null;
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = "Generating…";
  }
  openReportPanel();
  reportPanelBody.innerHTML = `<p class="muted-note">Generating report…</p>`;

  try {
    const res = await fetch(`${API_BASE_URL}/reports`, {
      headers: voiceguardAuthHeaders({ "Content-Type": "application/json" }),
      method: "POST",
      body: JSON.stringify({ analysis_id: analysisId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) voiceguardUnauthorized(err.detail || "Unauthorized: enter a valid reviewer API key.");
      throw new Error(err.detail || `Request failed (${res.status})`);
    }
    const report = await res.json();
    currentReport = report;
    renderReportPanel(report);
  } catch (err) {
    reportPanelBody.innerHTML = `<p class="muted-note">Couldn't generate a verification report: ${reportEscape(err.message)}</p>`;
    currentReport = null;
  } finally {
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = originalText;
    }
  }
}

btnGenerateReport.addEventListener("click", () => {
  generateReport(lastResult?.audio_id, btnGenerateReport);
});

reportPanelClose.addEventListener("click", closeReportPanel);

reportCopyLinkBtn.addEventListener("click", async () => {
  if (!currentReport) return;
  const verifyUrl = verifyUrlFor(currentReport.token);
  try {
    await navigator.clipboard.writeText(verifyUrl);
    reportCopyLinkBtn.textContent = "Copied!";
  } catch {
    const input = document.getElementById("report-link-input");
    if (input) {
      input.select();
      document.execCommand("copy");
      reportCopyLinkBtn.textContent = "Copied!";
    }
  }
  setTimeout(() => { reportCopyLinkBtn.textContent = "Copy verification link"; }, 1800);
});

reportPrintBtn.addEventListener("click", () => window.print());

reportDownloadPackBtn.addEventListener("click", () => {
  if (!currentReport) {
    reportDownloadPackBtn.textContent = "Generate a report first";
    setTimeout(() => { reportDownloadPackBtn.textContent = "Download incident pack"; }, 1800);
    return;
  }

  // Deliberately excludes audio bytes and full transcripts. This is a safe,
  // portable handoff artifact for a fraud or security team.
  const pack = {
    pack_type: "VoiceGuard Incident Response Pack",
    pack_version: 1,
    exported_at: new Date().toISOString(),
    verification: {
      public_url: verifyUrlFor(currentReport.token),
      token: currentReport.token,
      generated_at: new Date(currentReport.created_at * 1000).toISOString(),
    },
    analysis: {
      analysis_id: currentReport.analysis_id,
      filename: currentReport.filename,
      classification: currentReport.classification,
      risk_score: currentReport.risk_score,
      engine: currentReport.engine,
      duration_seconds: currentReport.duration_seconds,
      transcript_excerpt: currentReport.transcript_summary || "",
      keyword_flags: currentReport.keyword_flags || [],
      pii_flags: currentReport.pii_flags || [],
      voice_match: currentReport.voice_match || null,
    },
    evidence_breakdown: currentReport.evidence_breakdown || [],
    action_playbook: currentReport.action_playbook || [],
    verification_statement: currentReport.verification_statement,
    privacy_note: "VoiceGuard does not include or store the original audio in this pack.",
  };
  const safeName = String(currentReport.filename || "voice-clip")
    .replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `voiceguard-incident-pack-${safeName || "voice-clip"}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  reportDownloadPackBtn.textContent = "Pack downloaded";
  setTimeout(() => { reportDownloadPackBtn.textContent = "Download incident pack"; }, 1800);
});

function drawIdleLine() {
  const { width, height } = canvas;
  canvasCtx.clearRect(0, 0, width, height);
  canvasCtx.strokeStyle = "#3a3548";
  canvasCtx.lineWidth = 2;
  canvasCtx.beginPath();
  canvasCtx.moveTo(0, height / 2);
  canvasCtx.lineTo(width, height / 2);
  canvasCtx.stroke();
}
drawIdleLine();

// Idle state for the frequency detector: a flat row of low bars so the
// panel doesn't look empty before a recording starts.
function drawIdleBars() {
  const { width, height } = freqCanvas;
  freqCtx.clearRect(0, 0, width, height);
  const barCount = 48;
  const barWidth = width / barCount;
  freqCtx.fillStyle = "#3a3548";
  for (let i = 0; i < barCount; i++) {
    freqCtx.fillRect(i * barWidth + 1, height - 3, barWidth - 2, 3);
  }
}
drawIdleBars();

function setBackendText(text, state) {
  backendText.textContent = text;
  backendDot.className = `dot ${state || ""}`;
}

function setLiveStatus(text, state) {
  liveStatusEl.textContent = text;
  liveStatusEl.className = `timer ${state || ""}`;
}

function classifyScore(score) {
  if (score < 40) return "GENUINE";
  if (score < 75) return "SUSPICIOUS";
  return "AI_IMPERSONATION";
}

function toneOf(status) {
  return status === "GENUINE" ? "good" : status === "SUSPICIOUS" ? "warn" : "bad";
}

function formatLabel(status) {
  if (CLASSIFICATION_LABELS[status]) return CLASSIFICATION_LABELS[status];
  return status.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

function setClipPlayerSource(blob) {
  if (clipPlayerUrl) URL.revokeObjectURL(clipPlayerUrl);
  clipPlayerUrl = URL.createObjectURL(blob);
  clipPlayerEl.src = clipPlayerUrl;
  clipPlayerEl.hidden = false;
}

function resetFeedback() {
  feedbackEl.hidden = false;
  feedbackThanksEl.hidden = true;
  feedbackYesBtn.hidden = false;
  feedbackNoBtn.hidden = false;
}

function readyToAnalyze(name) {
  clipNameEl.textContent = `Ready to analyze: ${name}`;
  clipNameEl.hidden = false;
  btnAnalyze.disabled = false;
  syncEnrollmentButton();
  verdictEl.hidden = true;
  safetyCenter.hidden = true;
  currentSafetySession = null;
}

function drawLiveWaveform() {
  const { width, height } = canvas;
  analyser.getByteTimeDomainData(waveDataArray);
  canvasCtx.clearRect(0, 0, width, height);
  canvasCtx.strokeStyle = "#6a79ff";
  canvasCtx.lineWidth = 2;
  canvasCtx.beginPath();

  const sliceWidth = width / waveDataArray.length;
  let x = 0;
  for (let i = 0; i < waveDataArray.length; i++) {
    const y = (waveDataArray[i] / 128.0 * height) / 2;
    if (i === 0) canvasCtx.moveTo(x, y);
    else canvasCtx.lineTo(x, y);
    x += sliceWidth;
  }
  canvasCtx.stroke();
  waveAnimationId = requestAnimationFrame(drawLiveWaveform);
}

// Frequency-domain view of the same signal: groups the analyser's FFT bins
// into bars so pitch/formant activity is visible alongside the raw waveform.
function drawFrequencyBars() {
  const { width, height } = freqCanvas;
  analyser.getByteFrequencyData(freqDataArray);
  freqCtx.clearRect(0, 0, width, height);

  const barCount = 48;
  const binsPerBar = Math.max(1, Math.floor(freqDataArray.length / barCount));
  const barWidth = width / barCount;

  for (let i = 0; i < barCount; i++) {
    let sum = 0;
    for (let j = 0; j < binsPerBar; j++) sum += freqDataArray[i * binsPerBar + j];
    const value = sum / binsPerBar;
    const barHeight = Math.max(3, (value / 255) * height);

    freqCtx.fillStyle = value > 190 ? "#e8432b" : value > 120 ? "#f2b705" : "#6a79ff";
    freqCtx.fillRect(i * barWidth + 1, height - barHeight, barWidth - 2, barHeight);
  }

  freqAnimationId = requestAnimationFrame(drawFrequencyBars);
}

// Decodes a recorded webm blob to 16-bit PCM WAV, and also returns the RMS
// amplitude of the clip so callers can tell real speech from near-silence.
async function decodeToWav(webmBlob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buffer = await ctx.decodeAudioData(await webmBlob.arrayBuffer());
  await ctx.close();

  const { numberOfChannels: channels, sampleRate, length: frames } = buffer;
  const interleaved = new Float32Array(frames * channels);
  let sumSquares = 0;
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < frames; i++) {
      const sample = data[i];
      interleaved[i * channels + ch] = sample;
      sumSquares += sample * sample;
    }
  }
  const rms = interleaved.length ? Math.sqrt(sumSquares / interleaved.length) : 0;

  const blockAlign = channels * 2;
  const dataSize = interleaved.length * 2;
  const view = new DataView(new ArrayBuffer(44 + dataSize));
  const writeStr = (offset, str) => [...str].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const sample of interleaved) {
    const s = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return { blob: new Blob([view.buffer], { type: "audio/wav" }), rms };
}

function setProvider(provider) {
  selectedProvider = provider;
  providerLocalBtn.classList.toggle("active", provider === "local");
  providerLocalBtn.setAttribute("aria-checked", String(provider === "local"));
  providerHiveBtn.classList.toggle("active", provider === "hive");
  providerHiveBtn.setAttribute("aria-checked", String(provider === "hive"));
}

providerLocalBtn.addEventListener("click", () => setProvider("local"));
providerHiveBtn.addEventListener("click", () => {
  if (!providerHiveBtn.disabled) setProvider("hive");
});

async function loadProviderConfig() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/config`);
    const data = await res.json();
    const local = data.providers?.local;
    const hive = data.providers?.hive;

    providerLocalBtn.disabled = !local?.available;
    providerHiveBtn.disabled = !hive?.available;

    if (!hive?.available) {
      providerNoteEl.textContent = "Hive API v3 is off — set HIVE_API_KEY in backend/.env to enable it.";
    } else if (!local?.available) {
      providerNoteEl.textContent = "Local model isn't ready on the backend — using Hive API v3 instead.";
      setProvider("hive");
    } else {
      providerNoteEl.textContent = "";
    }

    if (!local?.available && !hive?.available) {
      providerNoteEl.textContent = "No detection engine is ready on the backend yet.";
    }

    const transcription = data.transcription;
    transcriptionNoteEl.textContent = transcription?.google_available
      ? "Transcript & scam-word scan: Google Speech-to-Text"
      : "Transcript & scam-word scan: free fallback (set GOOGLE_STT_API_KEY for better accuracy)";
  } catch {
    providerNoteEl.textContent = "Couldn't load engine config from the backend.";
  }
}

async function postForAnalysis(blob, filename, sourceType = "uploaded") {
  const formData = new FormData();
  formData.append("file", blob, filename);
  formData.append("provider", selectedProvider);
  formData.append("source_type", sourceType);
  const customerId = customerIdInput?.value.trim();
  if (customerId) formData.append("customer_id", customerId);
  const res = await fetch(`${API_BASE_URL}/api/analyze`, { method: "POST", body: formData });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Request failed (${res.status})`);
  }
  return res.json();
}

btnStart.addEventListener("click", async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    setBackendText("Recording needs HTTPS (or localhost) — this page is served over plain HTTP.", "down");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    waveDataArray = new Uint8Array(analyser.frequencyBinCount);
    freqDataArray = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);
    drawLiveWaveform();
    drawFrequencyBars();

    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      cancelAnimationFrame(waveAnimationId);
      cancelAnimationFrame(freqAnimationId);
      if (audioCtx) audioCtx.close();
      drawIdleLine();
      drawIdleBars();

      const { blob } = await decodeToWav(new Blob(recordedChunks, { type: "audio/webm" }));
      audioBlob = blob;
      audioFilename = "recording.wav";
      audioSourceType = "recorded";
      setClipPlayerSource(audioBlob);
      readyToAnalyze(audioFilename);
    };

    mediaRecorder.start();
    btnStart.disabled = true;
    btnStart.classList.add("live");
    btnStop.disabled = false;

    recordSeconds = 0;
    timerEl.textContent = "0:00";
    timerInterval = setInterval(() => {
      recordSeconds++;
      const mm = Math.floor(recordSeconds / 60);
      const ss = String(recordSeconds % 60).padStart(2, "0");
      timerEl.textContent = `${mm}:${ss}`;
      if (recordSeconds >= MAX_RECORD_SECONDS) btnStop.click();
    }, 1000);
  } catch (err) {
    setBackendText(`Microphone access denied: ${err.message}`, "down");
  }
});

btnStop.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  clearInterval(timerInterval);
  btnStart.disabled = false;
  btnStart.classList.remove("live");
  btnStop.disabled = true;
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  audioBlob = file;
  audioFilename = file.name;
  audioSourceType = "uploaded";
  setClipPlayerSource(audioBlob);
  readyToAnalyze(audioFilename);
});

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag-over");
  });
});

["dragleave", "dragend"].forEach((eventName) => {
  dropzone.addEventListener(eventName, () => dropzone.classList.remove("drag-over"));
});

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (!file) return;
  audioBlob = file;
  audioFilename = file.name;
  audioSourceType = "uploaded";
  setClipPlayerSource(audioBlob);
  readyToAnalyze(audioFilename);
});

function syncEnrollmentButton() {
  if (enrollVoiceBtn) enrollVoiceBtn.disabled = !audioBlob || !enrollmentCustomerIdInput?.value.trim();
}

enrollmentCustomerIdInput?.addEventListener("input", syncEnrollmentButton);
enrollVoiceBtn?.addEventListener("click", async () => {
  if (!audioBlob || !enrollmentCustomerIdInput.value.trim()) return;
  enrollVoiceBtn.disabled = true;
  enrollmentStatusEl.textContent = "Enrolling…";
  const formData = new FormData();
  formData.append("file", audioBlob, audioFilename);
  try {
    const response = await fetch(`${API_BASE_URL}/api/enroll/${encodeURIComponent(enrollmentCustomerIdInput.value.trim())}`, {
      method: "POST", headers: voiceguardAuthHeaders(), body: formData,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) voiceguardUnauthorized(result.detail || "Unauthorized: enter a valid reviewer API key.");
      throw new Error(result.detail || `Enrollment failed (${response.status})`);
    }
    enrollmentStatusEl.textContent = "Voice enrolled. Future tagged analyses will show a separate voice-match signal.";
  } catch (error) {
    enrollmentStatusEl.textContent = `Couldn't enroll voice: ${error.message}`;
  } finally {
    syncEnrollmentButton();
  }
});

btnAnalyze.addEventListener("click", async () => {
  if (!audioBlob) return;
  btnAnalyze.disabled = true;
  btnAnalyze.textContent = "Analyzing…";

  try {
    const result = await postForAnalysis(audioBlob, audioFilename, audioSourceType);

    // Feature A: log this analysis to the local provenance store (keyed
    // by audio content hash) and remember its id on the result so the
    // "Provenance & history" / flag buttons below know what to operate on.
    const provenanceRecord = await recordProvenance({
      blob: audioBlob,
      filename: audioFilename,
      sourceType: audioSourceType,
      provider: result.provider,
      modelVersion: result.model_version,
      riskScore: result.risk_score,
      status: result.status,
      durationSeconds: result.duration_seconds,
    });
    result.localId = provenanceRecord.id;

    lastResult = result;
    hideProvenancePanel(); // collapse any panel left open from a previous clip
    const tone = toneOf(result.status);
    verdictEl.className = `verdict ${tone}`;
    verdictEl.hidden = false;
    verdictScoreEl.textContent = result.risk_score;
    verdictLabelEl.textContent = formatLabel(result.status);
    verdictMessageEl.textContent = result.message;
    renderVerdictVisuals(result);
    if (result.voice_match) {
      voiceMatchBadgeEl.hidden = false;
      voiceMatchBadgeEl.className = `voice-match-badge ${result.voice_match.match ? "is-match" : "is-mismatch"}`;
      voiceMatchBadgeEl.textContent = `Voice match: ${result.voice_match.match ? "Match" : "No match"} (${Math.round(result.voice_match.score * 100)}%) — ${result.voice_match.message}`;
    } else {
      voiceMatchBadgeEl.hidden = true;
      voiceMatchBadgeEl.textContent = "";
    }
    verdictTranscriptEl.textContent = result.transcript ? `"${result.transcript}"` : "No speech recognized";
    if (result.pii_matches && result.pii_matches.length) {
      verdictPiiEl.hidden = false;
      verdictPiiEl.textContent = `⚠ Sensitive info mentioned: ${result.pii_matches.join(", ").replace(/_/g, " ")}`;
    } else {
      verdictPiiEl.hidden = true;
    }
    const engineLabel = result.provider === "hive" ? "Hive API v3" : "Local model";
    const sttLabel = result.transcript_provider === "google" ? "Google STT" : "fallback STT";
    verdictFootnoteEl.textContent = `${result.filename} · ${engineLabel} + ${sttLabel} · ${result.latency_ms}ms`;
    resetFeedback();
    setFlagButtonState(provenanceRecord.flagged);
    btnFlagToggle.hidden = false;
    loadSafetySession(result.audio_id);
  } catch (err) {
    setBackendText(`Error: ${err.message}`, "down");
  }

  btnAnalyze.disabled = false;
  btnAnalyze.textContent = "Analyze voice";
});

async function sendFeedback(correct) {
  if (!lastResult) return;
  feedbackYesBtn.hidden = true;
  feedbackNoBtn.hidden = true;
  feedbackThanksEl.hidden = false;
  try {
    await fetch(`${API_BASE_URL}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: lastResult.filename,
        risk_score: lastResult.risk_score,
        status: lastResult.status,
        correct,
      }),
    });
  } catch {
    feedbackThanksEl.textContent = "Couldn't save feedback — backend unreachable.";
  }
}

feedbackYesBtn.addEventListener("click", () => sendFeedback(true));
feedbackNoBtn.addEventListener("click", () => sendFeedback(false));

btnLiveStart.addEventListener("click", async () => {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setLiveStatus("Live monitoring needs HTTPS (or localhost) — this page is served over plain HTTP.", "down");
    return;
  }
  try {
    liveDisplayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const audioTracks = liveDisplayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      liveDisplayStream.getTracks().forEach((t) => t.stop());
      setLiveStatus("No audio in that share — pick a tab and check 'Share tab audio'.", "down");
      return;
    }

    liveDisplayStream.getVideoTracks().forEach((t) => t.stop());
    const audioOnlyStream = new MediaStream(audioTracks);
    startLiveRecorderCycle(audioOnlyStream);
    audioTracks[0].addEventListener("ended", stopLiveMonitoring);

    btnLiveStart.disabled = true;
    btnLiveStop.disabled = false;
    liveMeterEl.hidden = false;
    liveChunkCount = 0;
    liveSmoothedScore = null;
    liveLogEl.innerHTML = "";
    setLiveStatus("Monitoring…", "ready");
  } catch (err) {
    setLiveStatus(`Could not start: ${err.message}`, "down");
  }
});

btnLiveStop.addEventListener("click", stopLiveMonitoring);

function startLiveRecorderCycle(stream) {
  liveRecorder = new MediaRecorder(stream);
  liveChunkParts = [];

  liveRecorder.ondataavailable = (e) => { if (e.data.size > 0) liveChunkParts.push(e.data); };

  liveRecorder.onstop = async () => {
    const chunkBlob = new Blob(liveChunkParts, { type: "audio/webm" });
    liveChunkParts = [];
    analyzeLiveChunk(chunkBlob);
    if (liveDisplayStream && liveDisplayStream.getAudioTracks()[0]?.readyState === "live") {
      startLiveRecorderCycle(stream);
    }
  };

  liveRecorder.start();
  liveChunkTimer = setTimeout(() => {
    if (liveRecorder && liveRecorder.state === "recording") liveRecorder.stop();
  }, LIVE_CHUNK_SECONDS * 1000);
}

function logLiveEntry(chunkNumber, tone, text, scoreText) {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const entry = document.createElement("li");
  entry.className = tone;
  entry.innerHTML = `<span>#${chunkNumber} · ${time} · ${text}</span><span>${scoreText}</span>`;
  liveLogEl.prepend(entry);
}

async function analyzeLiveChunk(webmBlob) {
  liveChunkCount++;
  const chunkNumber = liveChunkCount;
  try {
    const { blob: wavBlob, rms } = await decodeToWav(webmBlob);

    // Skip chunks that are effectively silence (call on hold, other side
    // muted) instead of letting the model guess on near-empty audio —
    // this was the main source of the meter jumping around inaccurately.
    if (rms < SILENCE_RMS_THRESHOLD) {
      logLiveEntry(chunkNumber, "", "(silence — skipped)", "—");
      setLiveStatus("Monitoring… (silence)", "ready");
      return;
    }

    const result = await postForAnalysis(wavBlob, `live-chunk-${chunkNumber}.wav`);
    const rawTone = toneOf(result.status);

    // The headline meter shows a smoothed score so one noisy chunk doesn't
    // flip the verdict; the log below still lists each chunk's raw reading.
    liveSmoothedScore = liveSmoothedScore === null
      ? result.risk_score
      : Math.round(liveSmoothedScore * (1 - LIVE_SMOOTHING) + result.risk_score * LIVE_SMOOTHING);
    const smoothedStatus = classifyScore(liveSmoothedScore);
    const smoothedTone = toneOf(smoothedStatus);

    liveMeterEl.className = `live-meter ${smoothedTone}`;
    liveScoreEl.textContent = liveSmoothedScore;
    liveLabelEl.textContent = formatLabel(smoothedStatus);
    liveFillEl.style.width = `${liveSmoothedScore}%`;

    const transcript = result.transcript ? `"${result.transcript}"` : "(no speech)";
    logLiveEntry(chunkNumber, rawTone, transcript, `${result.risk_score} · ${result.status.replace(/_/g, " ")}`);

    setLiveStatus("Monitoring…", "ready");
  } catch (err) {
    setLiveStatus(`Chunk ${chunkNumber} failed: ${err.message}`, "down");
  }
}

function stopLiveMonitoring() {
  clearTimeout(liveChunkTimer);
  if (liveRecorder) {
    liveRecorder.ondataavailable = null;
    liveRecorder.onstop = null;
    if (liveRecorder.state !== "inactive") liveRecorder.stop();
    liveRecorder = null;
  }
  if (liveDisplayStream) {
    liveDisplayStream.getTracks().forEach((t) => t.stop());
    liveDisplayStream = null;
  }
  btnLiveStart.disabled = false;
  btnLiveStop.disabled = true;
  setLiveStatus("Not monitoring", "");
}

// --- Batch analysis & summary report (Feature B) ---
const batchDropzone = document.getElementById("batch-dropzone");
const batchFileInput = document.getElementById("batch-file-input");
const batchFileCountEl = document.getElementById("batch-file-count");
const btnBatchAnalyze = document.getElementById("btn-batch-analyze");
const batchProgressEl = document.getElementById("batch-progress");
const batchProgressFillEl = document.getElementById("batch-progress-fill");
const batchProgressTextEl = document.getElementById("batch-progress-text");
const batchResultsEl = document.getElementById("batch-results");
const batchSummaryEl = document.getElementById("batch-summary");
const batchTableBodyEl = document.getElementById("batch-table-body");
const btnDownloadReport = document.getElementById("btn-download-report");

const MAX_BATCH_FILES = 20;
let batchFiles = [];

function setBatchFiles(fileList) {
  batchFiles = Array.from(fileList).slice(0, MAX_BATCH_FILES);
  if (batchFiles.length) {
    batchFileCountEl.hidden = false;
    batchFileCountEl.textContent = `${batchFiles.length} file${batchFiles.length === 1 ? "" : "s"} ready`;
    btnBatchAnalyze.disabled = false;
  } else {
    batchFileCountEl.hidden = true;
    btnBatchAnalyze.disabled = true;
  }
}

batchFileInput.addEventListener("change", () => setBatchFiles(batchFileInput.files));

["dragenter", "dragover"].forEach((eventName) => {
  batchDropzone.addEventListener(eventName, (e) => {
    e.preventDefault();
    batchDropzone.classList.add("drag-over");
  });
});
["dragleave", "dragend"].forEach((eventName) => {
  batchDropzone.addEventListener(eventName, () => batchDropzone.classList.remove("drag-over"));
});
batchDropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  batchDropzone.classList.remove("drag-over");
  setBatchFiles(e.dataTransfer.files);
});

function statusClass(status) {
  return status === "GENUINE" ? "status-good" : status === "SUSPICIOUS" ? "status-warn" : "status-bad";
}

// Feature A + Feature B integration: logs each successfully-analyzed
// batch item to the same local provenance store the single-clip flow
// uses (matched to its source File by array position — the batch
// endpoint returns results in the order the files were sent). Returns
// an array of local ids (or null for failed items) parallel to
// data.results, so the results table can wire up "View history" buttons.
async function recordProvenanceForBatch(data, files) {
  const ids = [];
  for (let i = 0; i < data.results.length; i++) {
    const r = data.results[i];
    const file = files[i];
    if (r.error || !file) {
      ids.push(null);
      continue;
    }
    const record = await recordProvenance({
      blob: file,
      filename: r.filename,
      sourceType: "uploaded",
      provider: r.provider,
      modelVersion: r.model_version,
      riskScore: r.risk_score,
      status: r.status,
      durationSeconds: r.duration_seconds,
    });
    ids.push(record.id);
  }
  return ids;
}

function renderBatchResults(data, localIds) {
  const s = data.summary;
  batchSummaryEl.innerHTML = `
    <span class="batch-summary-chip">Total <strong>${s.total_count}</strong></span>
    <span class="batch-summary-chip good">Genuine <strong>${s.genuine_count}</strong></span>
    <span class="batch-summary-chip warn">Suspicious <strong>${s.suspicious_count}</strong></span>
    <span class="batch-summary-chip bad">AI impersonation <strong>${s.blocked_count}</strong></span>
    <span class="batch-summary-chip">Avg risk score <strong>${s.avg_risk_score ?? "—"}</strong></span>
    ${s.failed_count ? `<span class="batch-summary-chip">Failed <strong>${s.failed_count}</strong></span>` : ""}
  `;

  batchTableBodyEl.innerHTML = data.results.map((r, i) => {
    if (r.error) {
      return `<tr><td>${r.filename || "—"}</td><td colspan="4" class="row-error">${r.error}</td></tr>`;
    }
    const localId = localIds[i];
    return `
      <tr>
        <td>${r.filename}</td>
        <td>${r.risk_score}</td>
        <td class="${statusClass(r.status)}">${formatLabel(r.status)}</td>
        <td><button type="button" class="batch-row-action" data-local-id="${localId || ""}" ${localId ? "" : "disabled"}>View history</button></td>
        <td><button type="button" class="batch-row-action" data-audio-id="${r.audio_id || ""}" ${r.audio_id ? "" : "disabled"}>Report</button></td>
      </tr>
    `;
  }).join("");

  batchTableBodyEl.querySelectorAll(".batch-row-action[data-local-id]").forEach((btn) => {
    if (!btn.dataset.localId) return;
    // Opens the same inline panel the single-clip flow uses, then
    // scrolls it into view since it lives up near the top panel.
    btn.addEventListener("click", () => showProvenancePanel(btn.dataset.localId));
  });

  batchTableBodyEl.querySelectorAll(".batch-row-action[data-audio-id]").forEach((btn) => {
    if (!btn.dataset.audioId) return;
    btn.addEventListener("click", () => generateReport(btn.dataset.audioId, btn));
  });

  btnDownloadReport.href = `${API_BASE_URL}/api/batch/${data.batch_id}/report.csv`;
  btnDownloadReport.onclick = async (event) => {
    event.preventDefault();
    const originalText = btnDownloadReport.textContent;
    btnDownloadReport.textContent = "Preparing CSV…";
    try {
      const response = await fetch(btnDownloadReport.href, { headers: voiceguardAuthHeaders() });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        if (response.status === 401 || response.status === 403) {
          voiceguardUnauthorized(error.detail || "Unauthorized: enter a valid reviewer API key.");
        }
        throw new Error(error.detail || `Download failed (${response.status})`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `voiceguard-batch-${data.batch_id}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      batchProgressTextEl.textContent = `CSV download failed: ${error.message}`;
    } finally {
      btnDownloadReport.textContent = originalText;
    }
  };
  batchResultsEl.hidden = false;
}

btnBatchAnalyze.addEventListener("click", async () => {
  if (!batchFiles.length) return;
  btnBatchAnalyze.disabled = true;
  batchResultsEl.hidden = true;
  batchProgressEl.hidden = false;
  batchProgressFillEl.style.width = "10%";
  batchProgressTextEl.textContent = `Analyzing ${batchFiles.length} file${batchFiles.length === 1 ? "" : "s"}…`;

  // A single request scores the whole batch server-side, so there's no
  // real per-file progress to poll — the bar animates toward (not to)
  // completion while the request is in flight, then snaps to 100%.
  const progressTimer = setInterval(() => {
    const current = parseFloat(batchProgressFillEl.style.width) || 10;
    if (current < 90) batchProgressFillEl.style.width = `${current + (90 - current) * 0.2}%`;
  }, 400);

  try {
    const formData = new FormData();
    batchFiles.forEach((file) => formData.append("files", file, file.name));
    formData.append("provider", selectedProvider);
    const res = await fetch(`${API_BASE_URL}/api/batch-analyze`, { method: "POST", body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Request failed (${res.status})`);
    }
    const data = await res.json();
    const localIds = await recordProvenanceForBatch(data, batchFiles);
    batchProgressFillEl.style.width = "100%";
    batchProgressTextEl.textContent = "Done.";
    renderBatchResults(data, localIds);
  } catch (err) {
    batchProgressTextEl.textContent = `Bulk Scan failed: ${err.message}`;
  } finally {
    clearInterval(progressTimer);
    btnBatchAnalyze.disabled = false;
    setTimeout(() => { batchProgressEl.hidden = true; }, 800);
  }
});

async function checkBackend() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/status`);
    const data = await res.json();
    setBackendText(data.ready ? "Backend ready" : "Backend running, model not ready", data.ready ? "ready" : "warn");
  } catch {
    setBackendText("Backend not reachable", "down");
  }
}
checkBackend();
loadProviderConfig();
