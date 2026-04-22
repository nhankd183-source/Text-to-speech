"use strict";

// ── State ─────────────────────────────────────────────────────────────────
let historyItems  = [];
let historyTotal  = 0;
let historySkip   = 0;
const LIMIT       = 50;
let searchQ       = "";

// Progress tracking
let trackingId    = "";
let listenCount   = 0;
let totalListened = 0;
let lastPos       = 0;
let progressTimer = null;
let globalDlUrl   = "";

// ── Auth ──────────────────────────────────────────────────────────────────
async function doLogout() {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/login";
}
function handle401(res) {
  if (res.status === 401) { window.location.href = "/login"; return true; }
  return false;
}

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const ga = document.getElementById("global-audio");
  ga.addEventListener("play",       onGlobalPlay);
  ga.addEventListener("timeupdate", onGlobalTimeUpdate);
  ga.addEventListener("ended",      onGlobalEnded);
  ga.addEventListener("pause",      saveProgress);
  fetchHistory(0, true);
});

// ── Fetch & render ─────────────────────────────────────────────────────────
function reload() { historySkip = 0; historyItems = []; fetchHistory(0, true); }
function onSearch() { searchQ = document.getElementById("search-input").value.toLowerCase(); renderTable(); }
function loadMore() { fetchHistory(historySkip, false); }

async function fetchHistory(skip, reset) {
  try {
    const res  = await fetch(`/api/history?skip=${skip}&limit=${LIMIT}`);
    if (handle401(res)) return;
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    historyItems  = reset ? data.items : [...historyItems, ...data.items];
    historyTotal  = data.total;
    historySkip   = historyItems.length;
    renderTable();
    updateStats();
  } catch (err) {
    document.getElementById("hist-loading").textContent = `Lỗi: ${err.message}`;
  }
}

function renderTable() {
  const loading = document.getElementById("hist-loading");
  const empty   = document.getElementById("hist-empty");
  const table   = document.getElementById("hist-table");
  const pag     = document.getElementById("hist-pagination");
  const pagInfo = document.getElementById("pagination-info");

  loading.style.display = "none";

  const items = searchQ
    ? historyItems.filter(it =>
        it.title.toLowerCase().includes(searchQ) ||
        (it.voice_name || "").toLowerCase().includes(searchQ))
    : historyItems;

  if (!items.length) {
    empty.style.display = "";
    table.style.display = "none";
    pag.style.display   = "none";
    return;
  }

  empty.style.display = "none";
  table.style.display = "";
  document.getElementById("hist-tbody").innerHTML = items.map(buildRow).join("");

  const hasMore = historyItems.length < historyTotal;
  pag.style.display   = hasMore ? "" : "none";
  pagInfo.textContent = `${historyItems.length} / ${historyTotal} mục`;
}

function updateStats() {
  if (!historyTotal) return;
  document.getElementById("stat-chips").style.display = "flex";
  document.getElementById("stat-total").textContent  = historyTotal.toLocaleString("vi-VN");
  const totalChars = historyItems.reduce((s, i) => s + (i.character_count || 0), 0);
  const totalDur   = historyItems.reduce((s, i) => s + (i.duration_seconds || 0), 0);
  document.getElementById("stat-chars").textContent  = totalChars.toLocaleString("vi-VN");
  document.getElementById("stat-dur").textContent    = formatDur(totalDur) || "—";
}

function buildRow(item) {
  const avail = item.file_available !== false;
  const done  = item.status === "completed";
  const dur   = item.duration_seconds ? formatDur(item.duration_seconds) : "—";
  const chars = (item.character_count || 0).toLocaleString("vi-VN");
  const date  = relDate(item.created_at);
  const vname = shortName(item.voice_name || item.voice_code || "");
  const vini  = vname.charAt(0).toUpperCase();

  return `<tr id="row-${item._id}">
    <td><input type="checkbox" class="hist-check"/></td>
    <td class="hist-title-cell">
      <span class="hist-title" title="${escHtml(item.title)}">${escHtml(item.title)}</span>
      <div class="hist-meta">
        <span>${date}</span>
        <span class="hist-meta-dot">•</span>
        <span>${chars} ký tự</span>
        <span class="hist-meta-dot">•</span>
        <span>${dur}</span>
        <span class="hist-meta-dot">•</span>
        <span>mp3</span>
        ${!avail && done ? '<span class="hist-meta-dot">•</span><span style="color:var(--warn)">⌛ File hết hạn</span>' : ""}
      </div>
    </td>
    <td class="td-voice">
      <div class="voice-cell">
        <div class="voice-cell-avatar">${escHtml(vini)}</div>
        <span class="voice-cell-name" title="${escHtml(vname)}">${escHtml(vname)}</span>
      </div>
    </td>
    <td class="td-actions">
      <div class="actions-group">
        <button class="act-btn" onclick="playFromHistory('${item._id}')"
          title="${avail ? 'Nghe' : 'Tạo lại và nghe'}" ${done ? "" : "disabled"}>
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 13.5v-7c0-.41.47-.65.8-.4l4.67 3.5c.27.2.27.6 0 .8l-4.67 3.5c-.33.25-.8.01-.8-.4z"/></svg>
        </button>
        <button class="act-btn" onclick="dlHistory('${item._id}')"
          title="Tải xuống" ${done ? "" : "disabled"}>
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.59 9H15V4c0-.55-.45-1-1-1h-4c-.55 0-1 .45-1 1v5H7.41c-.89 0-1.34 1.08-.71 1.71l4.59 4.59c.39.39 1.02.39 1.41 0l4.59-4.59c.63-.63.19-1.71-.7-1.71zM5 19c0 .55.45 1 1 1h12c.55 0 1-.45 1-1s-.45-1-1-1H6c-.55 0-1 .45-1 1z"/></svg>
        </button>
        <button class="act-btn danger" onclick="delHistory('${item._id}')" title="Xoá">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>
    </td>
  </tr>`;
}

