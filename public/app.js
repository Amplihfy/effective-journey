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
let coords = null;           // captured geolocation for the next record
let pendingPhotos = [];      // resized data URLs queued for the next record

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

// Resize/compress an image file in-browser to keep uploads small on cell data.
function fileToDataURL(file, maxDim = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Copied'); }
    catch { toast('Copy failed', true); }
    ta.remove();
  }
}

async function uploadPhotos(recordId, dataUrls) {
  for (const data of dataUrls) {
    await api(`/api/records/${recordId}/photos`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
  }
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

// State for the records viewer.
let currentRecords = [];
let view = 'list';        // 'list' | 'map'
let map = null;           // Leaflet map instance
let markerLayer = null;   // Leaflet layer group for record pins

function hasCoords(r) {
  return r.latitude != null && r.longitude != null;
}

function recordCard(r) {
  const loc = [r.section && `Sec ${esc(r.section)}`, r.plot && `Plot ${esc(r.plot)}`]
    .filter(Boolean).join(' · ');
  const life = [r.birth_date, r.death_date].filter(Boolean).join(' – ');
  return `
    <div class="result" data-id="${r.id}">
      <div class="result-head">
        <span class="result-name">${esc(r.deceased_name)}</span>
        ${loc ? `<span class="result-loc">${loc}</span>` : ''}
      </div>
      ${life ? `<div class="result-meta">${esc(life)}</div>` : ''}
      ${r.notes ? `<div class="result-notes">${esc(r.notes)}</div>` : ''}
      <div class="result-foot">
        <span>${esc(r.session_name || '')}</span>
        <span>${r.photo_count ? `📷 ${r.photo_count} · ` : ''}${hasCoords(r) ? '📍 Located' : 'No location'} ›</span>
      </div>
    </div>`;
}

async function runSearch() {
  const q = $('search').value.trim();
  try {
    currentRecords = await api('/api/records?limit=200&q=' + encodeURIComponent(q));
  } catch (e) {
    currentRecords = [];
    $('results').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    $('viewerInfo').textContent = '';
    return;
  }
  renderViewer();
}

function renderViewer() {
  const q = $('search').value.trim();
  const located = currentRecords.filter(hasCoords).length;
  $('viewerInfo').textContent = currentRecords.length
    ? `${currentRecords.length} record${currentRecords.length === 1 ? '' : 's'}` +
      ` · ${located} with location`
    : '';

  if (view === 'list') {
    $('results').innerHTML = currentRecords.length
      ? currentRecords.map(recordCard).join('')
      : `<div class="empty">${q ? 'No matching records.' : 'No records yet — add one above.'}</div>`;
  } else {
    renderMap();
  }
}

function ensureMap() {
  if (map) return map;
  map = L.map('map', { zoomControl: true }).setView([39.5, -98.35], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  return map;
}

function renderMap() {
  ensureMap();
  markerLayer.clearLayers();
  const located = currentRecords.filter(hasCoords);
  const bounds = [];
  for (const r of located) {
    const m = L.circleMarker([r.latitude, r.longitude], {
      radius: 8, color: '#4f8c3f', fillColor: '#6fae5a', fillOpacity: 0.9, weight: 2,
    });
    const loc = [r.section && `Sec ${esc(r.section)}`, r.plot && `Plot ${esc(r.plot)}`]
      .filter(Boolean).join(' · ');
    m.bindPopup(
      `<b>${esc(r.deceased_name)}</b>${loc ? esc(loc) + '<br>' : ''}` +
      `<a href="#" data-detail="${r.id}">Details ›</a>`
    );
    m.addTo(markerLayer);
    bounds.push([r.latitude, r.longitude]);
  }
  // Leaflet needs a size refresh when shown after being hidden.
  setTimeout(() => {
    map.invalidateSize();
    if (bounds.length === 1) map.setView(bounds[0], 18);
    else if (bounds.length > 1) map.fitBounds(bounds, { padding: [40, 40] });
  }, 0);
}

function setView(next) {
  view = next;
  const isList = next === 'list';
  $('tabList').classList.toggle('active', isList);
  $('tabMap').classList.toggle('active', !isList);
  $('tabList').setAttribute('aria-selected', String(isList));
  $('tabMap').setAttribute('aria-selected', String(!isList));
  $('results').hidden = !isList;
  $('map').hidden = isList;
  renderViewer();
}

// --- Detail modal -----------------------------------------------------------
function openDetail(id) {
  const r = currentRecords.find((x) => String(x.id) === String(id));
  if (!r) return;
  $('dName').textContent = r.deceased_name;

  const rows = [
    ['Section', r.section],
    ['Plot / row', r.plot],
    ['Born', r.birth_date],
    ['Died', r.death_date],
    ['Coordinates', hasCoords(r) ? `${r.latitude.toFixed(5)}, ${r.longitude.toFixed(5)}` : null],
    ['Session', r.session_name],
    ['Recorded by', r.recorded_by],
    ['Added', r.created_at],
  ].filter(([, v]) => v != null && v !== '');
  $('dGrid').innerHTML = rows
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join('');
  $('dNotes').textContent = r.notes || '';

  const actions = [];
  if (hasCoords(r)) {
    actions.push(
      `<a href="https://maps.apple.com/?ll=${r.latitude},${r.longitude}&q=${encodeURIComponent(r.deceased_name)}" target="_blank" rel="noopener">📍 Directions</a>`,
      `<button class="copy-btn" data-copy="${r.latitude}, ${r.longitude}">Copy GPS</button>`
    );
  }
  actions.push(`<button class="del-btn" data-del="${r.id}">Delete record</button>`);
  $('dActions').innerHTML = actions.join('');

  loadDetailPhotos(r.id);
  $('detail').hidden = false;
}

async function loadDetailPhotos(id) {
  const el = $('dPhotos');
  el.innerHTML = '';
  let photos = [];
  try { photos = await api(`/api/records/${id}/photos`); } catch { /* ignore */ }
  el.innerHTML =
    photos
      .map(
        (p) => `<div class="thumb">
          <a href="/api/photos/${p.id}" target="_blank" rel="noopener"><img src="/api/photos/${p.id}" loading="lazy" alt="photo"></a>
          <button class="thumb-del" data-photodel="${p.id}" aria-label="Delete photo">✕</button>
        </div>`
      )
      .join('') +
    `<label class="thumb add" title="Add photo">＋
       <input type="file" accept="image/*" capture="environment" multiple hidden data-detailadd="${id}">
     </label>`;
}

function closeDetail() { $('detail').hidden = true; }

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
      $('geoCopy').hidden = false;
    },
    () => { $('geoStatus').textContent = 'Could not get location.'; $('geoCopy').hidden = true; },
    { enableHighAccuracy: true, timeout: 8000 }
  );
});

