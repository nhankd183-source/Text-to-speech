"use strict";

// ── State ─────────────────────────────────────────────────────────────────
let voices        = [];
let selectedVoice = { name: "vi-VN-HoaiMyNeural", display: "Hoai My", locale: "vi-VN", gender: "Female" };
let currentUrl    = "";
let currentHistId = "";
let historyItems  = [];
let historyTotal  = 0;
let historySkip   = 0;
const LIMIT       = 30;
let historyOpen   = true;

// Progress tracking
let trackingId   = "";
let listenCount  = 0;
let totalListened= 0;
let lastPos      = 0;
let progressTimer= null;
let globalDlUrl  = "";

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  loadVoices();
  initCharCounter();

  const ta = document.getElementById("text-input");
  ta.addEventListener("keydown", e => { if (e.ctrlKey && e.key === "Enter") generateSpeech(); });

  const ga = document.getElementById("global-audio");
  ga.addEventListener("play",       onGlobalPlay);
  ga.addEventListener("timeupdate", onGlobalTimeUpdate);
  ga.addEventListener("ended",      onGlobalEnded);
  ga.addEventListener("pause",      saveProgress);

  loadHistory();
  fetchHistoryCount();
});

// ── Voice loading ──────────────────────────────────────────────────────────
async function loadVoices() {
  try {
    const res  = await fetch("/api/voices");
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    voices = data.voices;

    if (data.fallback) {
      showStatus("warn",
        "⚠ Microsoft API tạm thời không phản hồi — đang dùng danh sách giọng dự phòng. " +
        '<a href="#" onclick="retryVoices();return false" style="color:inherit;font-weight:700;text-decoration:underline">Thử lại</a>');
    }

    // Build lang dropdown
    const langSel = document.getElementById("lang-select");
    const locales = {};
    voices.forEach(v => { if (!locales[v.locale]) locales[v.locale] = localeName(v.locale); });

    const sorted = Object.keys(locales).sort((a, b) => {
      if (a === "vi-VN") return -1;
      if (b === "vi-VN") return  1;
      return locales[a].localeCompare(locales[b]);
    });

    langSel.innerHTML = "";
    sorted.forEach(loc => langSel.appendChild(new Option(`${locales[loc]} (${loc})`, loc)));
    langSel.value = sorted.includes("vi-VN") ? "vi-VN" : sorted[0];

    updateVoiceSelect();

    // Restore selected voice
    const voiceSel = document.getElementById("voice-select");
    if (voices.find(v => v.name === selectedVoice.name)) {
      voiceSel.value = selectedVoice.name;
    }
    updateVoiceButton();

  } catch (err) {
    showStatus("error", `Không thể tải giọng đọc: ${err.message}`);
  }
}

async function retryVoices() {
  // Force re-fetch by clearing local state; backend cache stays until restart
  voices = [];
  document.getElementById("lang-select").innerHTML = '<option>Đang tải…</option>';
  document.getElementById("voice-select").innerHTML = '<option>—</option>';
  await loadVoices();
}

function onLanguageChange() {
  updateVoiceSelect();
  onVoiceSelectChange(); // auto-apply first voice of new language
}

function updateVoiceSelect() {
  const locale   = document.getElementById("lang-select").value;
  const sel      = document.getElementById("voice-select");
  const filtered = voices.filter(v => v.locale === locale);
  sel.innerHTML  = "";
  filtered.forEach(v => {
    const icon = v.gender === "Female" ? "♀" : "♂";
    sel.appendChild(new Option(`${icon} ${v.display}`, v.name));
  });
}

// Auto-apply voice whenever the dropdown changes (no need to click "Áp dụng")
function onVoiceSelectChange() {
  const name = document.getElementById("voice-select").value;
  selectedVoice = voices.find(v => v.name === name) || selectedVoice;
  updateVoiceButton();
}

function applyVoice() {
  onVoiceSelectChange();
  closeVoicePanel();
}

