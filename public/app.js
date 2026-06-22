'use strict';

const $ = (id) => document.getElementById(id);
const api = (path, opts) =>
  fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts }).then(async (r) => {
    const body = r.status === 204 ? null : await r.json();
    if (!r.ok) throw new Error((body && body.error) || `Request failed (${r.status})`);
    return body;
  });

// Remember the active session across reloads (per device).
const STORE_KEY = 'cemetery.session';
let session = loadSession();
let coords = null; // captured geolocation for the next record

function loadSession() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; }
}
function saveSession(s) {
  session = s;
  if (s) localStorage.setItem(STORE_KEY, JSON.stringify(s));
  else localStorage.removeItem(STORE_KEY);
  renderSession();
}

function detectDevice() {
  return /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
}

function toast(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = 'toast'), 2200);
}

// --- Rendering --------------------------------------------------------------
function renderSession() {
  const active = $('sessionActive');
  const form = $('sessionForm');
  const recordCard = $('recordCard');
  if (session) {
    active.hidden = false;
    form.hidden = true;
    recordCard.hidden = false;
    $('sessionName').textContent = session.name + (session.operator ? ` · ${session.operator}` : '');
  } else {
    active.hidden = true;
    form.hidden = false;
    recordCard.hidden = true;
  }
}

async function refreshStats() {
  try {
    const s = await api('/api/stats');
    $('stats').innerHTML =
      `<span><b>${s.records}</b> records</span>` +
      `<span><b>${s.sessions}</b> sessions</span>` +
      `<span><b>${s.sections}</b> sections</span>`;
  } catch { /* non-fatal */ }
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function recordCard(r) {
  const loc = [r.section && `Sec ${esc(r.section)}`, r.plot && `Plot ${esc(r.plot)}`]
    .filter(Boolean).join(' · ');
  const life = [r.birth_date, r.death_date].filter(Boolean).join(' – ');
  const map = r.latitude != null && r.longitude != null
    ? `<a href="https://maps.apple.com/?ll=${r.latitude},${r.longitude}" target="_blank" rel="noopener">📍 Map</a>`
    : '';
  return `
    <div class="result" data-id="${r.id}">
      <div class="result-head">
        <span class="result-name">${esc(r.deceased_name)}</span>
        ${loc ? `<span class="result-loc">${loc}</span>` : ''}
      </div>
      ${life ? `<div class="result-meta">${esc(life)}</div>` : ''}
      ${r.notes ? `<div class="result-notes">${esc(r.notes)}</div>` : ''}
      <div class="result-foot">
        <span>${esc(r.session_name || '')} ${map}</span>
        <button class="del" data-id="${r.id}">Delete</button>
      </div>
    </div>`;
}

async function runSearch() {
  const q = $('search').value.trim();
  try {
    const rows = await api('/api/records?limit=50&q=' + encodeURIComponent(q));
    $('results').innerHTML = rows.length
      ? rows.map(recordCard).join('')
      : `<div class="empty">${q ? 'No matching records.' : 'No records yet — add one above.'}</div>`;
  } catch (e) {
    $('results').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// --- Events -----------------------------------------------------------------
$('sessionForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const s = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: $('sName').value.trim(),
        operator: $('sOperator').value.trim() || null,
        device: detectDevice(),
      }),
    });
    saveSession(s);
    toast('Session started');
    refreshStats();
  } catch (err) { toast(err.message, true); }
});

$('endSessionBtn').addEventListener('click', async () => {
  if (session) {
    try { await api(`/api/sessions/${session.id}/end`, { method: 'POST' }); } catch { /* ignore */ }
  }
  saveSession(null);
  toast('Session ended');
});

$('geoBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Geolocation not supported', true);
  $('geoStatus').textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      coords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      $('geoStatus').textContent =
        `📍 ${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)} (saved with next record)`;
    },
    () => { $('geoStatus').textContent = 'Could not get location.'; },
    { enableHighAccuracy: true, timeout: 8000 }
  );
});

$('recordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!session) return toast('Start a session first', true);
  const payload = {
    deceased_name: $('deceased_name').value.trim(),
    section: $('section').value.trim() || null,
    plot: $('plot').value.trim() || null,
    birth_date: $('birth_date').value || null,
    death_date: $('death_date').value || null,
    notes: $('notes').value.trim() || null,
    recorded_by: session.operator || null,
    ...(coords || {}),
  };
  try {
    await api(`/api/sessions/${session.id}/records`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    e.target.reset();
    coords = null;
    $('geoStatus').textContent = '';
    toast('Record saved');
    refreshStats();
    runSearch();
  } catch (err) { toast(err.message, true); }
});

$('results').addEventListener('click', async (e) => {
  const btn = e.target.closest('.del');
  if (!btn) return;
  if (!confirm('Delete this record?')) return;
  try {
    await api(`/api/records/${btn.dataset.id}`, { method: 'DELETE' });
    toast('Record deleted');
    refreshStats();
    runSearch();
  } catch (err) { toast(err.message, true); }
});

// Debounced live search.
let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 180);
});

// --- Boot -------------------------------------------------------------------
renderSession();
refreshStats();
runSearch();
