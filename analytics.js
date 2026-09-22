// Risk Trends & Analytics Dashboard — reads GET /analytics/summary
// (backend/main.py -> db.get_analytics_summary) and renders metric
// cards, a canvas bar chart of the daily risk trend, and a top-scam-
// keywords table. No build step / chart library: plain canvas drawing,
// matching the approach already used for the waveform/frequency canvases
// on the main page.
(function initAnalyticsPanel() {

  const API_BASE_URL = window.VOICEGUARD_API_URL || (
    window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost"
      ? "http://127.0.0.1:8000"
      : window.location.origin
  );

  let analyticsApiKey = "";
  const analyticsKeyInput = document.getElementById("analytics-api-key");
  const analyticsKeyStatus = document.getElementById("analytics-api-key-status");
  analyticsKeyInput?.addEventListener("input", () => {
    analyticsApiKey = analyticsKeyInput.value.trim();
    if (typeof setVoiceguardApiKey === "function") setVoiceguardApiKey(analyticsApiKey);
    loadAnalytics();
  });
  window.addEventListener("voiceguard:api-key-changed", () => {
    analyticsApiKey = typeof getVoiceguardApiKey === "function" ? getVoiceguardApiKey() : "";
    loadAnalytics();
  });
  function analyticsAuthHeaders() {
    const key = analyticsApiKey || (typeof getVoiceguardApiKey === "function" ? getVoiceguardApiKey() : "");
    return key ? { "X-API-Key": key } : {};
  }
  function analyticsUnauthorized(message) {
    const target = analyticsKeyStatus || document.getElementById("api-key-status");
    if (target) { target.hidden = false; target.textContent = message; }
  }

// Mirrors CLASSIFICATION_LABELS in backend/main.py and script.js so this
// page's copy always matches what the rest of the app shows.
const CLASSIFICATION_LABELS = {
  GENUINE: "Likely Genuine",
  SUSPICIOUS: "Possibly Synthetic",
  AI_IMPERSONATION: "Likely AI Clone",
};

const backendDot = document.getElementById("backend-dot");
const backendText = document.getElementById("backend-text");

const metricTotalEl = document.getElementById("metric-total");
const metricTotalSubEl = document.getElementById("metric-total-sub");
const metricSuspiciousPctEl = document.getElementById("metric-suspicious-pct");
const metricSuspiciousSubEl = document.getElementById("metric-suspicious-sub");
const metricAvgRiskEl = document.getElementById("metric-avg-risk");
const metricAvgRiskSubEl = document.getElementById("metric-avg-risk-sub");
const metricAiCloneEl = document.getElementById("metric-ai-clone");
const metricAiCloneSubEl = document.getElementById("metric-ai-clone-sub");

const trendCanvas = document.getElementById("trend-chart");
const trendCtx = trendCanvas.getContext("2d");
const trendEmptyEl = document.getElementById("trend-empty");

const keywordTableWrapEl = document.getElementById("keyword-table-wrap");
const keywordTableBodyEl = document.getElementById("keyword-table-body");
const keywordEmptyEl = document.getElementById("keyword-empty");
const keywordCountBadgeEl = document.getElementById("keyword-count-badge");
const riskDonutEl = document.getElementById("risk-donut");
const postureScoreEl = document.getElementById("posture-score");
const postureCaptionEl = document.getElementById("posture-caption");
const postureGenuineEl = document.getElementById("posture-genuine");
const postureSuspiciousEl = document.getElementById("posture-suspicious");
const postureCloneEl = document.getElementById("posture-clone");
const insightCopyEl = document.getElementById("insight-copy");

const analyticsErrorEl = document.getElementById("analytics-error");
const refreshAnalyticsBtn = document.getElementById("btn-refresh-analytics");

function setBackendText(text, state) {
  backendText.textContent = text;
  backendDot.className = `dot ${state || ""}`;
}

async function checkBackend() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/status`);
    const data = await res.json();
    setBackendText(data.ready ? "Backend ready" : "Backend running, model not ready", data.ready ? "ready" : "warn");
  } catch {
    setBackendText("Backend not reachable", "down");
  }
}

function fmtPct(part, total) {
  if (!total) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

function fmtScore(value) {
  return value === null || value === undefined ? "—" : `${value}`;
}

function renderMetricCards(data) {
  const total = data.total_analyses || 0;
  const dist = data.classification_distribution || {};
  const genuine = dist.GENUINE || 0;
  const suspicious = dist.SUSPICIOUS || 0;
  const aiClone = dist.AI_IMPERSONATION || 0;

  metricTotalEl.textContent = total;
  metricTotalSubEl.textContent = total
    ? `${genuine} ${CLASSIFICATION_LABELS.GENUINE.toLowerCase()}`
    : "No analyses yet";

  metricSuspiciousPctEl.textContent = fmtPct(suspicious + aiClone, total);
  metricSuspiciousSubEl.textContent = total
    ? `${suspicious} synthetic · ${aiClone} AI clone`
    : "—";

  metricAvgRiskEl.textContent = fmtScore(data.avg_risk_score?.overall);
  metricAvgRiskSubEl.textContent = total
    ? `7d: ${fmtScore(data.avg_risk_score?.last_7d)} · 30d: ${fmtScore(data.avg_risk_score?.last_30d)}`
    : "—";

  metricAiCloneEl.textContent = aiClone;
  metricAiCloneSubEl.textContent = total ? fmtPct(aiClone, total) + " of all checks" : "—";
  renderPosture(data, { total, genuine, suspicious, aiClone });
}

function renderPosture(data, counts) {
  const { total, genuine, suspicious, aiClone } = counts;
  const score = data.avg_risk_score?.overall;
  postureScoreEl.textContent = score === null || score === undefined ? "—" : Math.round(score);
  postureGenuineEl.textContent = total ? fmtPct(genuine, total) : "—";
  postureSuspiciousEl.textContent = total ? fmtPct(suspicious, total) : "—";
  postureCloneEl.textContent = total ? fmtPct(aiClone, total) : "—";
  if (!total) {
    riskDonutEl.style.background = "conic-gradient(var(--line) 0 360deg)";
    postureCaptionEl.textContent = "No completed analyses in this reporting window.";
    insightCopyEl.textContent = "Run a scan to establish the first risk baseline.";
    return;
  }
  const genuineEnd = genuine / total * 360;
  const suspiciousEnd = (genuine + suspicious) / total * 360;
  riskDonutEl.style.background = `conic-gradient(var(--good) 0deg ${genuineEnd}deg, var(--warn) ${genuineEnd}deg ${suspiciousEnd}deg, var(--bad) ${suspiciousEnd}deg 360deg)`;
  postureCaptionEl.textContent = score >= 75 ? "High-risk activity is dominating the current posture." : score >= 40 ? "The current mix warrants a closer reviewer look." : "Most activity is currently sitting in the genuine range.";
  insightCopyEl.textContent = aiClone ? `${aiClone} likely AI clone${aiClone === 1 ? "" : "s"} detected. Prioritize those clips for escalation.` : "No likely AI clone verdicts in this window. Keep monitoring language signals.";
}

function toneForScore(score) {
  if (score < 40) return "#4fa876"; // good
  if (score < 75) return "#f2b705"; // warn
  return "#e8432b"; // bad
}

function drawEmptyTrendAxis() {
  const { width, height } = trendCanvas;
  trendCtx.clearRect(0, 0, width, height);
  trendCtx.strokeStyle = "#34303d";
  trendCtx.lineWidth = 1;
  trendCtx.beginPath();
  trendCtx.moveTo(0, height - 20.5);
  trendCtx.lineTo(width, height - 20.5);
  trendCtx.stroke();
}

function drawTrendChart(dailyTrend) {
  const { width, height } = trendCanvas;
  drawEmptyTrendAxis();
  if (!dailyTrend.length) return;

  const padding = { top: 14, bottom: 30, left: 6, right: 6 };
  const chartHeight = height - padding.top - padding.bottom;
  const barSlot = (width - padding.left - padding.right) / dailyTrend.length;
  const barWidth = Math.min(38, barSlot * 0.6);

  trendCtx.textAlign = "center";
  const points = dailyTrend.map((day, i) => {
    const x = padding.left + barSlot * i + barSlot / 2;
    const value = Math.max(0, Math.min(100, Number(day.avg_risk_score) || 0));
    return { x, y: padding.top + chartHeight * (1 - value / 100), value, label: day.date.slice(5) };
  });
  trendCtx.beginPath();
  trendCtx.moveTo(points[0].x, height - padding.bottom);
  points.forEach((p) => trendCtx.lineTo(p.x, p.y));
  trendCtx.lineTo(points[points.length - 1].x, height - padding.bottom);
  trendCtx.closePath();
  const area = trendCtx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
  area.addColorStop(0, "rgba(106,121,255,.28)"); area.addColorStop(1, "rgba(106,121,255,0)");
  trendCtx.fillStyle = area; trendCtx.fill();
  trendCtx.beginPath();
  points.forEach((p, i) => i ? trendCtx.lineTo(p.x, p.y) : trendCtx.moveTo(p.x, p.y));
  trendCtx.strokeStyle = "#6a79ff"; trendCtx.lineWidth = 2.5; trendCtx.stroke();
  points.forEach((p) => {
    trendCtx.beginPath(); trendCtx.arc(p.x, p.y, 4, 0, Math.PI * 2); trendCtx.fillStyle = toneForScore(p.value); trendCtx.fill();
    trendCtx.beginPath(); trendCtx.arc(p.x, p.y, 7, 0, Math.PI * 2); trendCtx.strokeStyle = "rgba(14,12,19,.9)"; trendCtx.lineWidth = 2; trendCtx.stroke();
    trendCtx.fillStyle = "#f1ece3"; trendCtx.font = "600 10px 'IBM Plex Mono', monospace"; trendCtx.fillText(Math.round(p.value), p.x, Math.max(p.y - 10, 12));
    trendCtx.fillStyle = "#6b6478"; trendCtx.font = "10px 'Inter', sans-serif"; trendCtx.fillText(p.label, p.x, height - 8);
  });
}

function renderTrend(dailyTrend) {
  const hasData = dailyTrend && dailyTrend.length > 0;
  trendEmptyEl.hidden = hasData;
  trendCanvas.style.display = hasData ? "block" : "none";
  if (hasData) drawTrendChart(dailyTrend);
}

function renderKeywordTable(topScamKeywords) {
  const hasData = topScamKeywords && topScamKeywords.length > 0;
  keywordEmptyEl.hidden = hasData;
  keywordTableWrapEl.hidden = !hasData;
  if (!hasData) {
    keywordTableBodyEl.innerHTML = "";
    return;
  }
  const maxCount = Math.max(...topScamKeywords.map((k) => k.count));
  keywordCountBadgeEl.textContent = `${topScamKeywords.length} phrase${topScamKeywords.length === 1 ? "" : "s"}`;
  keywordTableBodyEl.innerHTML = topScamKeywords.map((k) => `
    <div class="keyword-list-row"><span>${k.keyword.replace(/_/g, " ")}</span><span class="keyword-volume"><i style="width:${Math.max(6, (k.count / maxCount) * 100)}%"></i></span><b>${k.count}</b></div>
  `).join("");
}

async function loadAnalytics() {
  analyticsErrorEl.hidden = true;
  try {
    const res = await fetch(`${API_BASE_URL}/analytics/summary`, { headers: analyticsAuthHeaders() });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) analyticsUnauthorized("Unauthorized: enter a valid analyst API key.");
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Request failed (${res.status})`);
    }
    const data = await res.json();
    renderMetricCards(data);
    renderTrend(data.daily_trend || []);
    renderKeywordTable(data.top_scam_keywords || []);
  } catch (err) {
    analyticsErrorEl.hidden = false;
    analyticsErrorEl.textContent = `Couldn't load analytics: ${err.message}. Make sure the backend is running (uvicorn main:app --reload).`;
    drawEmptyTrendAxis();
    trendEmptyEl.hidden = false;
    trendCanvas.style.display = "none";
    keywordEmptyEl.hidden = false;
    keywordTableWrapEl.hidden = true;
  }
}

if (refreshAnalyticsBtn) {
  refreshAnalyticsBtn.addEventListener("click", async () => {
    refreshAnalyticsBtn.disabled = true;
    const originalText = refreshAnalyticsBtn.textContent;
    refreshAnalyticsBtn.textContent = "Refreshing…";
    await loadAnalytics();
    refreshAnalyticsBtn.disabled = false;
    refreshAnalyticsBtn.textContent = originalText;
  });
}

checkBackend();
loadAnalytics();
})();