$('geoCopy').addEventListener('click', () => {
  if (coords) copyText(`${coords.latitude}, ${coords.longitude}`);
});

// Queue photos for the next record (resized client-side).
$('photoInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const file of files) {
    try { pendingPhotos.push(await fileToDataURL(file)); }
    catch { toast('Could not read a photo', true); }
  }
  renderPhotoPreview();
});

function renderPhotoPreview() {
  $('photoPreview').innerHTML = pendingPhotos
    .map((d, i) => `<div class="thumb"><img src="${d}" alt="photo">
      <button class="thumb-rm" type="button" data-rm="${i}" aria-label="Remove photo">✕</button></div>`)
    .join('');
}

$('photoPreview').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-rm]');
  if (!btn) return;
  pendingPhotos.splice(Number(btn.dataset.rm), 1);
  renderPhotoPreview();
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
    const record = await api(`/api/sessions/${session.id}/records`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (pendingPhotos.length) {
      toast(`Uploading ${pendingPhotos.length} photo(s)…`);
      try { await uploadPhotos(record.id, pendingPhotos); }
      catch (err) { toast('Record saved, but a photo failed', true); }
    }
    e.target.reset();
    coords = null;
    pendingPhotos = [];
    renderPhotoPreview();
    $('geoStatus').textContent = '';
    $('geoCopy').hidden = true;
    toast('Record saved');
    refreshStats();
    runSearch();
  } catch (err) { toast(err.message, true); }
});

// Tap a list card to open its detail view.
$('results').addEventListener('click', (e) => {
  const card = e.target.closest('.result');
  if (card) openDetail(card.dataset.id);
});

// View toggle.
$('tabList').addEventListener('click', () => setView('list'));
$('tabMap').addEventListener('click', () => setView('map'));

// "Details" link inside a map popup.
$('map').addEventListener('click', (e) => {
  const link = e.target.closest('[data-detail]');
  if (!link) return;
  e.preventDefault();
  openDetail(link.dataset.detail);
});

// Detail modal: close, copy, delete record, delete photo.
$('detailClose').addEventListener('click', closeDetail);
$('detail').addEventListener('click', async (e) => {
  if (e.target.id === 'detail') return closeDetail(); // tap backdrop

  const copy = e.target.closest('[data-copy]');
  if (copy) return copyText(copy.dataset.copy);

  const photodel = e.target.closest('[data-photodel]');
  if (photodel) {
    if (!confirm('Delete this photo?')) return;
    try {
      await api(`/api/photos/${photodel.dataset.photodel}`, { method: 'DELETE' });
      const card = photodel.closest('.thumb');
      if (card) card.remove();
      toast('Photo deleted');
      runSearch();
    } catch (err) { toast(err.message, true); }
    return;
  }

  const del = e.target.closest('[data-del]');
  if (!del) return;
  if (!confirm('Delete this record?')) return;
  try {
    await api(`/api/records/${del.dataset.del}`, { method: 'DELETE' });
    closeDetail();
    toast('Record deleted');
    refreshStats();
    runSearch();
  } catch (err) { toast(err.message, true); }
});

// Add photos to an existing record from the detail view.
$('detail').addEventListener('change', async (e) => {
  const input = e.target.closest('[data-detailadd]');
  if (!input) return;
  const id = input.dataset.detailadd;
  const files = [...input.files];
  input.value = '';
  try {
    const urls = [];
    for (const f of files) urls.push(await fileToDataURL(f));
    await uploadPhotos(id, urls);
    await loadDetailPhotos(id);
    toast('Photo added');
    runSearch();
  } catch (err) { toast(err.message, true); }
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

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
