/**
 * Persistent Web Highlighter - Background Service Worker v4.0
 * Auth: Supabase email/password (persistent identity across installs & devices).
 * Security: RLS on user_id = auth.uid(), scoped grants, server-side purge.
 */

'use strict';

const STORAGE_KEY_PREFIX  = 'wh_';
const DEVICE_ID_KEY       = 'wh_device_id';
const SUPABASE_CONFIG_KEY = 'wh_supabase_config';
const LAST_SYNC_KEY       = 'wh_last_sync';
const AUTO_DELETE_KEY     = 'wh_auto_delete_days';
const SYNC_ALARM_NAME     = 'wh_periodic_sync';
const AUTO_DELETE_ALARM   = 'wh_auto_delete';
const TOMBSTONE_KEY       = 'wh_tombstones';
const AUTH_SESSION_KEY    = 'wh_auth_session';
const SYNC_INTERVAL_MINUTES = 5;
const PURGE_AFTER_DAYS      = 30;

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

// ─── Auth Session ─────────────────────────────────────────────────────────────
async function getAuthSession() {
  return new Promise(r => chrome.storage.local.get([AUTH_SESSION_KEY], res => r(res[AUTH_SESSION_KEY] || null)));
}

async function saveAuthSession(session) {
  return new Promise(r => chrome.storage.local.set({ [AUTH_SESSION_KEY]: session }, r));
}

async function clearAuthSession() {
  return new Promise(r => chrome.storage.local.remove([AUTH_SESSION_KEY], r));
}