function toggleCheckAll(cb) {
  document.querySelectorAll(".hist-check").forEach(c => c.checked = cb.checked);
}

// ── Actions ───────────────────────────────────────────────────────────────
async function playFromHistory(id) {
  const item = historyItems.find(i => i._id === id);
  if (!item) return;

  stopProgress();
  trackingId    = id;
  listenCount   = 0;
  totalListened = 0;

  const gp = document.getElementById("global-player");
  const ga = document.getElementById("global-audio");
  document.getElementById("gp-title").textContent = item.title;
  document.getElementById("gp-voice").textContent = shortName(item.voice_name || "");
  gp.style.display = "flex";

  if (!item.file_available) {
    try {
      const res  = await fetch("/api/prepare", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          text:   item.original_text,
          voice:  item.voice_code,
          rate:   parseRateStr(item.speed_rate),
          volume: parseRateStr(item.volume_rate),
        }),
      });
      if (handle401(res)) return;
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error);
      globalDlUrl = data.file_url;
      ga.src = data.stream_url;
      ga.load();
      ga.play().catch(() => {});
    } catch (err) {
      alert(`Không thể tạo lại audio: ${err.message}`);
    }
    return;
  }

  globalDlUrl = item.file_url;
  ga.src = item.file_url + "?t=" + Date.now();
  ga.load();

  fetch(`/api/progress/${id}`)
    .then(r => r.json())
    .then(p => {
      if (p.last_position_seconds > 0 && !p.is_completed) {
        ga.currentTime = p.last_position_seconds;
        listenCount    = p.listen_count || 0;
        totalListened  = p.total_listened_seconds || 0;
      }
      ga.play().catch(() => {});
    })
    .catch(() => ga.play().catch(() => {}));
}

async function dlHistory(id) {
  const item = historyItems.find(i => i._id === id);
  if (!item) return;
  if (item.file_available) { triggerDl(item.file_url, `tts_${Date.now()}.mp3`); return; }
  try {
    const res  = await fetch("/api/prepare-download", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        text:   item.original_text,
        voice:  item.voice_code,
        rate:   parseRateStr(item.speed_rate),
        volume: parseRateStr(item.volume_rate),
      }),
    });
    if (handle401(res)) return;
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error);
    window.location.href = data.dl_url;
  } catch (err) { alert(`Không thể tải xuống: ${err.message}`); }
}

async function delHistory(id) {
  if (!confirm("Xoá audio này khỏi lịch sử?")) return;
  try {
    const res = await fetch(`/api/history/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json()).error);
    historyItems = historyItems.filter(i => i._id !== id);
    historyTotal = Math.max(0, historyTotal - 1);
    if (trackingId === id) closeGlobalPlayer();
    renderTable();
    updateStats();
  } catch (err) { alert(`Lỗi: ${err.message}`); }
}

function downloadGlobal() { if (globalDlUrl) triggerDl(globalDlUrl, `tts_${Date.now()}.mp3`); }

function closeGlobalPlayer() {
  document.getElementById("global-audio").pause();
  stopProgress();
  document.getElementById("global-player").style.display = "none";
  trackingId = "";
}

// ── Progress tracking ────────────────────────────────────────────────────
function onGlobalPlay() { listenCount++; startProgress(); }
function onGlobalTimeUpdate() {
  const ga = document.getElementById("global-audio");
  if (!ga.paused) {
    const delta = ga.currentTime - lastPos;
    if (delta > 0 && delta < 2) totalListened += delta;
  }
  lastPos = ga.currentTime;
}
function onGlobalEnded() {
  stopProgress();
  if (!trackingId) return;
  fetch(`/api/progress/${trackingId}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ last_position_seconds: 0, total_listened_seconds: totalListened,
                           listen_count: listenCount, is_completed: true }),
  }).catch(() => {});
}
function startProgress() { if (progressTimer) return; progressTimer = setInterval(saveProgress, 8000); }
function stopProgress()  { clearInterval(progressTimer); progressTimer = null; }
function saveProgress() {
  if (!trackingId) return;
  const ga = document.getElementById("global-audio");
  fetch(`/api/progress/${trackingId}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ last_position_seconds: ga.currentTime,
                           total_listened_seconds: totalListened,
                           listen_count: listenCount, is_completed: false }),
  }).catch(() => {});
}

// ── Formatters ────────────────────────────────────────────────────────────
function parseRateStr(s) { if (!s) return 0; return parseInt(s.replace("%", ""), 10) || 0; }

function formatDur(s) {
  if (!s || s <= 0) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
  return `${m}:${String(sec).padStart(2,"0")}`;
}

function relDate(iso) {
  if (!iso) return "—";
  const d = (Date.now() - new Date(iso)) / 1000;
  if (d < 60)     return "Vừa xong";
  if (d < 3600)   return `${Math.floor(d/60)} phút trước`;
  if (d < 86400)  return `${Math.floor(d/3600)} giờ trước`;
  if (d < 172800) return "Hôm qua";
  return new Date(iso).toLocaleDateString("vi-VN");
}

function shortName(display) {
  if (!display) return "—";
  const m = display.match(/Microsoft\s+(.+?)\s+Online/i);
  if (m) return m[1];
  return display.split(" ").slice(0, 3).join(" ");
}

function escHtml(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function triggerDl(url, name) {
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
