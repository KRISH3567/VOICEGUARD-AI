// Feature E: server-backed review queue and incident case management.
const reviewStatusFilterEl = document.getElementById("review-status-filter");
const refreshReviewQueueBtn = document.getElementById("btn-refresh-review-queue");
const reviewQueueStatusEl = document.getElementById("review-queue-status");
const reviewQueueErrorEl = document.getElementById("review-queue-error");
const reviewTableWrapEl = document.getElementById("review-table-wrap");
const reviewTableBodyEl = document.getElementById("review-table-body");
const reviewQueueEmptyEl = document.getElementById("review-queue-empty");
const caseDetailEl = document.getElementById("case-detail");
const caseDetailTitleEl = document.getElementById("case-detail-title");
const caseDetailBodyEl = document.getElementById("case-detail-body");
const caseDetailCloseBtn = document.getElementById("case-detail-close");

function reviewEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[ch]));
}

function reviewLabel(value) {
  return reviewEscape(String(value || "").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()));
}

function reviewTime(timestamp) {
  return timestamp ? new Date(timestamp * 1000).toLocaleString() : "—";
}

function setReviewQueueError(message = "") {
  reviewQueueErrorEl.hidden = !message;
  reviewQueueErrorEl.textContent = message;
}

function renderReviewCases(cases) {
  reviewTableBodyEl.innerHTML = cases.map((item) => `
    <tr>
      <td><strong>${reviewEscape(item.title)}</strong><span class="review-subtext">${reviewEscape(item.filename || "Voice clip")}</span></td>
      <td><span class="review-risk review-risk-${reviewEscape(item.audio_status)}">${reviewEscape(item.risk_score)}/100</span></td>
      <td><span class="review-pill review-priority-${reviewEscape(item.priority)}">${reviewLabel(item.priority)}</span></td>
      <td><span class="review-pill review-status-${reviewEscape(item.status)}">${reviewLabel(item.status)}</span></td>
      <td>${reviewEscape(reviewTime(item.updated_at))}</td>
      <td><button type="button" class="batch-row-action review-open-btn" data-case-id="${reviewEscape(item.id)}">Open</button></td>
    </tr>`).join("");
  reviewTableBodyEl.querySelectorAll(".review-open-btn").forEach((button) => {
    button.addEventListener("click", () => openReviewCase(button.dataset.caseId));
  });
  reviewTableWrapEl.hidden = !cases.length;
  reviewQueueEmptyEl.hidden = Boolean(cases.length);
}

async function loadReviewQueue() {
  const status = reviewStatusFilterEl.value;
  reviewQueueStatusEl.textContent = "Loading review cases…";
  setReviewQueueError();
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const res = await fetch(`${API_BASE_URL}/api/review-cases${query}`, { headers: voiceguardAuthHeaders() });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) voiceguardUnauthorized(err.detail || "Unauthorized: enter a valid reviewer API key.");
      throw new Error(err.detail || `Request failed (${res.status})`);
    }
    const data = await res.json();
    renderReviewCases(data.cases || []);
    reviewQueueStatusEl.textContent = `${data.count || 0} case${data.count === 1 ? "" : "s"}`;
  } catch (err) {
    reviewTableWrapEl.hidden = true;
    reviewQueueEmptyEl.hidden = true;
    reviewQueueStatusEl.textContent = "Unavailable";
    setReviewQueueError(`Couldn't load the shared review queue: ${err.message}`);
  }
}

function closeReviewCase() {
  caseDetailEl.hidden = true;
  caseDetailBodyEl.innerHTML = "";
}

async function openReviewCase(caseId) {
  caseDetailEl.hidden = false;
  caseDetailTitleEl.textContent = "Loading incident case…";
  caseDetailBodyEl.innerHTML = `<p class="muted-note">Loading case details…</p>`;
  try {
    const res = await fetch(`${API_BASE_URL}/api/review-cases/${encodeURIComponent(caseId)}`, { headers: voiceguardAuthHeaders() });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) voiceguardUnauthorized(err.detail || "Unauthorized: enter a valid reviewer API key.");
      throw new Error(err.detail || `Request failed (${res.status})`);
    }
    const data = await res.json();
    renderReviewCaseDetail(data.case, data.notes || []);
    caseDetailEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    caseDetailTitleEl.textContent = "Incident case";
    caseDetailBodyEl.innerHTML = `<p class="review-error">Couldn't load this case: ${reviewEscape(err.message)}</p>`;
  }
}

