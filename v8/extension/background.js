/**
 * Web Highlighter - Background Service Worker v2.1
 * Added: auto-delete, note field in sync, auto-delete message handlers
 */

'use strict';

const STORAGE_KEY_PREFIX  = 'wh_';
const DEVICE_ID_KEY       = 'wh_device_id';
const SUPABASE_CONFIG_KEY = 'wh_supabase_config';
const LAST_SYNC_KEY       = 'wh_last_sync';
const AUTO_DELETE_KEY     = 'wh_auto_delete_days';
const SYNC_ALARM_NAME     = 'wh_periodic_sync';
const AUTO_DELETE_ALARM   = 'wh_auto_delete';
const SYNC_INTERVAL_MINUTES = 5;
const TOMBSTONE_KEY         = 'wh_tombstones'; // local set of deleted highlight IDs

// ─── Device Identity ──────────────────────────────────────────────────────────
async function getOrCreateDeviceId() {
  return new Promise((resolve) => {
    chrome.storage.local.get([DEVICE_ID_KEY], (r) => {
      if (r[DEVICE_ID_KEY]) return resolve(r[DEVICE_ID_KEY]);
      const id = `device_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      chrome.storage.local.set({ [DEVICE_ID_KEY]: id }, () => resolve(id));
    });
  });
}

// ─── Supabase Config ──────────────────────────────────────────────────────────
async function getSupabaseConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get([SUPABASE_CONFIG_KEY], (r) => resolve(r[SUPABASE_CONFIG_KEY] || null));
  });
}

// ─── Tombstone Store ─────────────────────────────────────────────────────────
// A local set of IDs that have been deleted on this device.
// Prevents deleted highlights being re-pushed to Supabase from local storage,
// and prevents them being re-imported if another device pushes them back up.

async function getTombstones() {
  return new Promise(r => chrome.storage.local.get([TOMBSTONE_KEY], res => {
    r(new Set(res[TOMBSTONE_KEY] || []));
  }));
}

async function addTombstone(id) {
  const stones = await getTombstones();
  stones.add(id);
  return new Promise(r => chrome.storage.local.set({ [TOMBSTONE_KEY]: Array.from(stones) }, r));
}

async function addTombstones(ids) {
  const stones = await getTombstones();
  ids.forEach(id => stones.add(id));
  return new Promise(r => chrome.storage.local.set({ [TOMBSTONE_KEY]: Array.from(stones) }, r));
}

// ─── Supabase Fetch ───────────────────────────────────────────────────────────
async function supabaseFetch(config, path, options = {}) {
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey': config.anonKey,
      'Authorization': `Bearer ${config.anonKey}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`Supabase ${options.method||'GET'} ${path} (${response.status}): ${await response.text()}`);
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text || !text.trim()) return null;
  return JSON.parse(text);
}

// ─── Pull: Cloud → Local ──────────────────────────────────────────────────────
async function pullFromSupabase(config) {
  // Fetch ALL records — both active and soft-deleted.
  // We need soft-deleted records to propagate deletions to other devices.
  const remote = await supabaseFetch(
    config,
    'highlights?select=id,text,selector,position_selector,color,note,tags,timestamp,url,deleted_at&order=timestamp.desc',
    { method: 'GET', prefer: '' }
  );
  if (!remote?.length) return { pulled: 0 };

  const localTombstones = await getTombstones();

  // Separate into active and deleted buckets
  const activeRemote  = remote.filter(r => !r.deleted_at);
  const deletedRemote = remote.filter(r =>  r.deleted_at);

  // ── Step 1: propagate remote deletions to local storage ──
  // Any record Supabase marks as deleted should be removed locally on ALL devices.
  if (deletedRemote.length) {
    const deletedIds = new Set(deletedRemote.map(r => r.id));

    // Add to local tombstone set so they never get re-pushed
    await addTombstones(Array.from(deletedIds));

    // Remove from local storage across all URL buckets
    const allLocal = await new Promise(r => chrome.storage.local.get(null, r));
    const skip = new Set([DEVICE_ID_KEY, SUPABASE_CONFIG_KEY, LAST_SYNC_KEY,
                          AUTO_DELETE_KEY, TOMBSTONE_KEY]);
    for (const [key, value] of Object.entries(allLocal)) {
      if (!key.startsWith(STORAGE_KEY_PREFIX) || skip.has(key)) continue;
      if (!Array.isArray(value)) continue;
      const filtered = value.filter(h => !deletedIds.has(h.id));
      if (filtered.length !== value.length) {
        await new Promise(res => chrome.storage.local.set({ [key]: filtered }, res));
      }
    }
  }

  // ── Step 2: merge active remote records into local storage ──
  // Skip anything in the local tombstone set — it was deleted on this device.
  const byUrl = {};
  for (const h of activeRemote) {
    if (localTombstones.has(h.id)) continue; // deleted locally — don't resurrect
    if (!byUrl[h.url]) byUrl[h.url] = [];
    byUrl[h.url].push(h);
  }

  let pulled = 0;
  for (const [url, remoteItems] of Object.entries(byUrl)) {
    const key = STORAGE_KEY_PREFIX + url;
    const local = await new Promise(r => chrome.storage.local.get([key], res => r(res[key] || [])));
    const localMap = new Map(local.map(h => [h.id, h]));
    let changed = false;

    for (const r of remoteItems) {
      if (localTombstones.has(r.id)) continue; // double-check
      const l = localMap.get(r.id);
      if (!l || r.timestamp > l.timestamp) {
        localMap.set(r.id, {
          id: r.id, text: r.text, selector: r.selector,
          positionSelector: r.position_selector, color: r.color,
          note: r.note || '', tags: r.tags || [],
          timestamp: r.timestamp, url: r.url,
        });
        changed = true;
        pulled++;
      }
    }

    if (changed) {
      await new Promise(res => chrome.storage.local.set({ [key]: Array.from(localMap.values()) }, res));
    }
  }
  return { pulled };
}

// ─── Push: Local → Cloud ──────────────────────────────────────────────────────
async function pushToSupabase(config, highlights) {
  if (!highlights?.length) return { pushed: 0 };
  const deviceId = await getOrCreateDeviceId();
  const browser  = detectBrowser();
  const tombstones = await getTombstones();

  // Filter out any highlight that was deleted locally — never push tombstoned records
  const active = highlights.filter(h => !tombstones.has(h.id));
  if (!active.length) return { pushed: 0 };

  const rows = active.map(h => ({
    id: h.id, text: h.text, selector: h.selector,
    position_selector: h.positionSelector, color: h.color,
    note: h.note || '', tags: h.tags || [],
    timestamp: h.timestamp, url: h.url,
    device_id: deviceId, browser,
    deleted_at: null,  // marks as active — prevents resurrection on upsert
  }));

  await supabaseFetch(config, 'highlights', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates',
    body: JSON.stringify(rows),
  });

  return { pushed: active.length };
}

// ─── Delete from Cloud (soft) ────────────────────────────────────────────────
async function deleteFromSupabase(config, highlightId) {
  // Soft delete: mark deleted_at instead of hard DELETE.
  // Hard deletes cause resurrection: the periodic pull sees the record is
  // missing from local storage and assumes it came from another device,
  // re-adding it. A deleted_at timestamp means the sync treats it as
  // definitively gone everywhere.
  await supabaseFetch(config, `highlights?id=eq.${encodeURIComponent(highlightId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ deleted_at: new Date().toISOString() }),
    prefer: '',
  });
}

// ─── Purge old soft-deleted records from Supabase ────────────────────────────
// Runs daily. Hard-deletes any record where deleted_at is older than PURGE_AFTER_DAYS.
// This keeps the DB clean without manual intervention while still preventing
// resurrection — the soft-delete tombstone has already propagated to all devices
// well within the grace period.
const PURGE_AFTER_DAYS = 30;

async function purgeOldSoftDeletes(config) {
  const cutoff = new Date(Date.now() - PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    await supabaseFetch(
      config,
      `highlights?deleted_at=lt.${encodeURIComponent(cutoff)}`,
      { method: 'DELETE', prefer: '' }
    );
    console.log(`[WebHighlighter] Purged soft-deleted records older than ${PURGE_AFTER_DAYS} days.`);
  } catch (err) {
    console.warn('[WebHighlighter] Purge failed (non-critical):', err.message);
  }
}

// ─── Full Sync ────────────────────────────────────────────────────────────────
async function syncAll() {
  const config = await getSupabaseConfig();
  if (!config?.url || !config?.anonKey) return { status: 'not_configured' };

  try {
    // Step 1: pull (propagates remote deletions to local storage + tombstones)
    const { pulled } = await pullFromSupabase(config);

    // Step 2: re-enforce local tombstones back to Supabase.
    // Handles the case where another device pushed a deleted record back up.
    // Any ID in our tombstone that exists as an active record in Supabase
    // gets re-soft-deleted here, making the tombstone the authoritative truth.
    await reEnforceTombstones(config);

    // Step 3: push local highlights (tombstone-filtered inside pushToSupabase)
    const allLocal   = await getAllLocalHighlights();
    const { pushed } = await pushToSupabase(config, allLocal);

    const now = Date.now();
    await new Promise(r => chrome.storage.local.set({ [LAST_SYNC_KEY]: now }, r));
    console.log(`[WebHighlighter] Sync: pulled ${pulled}, pushed ${pushed}`);
    return { status: 'ok', pulled, pushed, timestamp: now };
  } catch (err) {
    console.error('[WebHighlighter] Sync failed:', err);
    return { status: 'error', error: err.message };
  }
}

// ─── Re-enforce tombstones → Supabase ────────────────────────────────────────
// If another device pushed a deleted highlight back to Supabase (because it
// hadn't received the deletion yet), this function finds those records and
// re-soft-deletes them. Runs on every sync cycle.
async function reEnforceTombstones(config) {
  const tombstones = await getTombstones();
  if (!tombstones.size) return;

  // Fetch all active records whose IDs match any of our tombstones.
  // We do this by fetching active records and filtering client-side —
  // PostgREST doesn't support IN queries on large sets well.
  const remote = await supabaseFetch(
    config,
    'highlights?select=id&deleted_at=is.null',
    { method: 'GET', prefer: '' }
  );
  if (!remote?.length) return;

  const toRedelete = remote.filter(r => tombstones.has(r.id));
  if (!toRedelete.length) return;

  console.log(`[WebHighlighter] Re-enforcing ${toRedelete.length} tombstone(s) to Supabase`);
  for (const r of toRedelete) {
    await deleteFromSupabase(config, r.id).catch(err =>
      console.warn(`[WebHighlighter] Failed to re-enforce tombstone ${r.id}:`, err.message)
    );
  }
}

// ─── Auto-Delete ──────────────────────────────────────────────────────────────
async function runAutoDelete() {
  const result = await new Promise(r => chrome.storage.local.get([AUTO_DELETE_KEY], r));
  const days = result[AUTO_DELETE_KEY] || 0;
  if (!days) return;

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const all    = await new Promise(r => chrome.storage.local.get(null, r));
  const config = await getSupabaseConfig();
  const deletedIds = [];

  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(STORAGE_KEY_PREFIX) || !Array.isArray(value)) continue;
    if ([DEVICE_ID_KEY, SUPABASE_CONFIG_KEY, LAST_SYNC_KEY, AUTO_DELETE_KEY].includes(key)) continue;

    const kept    = value.filter(h => { if (h.timestamp < cutoff) { deletedIds.push(h.id); return false; } return true; });
    if (kept.length !== value.length) {
      await new Promise(r => chrome.storage.local.set({ [key]: kept }, r));
    }
  }

  if (deletedIds.length) {
    console.log(`[WebHighlighter] Auto-deleted ${deletedIds.length} old highlights`);
    if (config) {
      for (const id of deletedIds) await deleteFromSupabase(config, id).catch(() => {});
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getAllLocalHighlights() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (all) => {
      // TOMBSTONE_KEY must be in skip — it's an array of strings that starts
      // with wh_ and would be mistakenly included as highlight objects, causing
      // the push to send malformed rows to Supabase and fail the entire batch.
      const skip = new Set([
        DEVICE_ID_KEY, SUPABASE_CONFIG_KEY, LAST_SYNC_KEY,
        AUTO_DELETE_KEY, TOMBSTONE_KEY,
      ]);
      const out = [];
      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(STORAGE_KEY_PREFIX)) continue;
        if (skip.has(key)) continue;
        if (key.startsWith('wh_visited_')) continue; // reading progress, not highlights
        if (!Array.isArray(value)) continue;
        // Extra guard: only include entries that look like highlight objects
        const highlights = value.filter(h => h && typeof h === 'object' && h.id && h.text);
        out.push(...highlights);
      }
      resolve(out);
    });
  });
}

function detectBrowser() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (ua.includes('Firefox')) return 'firefox';
  if (ua.includes('Edg/'))    return 'edge';
  if (ua.includes('Chrome'))  return 'chrome';
  return 'unknown';
}

// ─── Alarms ───────────────────────────────────────────────────────────────────
chrome.alarms.create(SYNC_ALARM_NAME,    { periodInMinutes: SYNC_INTERVAL_MINUTES });
chrome.alarms.create(AUTO_DELETE_ALARM,  { periodInMinutes: 60 });       // local auto-delete: hourly
chrome.alarms.create('wh_purge_supabase', { periodInMinutes: 60 * 24 }); // remote purge: daily

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM_NAME)       syncAll().catch(console.error);
  if (alarm.name === AUTO_DELETE_ALARM)     runAutoDelete().catch(console.error);
  if (alarm.name === 'wh_purge_supabase') {
    getSupabaseConfig().then(cfg => { if (cfg) purgeOldSoftDeletes(cfg).catch(console.error); });
  }
});

// ─── Install / Update ─────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async (details) => {
  await getOrCreateDeviceId();
  if (details.reason === 'install') {
    console.log('[WebHighlighter] Installed. Open Options to configure Supabase sync.');
  } else if (details.reason === 'update') {
    console.log(`[WebHighlighter] Updated to v${chrome.runtime.getManifest().version}`);
    syncAll().catch(console.error);
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'SYNC_NOW') {
    syncAll().then(sendResponse);
    return true;
  }

  if (message.type === 'SYNC_HIGHLIGHT_SAVE') {
    getSupabaseConfig().then(config => {
      if (!config) return sendResponse({ status: 'not_configured' });
      pushToSupabase(config, [message.highlight])
        .then(() => sendResponse({ status: 'ok' }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
    });
    return true;
  }

  if (message.type === 'SYNC_HIGHLIGHT_DELETE') {
    // Always add to tombstone first — even if Supabase is unreachable,
    // the local tombstone prevents resurrection on the next push.
    addTombstone(message.id).then(() => {
      getSupabaseConfig().then(config => {
        if (!config) return sendResponse({ status: 'not_configured' });
        deleteFromSupabase(config, message.id)
          .then(() => sendResponse({ status: 'ok' }))
          .catch(err => sendResponse({ status: 'error', error: err.message }));
      });
    });
    return true;
  }

  if (message.type === 'GET_ALL_LOCAL_HIGHLIGHTS') {
    getAllLocalHighlights().then(highlights => sendResponse({ highlights }));
    return true;
  }

  if (message.type === 'GET_SYNC_STATUS') {
    Promise.all([
      getSupabaseConfig(),
      new Promise(r => chrome.storage.local.get([LAST_SYNC_KEY], res => r(res[LAST_SYNC_KEY] || null))),
      getOrCreateDeviceId(),
      new Promise(r => chrome.storage.local.get([AUTO_DELETE_KEY], res => r(res[AUTO_DELETE_KEY] || 0))),
    ]).then(([config, lastSync, deviceId, autoDeleteDays]) => {
      sendResponse({
        configured: !!(config?.url && config?.anonKey),
        lastSync, deviceId, browser: detectBrowser(), autoDeleteDays,
      });
    });
    return true;
  }

  if (message.type === 'SAVE_SUPABASE_CONFIG') {
    chrome.storage.local.set({ [SUPABASE_CONFIG_KEY]: message.config }, () => {
      syncAll().then(sendResponse);
    });
    return true;
  }

  if (message.type === 'CLEAR_SUPABASE_CONFIG') {
    chrome.storage.local.remove([SUPABASE_CONFIG_KEY], () => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'SAVE_AUTO_DELETE') {
    chrome.storage.local.set({ [AUTO_DELETE_KEY]: message.days }, () => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'RUN_AUTO_DELETE_NOW') {
    runAutoDelete().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'GET_STORAGE_USAGE') {
    chrome.storage.local.getBytesInUse(null).then(bytes => sendResponse({ bytes, kb: (bytes/1024).toFixed(1) }));
    return true;
  }

  if (message.type === 'HIGHLIGHT_DELETED' || message.type === 'HIGHLIGHT_NOTE_UPDATED') {
    chrome.runtime.sendMessage(message).catch(() => {});
    return false;
  }

  if (message.type === 'BULK_DELETE_IDS') {
    (async () => {
      // Tombstone all IDs first, then soft-delete from Supabase
      await addTombstones(message.ids);
      const config = await getSupabaseConfig();
      if (config) {
        for (const id of message.ids) {
          await deleteFromSupabase(config, id).catch(() => {});
        }
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
});

// Sync on startup
syncAll().catch(console.error);
runAutoDelete().catch(console.error);
getSupabaseConfig().then(cfg => { if (cfg) purgeOldSoftDeletes(cfg).catch(console.error); });