// ─── Auth: Sign Up ────────────────────────────────────────────────────────────
// Creates a new account with email + password.
// Returns { session, user } on success, throws on failure.
async function signUp(config, email, password) {
  const response = await fetch(`${config.url}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'apikey': config.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.msg || data.error_description || 'Sign-up failed');
  // Supabase may require email confirmation — check session
  if (!data.session) {
    // Account created but email confirmation required
    return { needsConfirmation: true, email };
  }
  await saveAuthSession(data.session);
  return { session: data.session, user: data.user };
}

// ─── Auth: Sign In ────────────────────────────────────────────────────────────
// Signs in with existing credentials. This is the cross-device key —
// the same email/password on any install pulls the same user's highlights.
async function signIn(config, email, password) {
  const response = await fetch(
    `${config.url}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: { 'apikey': config.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.msg || data.error_description || 'Sign-in failed');
  await saveAuthSession(data);
  return data;
}

// ─── Auth: Sign Out ───────────────────────────────────────────────────────────
async function signOut(config) {
  const session = await getAuthSession();
  if (session?.access_token) {
    await fetch(`${config.url}/auth/v1/logout`, {
      method: 'POST',
      headers: {
        'apikey': config.anonKey,
        'Authorization': `Bearer ${session.access_token}`,
      },
    }).catch(() => {}); // best-effort
  }
  await clearAuthSession();
}

// ─── Auth: Ensure Valid Session ───────────────────────────────────────────────
// Returns the current session if valid, refreshes if expired.
// Throws if no session — caller must prompt user to sign in.
async function ensureAuthSession(config) {
  const existing = await getAuthSession();
  if (!existing?.access_token) throw new AuthRequiredError('Not signed in');

  // Check expiry with 60s buffer
  if (existing.expires_at) {
    const expiresAt = existing.expires_at * 1000;
    if (Date.now() < expiresAt - 60_000) return existing;
  }

  // Token expired — refresh
  if (existing.refresh_token) {
    try {
      const refreshed = await refreshSession(config, existing.refresh_token);
      if (refreshed?.access_token) return refreshed;
    } catch (err) {
      console.warn('[PWH] Token refresh failed:', err.message);
    }
  }

  throw new AuthRequiredError('Session expired and could not refresh — please sign in again');
}

async function refreshSession(config, refreshToken) {
  const response = await fetch(`${config.url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'apikey': config.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!response.ok) return null;
  const session = await response.json();
  await saveAuthSession(session);
  return session;
}

class AuthRequiredError extends Error {}
class AuthError extends Error {}

// ─── Tombstone Store ──────────────────────────────────────────────────────────
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
async function supabaseFetch(config, session, path, options = {}) {
  const deviceId = await getOrCreateDeviceId();
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey':        config.anonKey,
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type':  'application/json',
      'Prefer':        options.prefer || 'return=representation',
      'x-device-id':   deviceId,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401) throw new AuthError(`Session invalid (401): ${text}`);
    throw new Error(`Supabase ${options.method||'GET'} ${path} (${response.status}): ${text}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text || !text.trim()) return null;
  return JSON.parse(text);
}

async function supabaseFetchWithRetry(config, path, options = {}) {
  let session = await ensureAuthSession(config);
  try {
    return await supabaseFetch(config, session, path, options);
  } catch (err) {
    if (err instanceof AuthError) {
      // Try refresh once
      if (session.refresh_token) {
        const refreshed = await refreshSession(config, session.refresh_token);
        if (refreshed?.access_token) {
          return await supabaseFetch(config, refreshed, path, options);
        }
      }
      throw new AuthRequiredError('Session could not be refreshed');
    }
    throw err;
  }
}

// ─── Pull: Cloud → Local ──────────────────────────────────────────────────────
async function pullFromSupabase(config) {
  const remote = await supabaseFetchWithRetry(
    config,
    'highlights?select=id,text,selector,position_selector,color,note,tags,timestamp,url,deleted_at&order=timestamp.desc',
    { method: 'GET', prefer: '' }
  );
  if (!remote?.length) return { pulled: 0 };

  const localTombstones = await getTombstones();
  const activeRemote  = remote.filter(r => !r.deleted_at);
  const deletedRemote = remote.filter(r =>  r.deleted_at);

  // Propagate remote deletions to local storage
  if (deletedRemote.length) {
    const deletedIds = new Set(deletedRemote.map(r => r.id));
    await addTombstones(Array.from(deletedIds));
    const allLocal = await new Promise(r => chrome.storage.local.get(null, r));
    const skip = new Set([DEVICE_ID_KEY, SUPABASE_CONFIG_KEY, LAST_SYNC_KEY,
                          AUTO_DELETE_KEY, TOMBSTONE_KEY, AUTH_SESSION_KEY]);
    for (const [key, value] of Object.entries(allLocal)) {
      if (!key.startsWith(STORAGE_KEY_PREFIX) || skip.has(key)) continue;
      if (!Array.isArray(value)) continue;
      const filtered = value.filter(h => !deletedIds.has(h.id));
      if (filtered.length !== value.length) {
        await new Promise(res => chrome.storage.local.set({ [key]: filtered }, res));
      }
    }
  }

  // Merge active remote into local
  const byUrl = {};
  for (const h of activeRemote) {
    if (localTombstones.has(h.id)) continue;
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
      if (localTombstones.has(r.id)) continue;
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
  const deviceId   = await getOrCreateDeviceId();
  const browser    = detectBrowser();
  const tombstones = await getTombstones();
  const session    = await ensureAuthSession(config);
  const userId     = session.user?.id;

  const active = highlights.filter(h => !tombstones.has(h.id));
  if (!active.length) return { pushed: 0 };

  const rows = active.map(h => ({
    id: h.id, text: h.text, selector: h.selector,
    position_selector: h.positionSelector, color: h.color,
    note: h.note || '', tags: h.tags || [],
    timestamp: h.timestamp, url: h.url,
    device_id: deviceId, browser,
    user_id: userId,
    deleted_at: null,
  }));

  await supabaseFetchWithRetry(config, 'highlights', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates',
    body: JSON.stringify(rows),
  });

  return { pushed: active.length };
}

// ─── Delete from Cloud (soft) ─────────────────────────────────────────────────
async function deleteFromSupabase(config, highlightId) {
  await supabaseFetchWithRetry(config, `highlights?id=eq.${encodeURIComponent(highlightId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ deleted_at: new Date().toISOString() }),
    prefer: '',
  });
}

// ─── Purge old soft-deleted records (client fallback) ────────────────────────
async function purgeOldSoftDeletes(config) {
  const cutoff = new Date(Date.now() - PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    await supabaseFetchWithRetry(
      config,
      `highlights?deleted_at=lt.${encodeURIComponent(cutoff)}`,
      { method: 'DELETE', prefer: '' }
    );
  } catch (err) {
    if (!(err instanceof AuthRequiredError)) {
      console.warn('[PWH] Client-side purge failed (non-critical):', err.message);
    }
  }
}

// ─── Re-enforce tombstones ────────────────────────────────────────────────────
async function reEnforceTombstones(config) {
  const tombstones = await getTombstones();
  if (!tombstones.size) return;
  try {
    const remote = await supabaseFetchWithRetry(
      config,
      'highlights?select=id&deleted_at=is.null',
      { method: 'GET', prefer: '' }
    );
    if (!remote?.length) return;
    const toRedelete = remote.filter(r => tombstones.has(r.id));
    for (const r of toRedelete) {
      await deleteFromSupabase(config, r.id).catch(() => {});
    }
  } catch (err) {
    if (!(err instanceof AuthRequiredError)) console.warn('[PWH] Tombstone re-enforce failed:', err.message);
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
    if ([DEVICE_ID_KEY, SUPABASE_CONFIG_KEY, LAST_SYNC_KEY,
         AUTO_DELETE_KEY, AUTH_SESSION_KEY, TOMBSTONE_KEY].includes(key)) continue;
    const kept = value.filter(h => {
      if (h.timestamp < cutoff) { deletedIds.push(h.id); return false; }
      return true;
    });
    if (kept.length !== value.length) {
      await new Promise(r => chrome.storage.local.set({ [key]: kept }, r));
    }
  }

  if (deletedIds.length && config) {
    for (const id of deletedIds) await deleteFromSupabase(config, id).catch(() => {});
  }
}

// ─── Full Sync ────────────────────────────────────────────────────────────────
async function syncAll() {
  const config = await getSupabaseConfig();
  if (!config?.url || !config?.anonKey) return { status: 'not_configured' };

  try {
    await ensureAuthSession(config);
  } catch (err) {
    if (err instanceof AuthRequiredError) return { status: 'auth_required' };
    throw err;
  }

  try {
    const { pulled } = await pullFromSupabase(config);
    await reEnforceTombstones(config);
    const allLocal   = await getAllLocalHighlights();
    const { pushed } = await pushToSupabase(config, allLocal);
    const now = Date.now();
    await new Promise(r => chrome.storage.local.set({ [LAST_SYNC_KEY]: now }, r));
    console.log(`[PWH] Sync: pulled ${pulled}, pushed ${pushed}`);
    return { status: 'ok', pulled, pushed, timestamp: now };
  } catch (err) {
    console.error('[PWH] Sync failed:', err);
    return { status: 'error', error: err.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getAllLocalHighlights() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (all) => {
      const skip = new Set([
        DEVICE_ID_KEY, SUPABASE_CONFIG_KEY, LAST_SYNC_KEY,
        AUTO_DELETE_KEY, TOMBSTONE_KEY, AUTH_SESSION_KEY,
      ]);
      const out = [];
      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(STORAGE_KEY_PREFIX)) continue;
        if (skip.has(key)) continue;
        if (key.startsWith('wh_visited_')) continue;
        if (!Array.isArray(value)) continue;
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
chrome.alarms.create(SYNC_ALARM_NAME,     { periodInMinutes: SYNC_INTERVAL_MINUTES });
chrome.alarms.create(AUTO_DELETE_ALARM,   { periodInMinutes: 60 });
chrome.alarms.create('wh_purge_supabase', { periodInMinutes: 60 * 24 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM_NAME)     syncAll().catch(console.error);
  if (alarm.name === AUTO_DELETE_ALARM)   runAutoDelete().catch(console.error);
  if (alarm.name === 'wh_purge_supabase') {
    getSupabaseConfig().then(cfg => { if (cfg) purgeOldSoftDeletes(cfg).catch(console.error); });
  }
});

// ─── Install / Update ─────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async (details) => {
  await getOrCreateDeviceId();
  if (details.reason === 'install') {
    console.log('[PWH] Installed. Open Options to sign in and sync your highlights.');
    chrome.runtime.openOptionsPage();
  } else if (details.reason === 'update') {
    console.log(`[PWH] Updated to v${chrome.runtime.getManifest().version}`);
    syncAll().catch(console.error);
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'SYNC_NOW') {
    syncAll().then(sendResponse);
    return true;
  }

  if (message.type === 'AUTH_SIGN_UP') {
    getSupabaseConfig().then(config => {
      if (!config) return sendResponse({ status: 'error', error: 'Supabase not configured' });
      signUp(config, message.email, message.password)
        .then(result => {
          if (result.needsConfirmation) return sendResponse({ status: 'needs_confirmation' });
          return syncAll().then(syncResult => sendResponse({ status: 'ok', ...syncResult }));
        })
        .catch(err => sendResponse({ status: 'error', error: err.message }));
    });
    return true;
  }

  if (message.type === 'AUTH_SIGN_IN') {
    getSupabaseConfig().then(config => {
      if (!config) return sendResponse({ status: 'error', error: 'Supabase not configured' });
      signIn(config, message.email, message.password)
        .then(session => {
          console.log('[PWH] Signed in. User ID:', session.user?.id);
          return syncAll();
        })
        .then(syncResult => sendResponse({ status: 'ok', ...syncResult }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
    });
    return true;
  }

  if (message.type === 'AUTH_SIGN_OUT') {
    getSupabaseConfig().then(async config => {
      if (config) await signOut(config);
      else await clearAuthSession();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'SYNC_HIGHLIGHT_SAVE') {
    getSupabaseConfig().then(async config => {
      if (!config) return sendResponse({ status: 'not_configured' });
      try {
        await pushToSupabase(config, [message.highlight]);
        sendResponse({ status: 'ok' });
      } catch (err) {
        sendResponse({ status: 'error', error: err.message });
      }
    });
    return true;
  }

  if (message.type === 'SYNC_HIGHLIGHT_DELETE') {
    addTombstone(message.id).then(() => {
      getSupabaseConfig().then(async config => {
        if (!config) return sendResponse({ status: 'not_configured' });
        try {
          await deleteFromSupabase(config, message.id);
          sendResponse({ status: 'ok' });
        } catch (err) {
          sendResponse({ status: 'error', error: err.message });
        }
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
      getAuthSession(),
    ]).then(([config, lastSync, deviceId, autoDeleteDays, session]) => {
      sendResponse({
        configured:    !!(config?.url && config?.anonKey),
        lastSync,      deviceId,
        browser:       detectBrowser(),
        autoDeleteDays,
        userId:        session?.user?.id  || null,
        userEmail:     session?.user?.email || null,
        authenticated: !!session?.access_token,
      });
    });
    return true;
  }

  if (message.type === 'SAVE_SUPABASE_CONFIG') {
    (async () => {
      await clearAuthSession();
      await new Promise(r => chrome.storage.local.set({ [SUPABASE_CONFIG_KEY]: message.config }, r));
      sendResponse({ status: 'ok' });
    })();
    return true;
  }

  if (message.type === 'CLEAR_SUPABASE_CONFIG') {
    (async () => {
      await signOut(await getSupabaseConfig()).catch(() => {});
      await clearAuthSession();
      await new Promise(r => chrome.storage.local.remove([SUPABASE_CONFIG_KEY], r));
      sendResponse({ ok: true });
    })();
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
    chrome.storage.local.getBytesInUse(null).then(bytes =>
      sendResponse({ bytes, kb: (bytes / 1024).toFixed(1) })
    );
    return true;
  }

  if (message.type === 'BULK_DELETE_IDS') {
    (async () => {
      await addTombstones(message.ids);
      const config = await getSupabaseConfig();
      if (config) {
        for (const id of message.ids) await deleteFromSupabase(config, id).catch(() => {});
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
});

// Startup sync (only if authenticated)
syncAll().catch(console.error);
runAutoDelete().catch(console.error);
getSupabaseConfig().then(cfg => { if (cfg) purgeOldSoftDeletes(cfg).catch(console.error); });
