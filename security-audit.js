/* Security Audit & Evidence Integrity — reads the server hash chain. */
(function initSecurityAudit() {
  const API_BASE_URL = window.VOICEGUARD_API_URL || (
    window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost"
      ? "http://127.0.0.1:8000"
      : window.location.origin
  );
  const badge = document.getElementById("audit-integrity-badge");
  const count = document.getElementById("audit-event-count");
  const latestHash = document.getElementById("audit-latest-hash");
  const body = document.getElementById("audit-table-body");
  const error = document.getElementById("audit-error");
  const refresh = document.getElementById("btn-refresh-audit");

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  }

  function render(data) {
    const integrity = data.integrity || {};
    count.textContent = integrity.event_count ?? 0;
    latestHash.textContent = integrity.latest_hash || "GENESIS";
    latestHash.title = integrity.latest_hash || "GENESIS";
    badge.textContent = integrity.valid ? "Chain verified" : `Integrity break at event ${integrity.broken_event_id}`;
    badge.className = `integrity-badge ${integrity.valid ? "is-valid" : "is-broken"}`;
    body.innerHTML = (data.events || []).map((event) => `
      <tr><td>${escapeHtml(new Date(event.created_at * 1000).toLocaleString())}</td><td><strong>${escapeHtml(event.event_type)}</strong></td><td>${escapeHtml(event.actor)}</td><td>${escapeHtml(event.resource_type)}<small>${escapeHtml(event.resource_id)}</small></td><td><code title="${escapeHtml(event.event_hash)}">${escapeHtml(event.event_hash.slice(0, 16))}…</code></td></tr>
    `).join("");
  }

  async function loadAudit() {
    error.hidden = true;
    try {
      const response = await fetch(`${API_BASE_URL}/api/security/audit?limit=50`, { headers: voiceguardAuthHeaders() });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) voiceguardUnauthorized("Unauthorized: enter a valid analyst API key.");
        throw new Error(`Audit request failed (${response.status})`);
      }
      render(await response.json());
    } catch (err) {
      badge.textContent = "Audit unavailable";
      badge.className = "integrity-badge is-broken";
      error.hidden = false;
      error.textContent = `Couldn't verify the security trail: ${err.message}`;
    }
  }

  window.addEventListener("voiceguard:api-key-changed", loadAudit);

  refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    refresh.textContent = "Verifying…";
    await loadAudit();
    refresh.disabled = false;
    refresh.textContent = "Verify trail";
  });
  loadAudit();
})();