function renderReviewCaseDetail(item, notes) {
  caseDetailTitleEl.textContent = item.title;
  const notesHtml = notes.length
    ? notes.map((note) => `<li><span>${reviewEscape(note.note)}</span><small>${reviewEscape(reviewTime(note.created_at))}</small></li>`).join("")
    : `<li class="muted-note">No notes yet.</li>`;
  caseDetailBodyEl.innerHTML = `
    <div class="case-facts">
      <span><b>Clip</b>${reviewEscape(item.filename || "Voice clip")}</span>
      <span><b>Risk</b>${reviewEscape(item.risk_score)}/100 · ${reviewLabel(item.audio_status)}</span>
      <span><b>Engine</b>${reviewEscape(item.provider)} · ${reviewEscape(item.model_version)}</span>
    </div>
    <form class="case-form" id="case-update-form">
      <label>Title<input name="title" maxlength="160" required value="${reviewEscape(item.title)}"></label>
      <label>Priority<select name="priority"><option ${item.priority === "LOW" ? "selected" : ""}>LOW</option><option ${item.priority === "MEDIUM" ? "selected" : ""}>MEDIUM</option><option ${item.priority === "HIGH" ? "selected" : ""}>HIGH</option><option ${item.priority === "CRITICAL" ? "selected" : ""}>CRITICAL</option></select></label>
      <label>Status<select name="status"><option ${item.status === "OPEN" ? "selected" : ""}>OPEN</option><option ${item.status === "IN_REVIEW" ? "selected" : ""}>IN_REVIEW</option><option ${item.status === "RESOLVED" ? "selected" : ""}>RESOLVED</option><option ${item.status === "DISMISSED" ? "selected" : ""}>DISMISSED</option></select></label>
      <label>Resolution<textarea name="resolution" maxlength="1000" rows="3" placeholder="Optional outcome or next step">${reviewEscape(item.resolution)}</textarea></label>
      <button class="btn-analyze" type="submit">Save case</button><span class="muted-note" id="case-save-status"></span>
    </form>
    <div class="case-notes"><h4>Reviewer notes</h4><ul>${notesHtml}</ul>
      <form id="case-note-form"><textarea name="note" maxlength="2000" rows="2" placeholder="Add a note for the next reviewer" required></textarea><button class="feedback-btn" type="submit">Add note</button></form>
      <span class="muted-note" id="case-note-status"></span>
    </div>`;

  document.getElementById("case-update-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const statusEl = document.getElementById("case-save-status");
    statusEl.textContent = "Saving…";
    const payload = Object.fromEntries(new FormData(form).entries());
    try {
      const res = await fetch(`${API_BASE_URL}/api/review-cases/${encodeURIComponent(item.id)}`, {
        method: "PATCH", headers: voiceguardAuthHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(payload),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); if (res.status === 401 || res.status === 403) voiceguardUnauthorized(err.detail || "Unauthorized: enter a valid reviewer API key.");
      throw new Error(err.detail || `Request failed (${res.status})`); }
      const updated = await res.json();
      statusEl.textContent = "Saved.";
      renderReviewCaseDetail(updated.case, notes);
      loadReviewQueue();
    } catch (err) { statusEl.textContent = `Couldn't save: ${err.message}`; }
  });

  document.getElementById("case-note-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const statusEl = document.getElementById("case-note-status");
    const note = new FormData(form).get("note");
    statusEl.textContent = "Adding…";
    try {
      const res = await fetch(`${API_BASE_URL}/api/review-cases/${encodeURIComponent(item.id)}/notes`, {
        method: "POST", headers: voiceguardAuthHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ note }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); if (res.status === 401 || res.status === 403) voiceguardUnauthorized(err.detail || "Unauthorized: enter a valid reviewer API key.");
      throw new Error(err.detail || `Request failed (${res.status})`); }
      const result = await res.json();
      renderReviewCaseDetail(item, [result.note, ...notes]);
    } catch (err) { statusEl.textContent = `Couldn't add note: ${err.message}`; }
  });
}

reviewStatusFilterEl.addEventListener("change", loadReviewQueue);
refreshReviewQueueBtn.addEventListener("click", loadReviewQueue);
caseDetailCloseBtn.addEventListener("click", closeReviewCase);
window.addEventListener("voiceguard:api-key-changed", loadReviewQueue);
loadReviewQueue();