function updateVoiceButton() {
  document.getElementById("va-name").textContent = shortName(selectedVoice.display || selectedVoice.name);
  document.getElementById("va-icon").textContent = (selectedVoice.gender === "Female") ? "♀" : "♂";
}

function toggleVoicePanel() {
  const p = document.getElementById("voice-panel");
  p.style.display = p.style.display === "none" ? "" : "none";
}
function closeVoicePanel() { document.getElementById("voice-panel").style.display = "none"; }

// ── Char counter ──────────────────────────────────────────────────────────
function initCharCounter() {
  const ta = document.getElementById("text-input");
  ta.addEventListener("input", () => {
    const n = ta.value.length;
    const fmt = n.toLocaleString("vi-VN");
    document.getElementById("char-top").textContent = fmt + " ký tự";
    document.getElementById("char-current").textContent = fmt;
  });
}

// ── Speed ─────────────────────────────────────────────────────────────────
function onSpeedChange() {} // value read at generate time

// ── Generate speech — streaming ───────────────────────────────────────────
async function generateSpeech() {
  const text = document.getElementById("text-input").value.trim();
  const rate = parseInt(document.getElementById("speed-select").value, 10);

  if (!text) { showStatus("error", "Vui lòng nhập văn bản."); return; }

  closeVoicePanel();
  setLoading(true);
  hideResult();
  showStatus("loading", "⏳ Đang kết nối…");

  try {
    // Step 1: prepare — fast (<100ms), returns streaming token + eventual file URL
    const res  = await fetch("/api/prepare", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ text, voice: selectedVoice.name, rate, volume: 0 }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Lỗi không xác định.");

    // Step 2: point audio player at the streaming URL — plays as bytes arrive
    const player = document.getElementById("audio-player");
    player.src = data.stream_url;
    player.load();

    currentUrl    = data.file_url;   // available on disk after stream completes
    currentHistId = "";

    document.getElementById("ar-title").textContent =
      text.substring(0, 60) + (text.length > 60 ? "…" : "");
    document.getElementById("ar-sub").textContent =
      `${data.chars.toLocaleString("vi-VN")} ký tự · ${shortName(selectedVoice.display)} · đang tạo…`;

    showResult();
    showStatus("success", "🎵 Đang phát — âm thanh được tạo và phát đồng thời!");
    setLoading(false);

    player.play().catch(() => {});

    // After audio finishes loading metadata, update duration display
    player.addEventListener("loadedmetadata", () => {
      const dur = formatDur(player.duration);
      if (dur) {
        document.getElementById("ar-sub").textContent =
          `${data.chars.toLocaleString("vi-VN")} ký tự · ${shortName(selectedVoice.display)} · ${dur}`;
        document.getElementById("duration-val").textContent = dur;
        document.getElementById("duration-info").style.display = "flex";
      }
    }, { once: true });

    // After audio ends: file is saved → refresh history
    player.addEventListener("ended", () => {
      fetchHistoryCount();
      if (historyOpen) { historySkip = 0; historyItems = []; fetchHistory(0, true); }
    }, { once: true });

    // Also refresh history after 5s (covers short texts that finish quickly)
    setTimeout(() => {
      fetchHistoryCount();
      if (historyOpen) { historySkip = 0; historyItems = []; fetchHistory(0, true); }
    }, 5000);

  } catch (err) {
    showStatus("error", `✕ ${err.message}`);
    setLoading(false);
  }
}

function downloadCurrent() {
  if (!currentUrl) return;
  // File might still be saving — try download, browser will retry if not ready yet
  triggerDl(currentUrl, `tts_${Date.now()}.mp3`);
}

// ── History ───────────────────────────────────────────────────────────────
async function loadHistory() {
  historySkip  = 0;
  historyItems = [];
  document.getElementById("hist-loading").style.display = "";
  document.getElementById("hist-empty").style.display   = "none";
  document.getElementById("hist-table").style.display   = "none";
  await fetchHistory(0, true);
}

async function loadMoreHistory() { await fetchHistory(historySkip, false); }

async function fetchHistory(skip, reset) {
  try {
    const res  = await fetch(`/api/history?skip=${skip}&limit=${LIMIT}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    historyItems = reset ? data.items : [...historyItems, ...data.items];
    historyTotal = data.total;
    historySkip  = historyItems.length;
    renderHistory();
  } catch (err) {
    document.getElementById("hist-loading").textContent = `Lỗi: ${err.message}`;
  }
}

function renderHistory() {
  const loading = document.getElementById("hist-loading");
  const empty   = document.getElementById("hist-empty");
  const table   = document.getElementById("hist-table");
  const tbody   = document.getElementById("hist-tbody");
  const pag     = document.getElementById("hist-pagination");
  const pagInfo = document.getElementById("pagination-info");

  loading.style.display = "none";

  const q = (document.getElementById("search-input").value || "").toLowerCase();
  const items = historyItems.filter(it =>
    !q || it.title.toLowerCase().includes(q) ||
    (it.voice_name || "").toLowerCase().includes(q)
  );

  if (!items.length) {
    empty.style.display  = "";
    table.style.display  = "none";
    pag.style.display    = "none";
    return;
  }

  empty.style.display = "none";
  table.style.display = "";

  tbody.innerHTML = items.map(buildRow).join("");

  const hasMore = historyItems.length < historyTotal;
  pag.style.display = hasMore ? "" : "none";
  pagInfo.textContent = `${historyItems.length} / ${historyTotal} mục`;
}

function buildRow(item) {
  const avail  = item.file_available !== false;
  const done   = item.status === "completed";
  const badge  = avail && done ? "completed" : !avail && done ? "expired" :
                 item.status === "processing" ? "processing" : "failed";
  const label  = {completed:"✓ Hoàn thành",expired:"⌛ Hết hạn",processing:"⏳ Đang tạo",failed:"✕ Lỗi"}[badge];
  const dur    = item.duration_seconds ? formatDur(item.duration_seconds) : "—";
  const chars  = (item.character_count || 0).toLocaleString("vi-VN");
  const date   = relDate(item.created_at);
  const vname  = shortName(item.voice_name || item.voice_code || "");
  const vini   = vname.charAt(0).toUpperCase();
  const canAct = done && avail;

  return `<tr id="row-${item._id}">
    <td class="td-check"><input type="checkbox" class="hist-check"/></td>
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
          title="Nghe" ${canAct ? "" : "disabled"}>
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 13.5v-7c0-.41.47-.65.8-.4l4.67 3.5c.27.2.27.6 0 .8l-4.67 3.5c-.33.25-.8.01-.8-.4z"/></svg>
        </button>
        <button class="act-btn" onclick="dlHistory('${escHtml(item.file_url)}')"
          title="Tải xuống" ${canAct ? "" : "disabled"}>
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.59 9H15V4c0-.55-.45-1-1-1h-4c-.55 0-1 .45-1 1v5H7.41c-.89 0-1.34 1.08-.71 1.71l4.59 4.59c.39.39 1.02.39 1.41 0l4.59-4.59c.63-.63.19-1.71-.7-1.71zM5 19c0 .55.45 1 1 1h12c.55 0 1-.45 1-1s-.45-1-1-1H6c-.55 0-1 .45-1 1z"/></svg>
        </button>
        <button class="act-btn danger" onclick="delHistory('${item._id}')" title="Xoá">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>
    </td>
  </tr>`;
}

function playFromHistory(id) {
  const item = historyItems.find(i => i._id === id);
  if (!item || !item.file_available) return;

  stopProgress();
  trackingId    = id;
  listenCount   = 0;
  totalListened = 0;

  const gp = document.getElementById("global-player");
  const ga = document.getElementById("global-audio");
  document.getElementById("gp-title").textContent = item.title;
  document.getElementById("gp-voice").textContent = shortName(item.voice_name || "");
  globalDlUrl = item.file_url;
  document.getElementById("gp-dl").title = "Tải xuống";

  ga.src = item.file_url + "?t=" + Date.now();
  ga.load();
  gp.style.display = "flex";

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

function dlHistory(url) { if (url) triggerDl(url, `tts_${Date.now()}.mp3`); }
function downloadGlobal() { if (globalDlUrl) triggerDl(globalDlUrl, `tts_${Date.now()}.mp3`); }

async function delHistory(id) {
  if (!confirm("Xoá audio này khỏi lịch sử?")) return;
  try {
    const res = await fetch(`/api/history/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json()).error);
    historyItems = historyItems.filter(i => i._id !== id);
    historyTotal = Math.max(0, historyTotal - 1);
    renderHistory();
    if (trackingId === id) closeGlobalPlayer();
    fetchHistoryCount();
  } catch (err) { alert(`Lỗi: ${err.message}`); }
}

function toggleHistory() {
  if (!historyOpen) { historyOpen = true; loadHistory(); }
  // scroll to history
  document.getElementById("history-section").scrollIntoView({ behavior: "smooth" });
}

function toggleHistoryPanel() {
  const body = document.getElementById("history-body");
  const btn  = document.getElementById("collapse-btn");
  historyOpen = !historyOpen;
  body.classList.toggle("collapsed", !historyOpen);
  btn.classList.toggle("collapsed",  !historyOpen);
  if (historyOpen && !historyItems.length) loadHistory();
}

async function fetchHistoryCount() {
  try {
    const r = await fetch("/api/history?skip=0&limit=1");
    const d = await r.json();
    const b = document.getElementById("history-badge");
    if (d.total > 0) { b.textContent = d.total; b.style.display = ""; }
    else b.style.display = "none";
  } catch (_) {}
}

// ── Progress tracking ────────────────────────────────────────────────────
function onGlobalPlay() {
  listenCount++;
  startProgress();
}

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

function startProgress() {
  if (progressTimer) return;
  progressTimer = setInterval(saveProgress, 8000);
}

function stopProgress() { clearInterval(progressTimer); progressTimer = null; }

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

function closeGlobalPlayer() {
  document.getElementById("global-audio").pause();
  stopProgress();
  document.getElementById("global-player").style.display = "none";
  trackingId = "";
}

// ── UI helpers ────────────────────────────────────────────────────────────
function setLoading(on) {
  const btn     = document.getElementById("generate-btn");
  const spinner = document.getElementById("btn-spinner");
  const icon    = document.getElementById("btn-play-icon");
  const label   = document.getElementById("btn-label");
  btn.disabled       = on;
  spinner.style.display = on ? "" : "none";
  icon.style.display    = on ? "none" : "";
  label.textContent     = on ? "Đang tạo…" : "Tạo audio";
}

function showStatus(type, html) {
  const el = document.getElementById("status-msg");
  el.className    = `status-msg ${type}`;
  el.innerHTML    = html;
  el.style.display = "flex";
}

function hideResult() {
  document.getElementById("audio-result").style.display = "none";
  document.getElementById("text-input").classList.remove("with-result");
}
function showResult() {
  document.getElementById("audio-result").style.display = "";
  document.getElementById("text-input").classList.add("with-result");
}

function triggerDl(url, name) {
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ── Formatters ────────────────────────────────────────────────────────────
function formatDur(s) {
  if (!s || s <= 0) return "";
  return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;
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
  // fallback: first 3 words
  return display.split(" ").slice(0, 3).join(" ");
}

function localeName(loc) {
  const m = {
    "vi-VN":"Tiếng Việt","en-US":"English (US)","en-GB":"English (UK)",
    "en-AU":"English (AU)","zh-CN":"中文 简体","zh-TW":"中文 繁體",
    "ja-JP":"日本語","ko-KR":"한국어","fr-FR":"Français","de-DE":"Deutsch",
    "es-ES":"Español (ES)","es-MX":"Español (MX)","it-IT":"Italiano",
    "pt-BR":"Português (BR)","pt-PT":"Português (PT)","ru-RU":"Русский",
    "ar-SA":"العربية","hi-IN":"हिन्दी","th-TH":"ภาษาไทย","id-ID":"Indonesia",
  };
  return m[loc] || loc;
}

function escHtml(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
