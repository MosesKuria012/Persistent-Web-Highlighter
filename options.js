/**
 * Web Highlighter - Options / Dashboard v3
 * Features: tags filter, reading progress, full dashboard, sorting, bulk delete, auto-delete
 */
(function () {
  'use strict';

  const COLOR_ORDER = ['yellow','blue','green','red','purple','orange','teal','pink'];
  const COLOR_HEX   = { yellow:'#fde68a', blue:'#93c5fd', green:'#6ee7b7', red:'#fca5a5', purple:'#c4b5fd', orange:'#fdba74', teal:'#5eead4', pink:'#f9a8d4' };

  const STORAGE_KEY_PREFIX = 'wh_';
  const VISITED_KEY_PREFIX = 'wh_visited_';

  const SQL = `-- ─────────────────────────────────────────────────────────────
-- Persistent Web Highlighter — Supabase Setup SQL v3
-- Run this entire block in your Supabase SQL Editor.
-- Implements: per-user RLS, anonymous auth, server-side purge.
-- ─────────────────────────────────────────────────────────────

-- Step 1: Create the table
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS highlights (
  id                TEXT PRIMARY KEY,
  text              TEXT NOT NULL,
  selector          JSONB,
  position_selector JSONB,
  color             TEXT NOT NULL DEFAULT 'yellow',
  note              TEXT          DEFAULT '',
  tags              JSONB         DEFAULT '[]',
  timestamp         BIGINT        NOT NULL,
  url               TEXT          NOT NULL,
  device_id         TEXT,
  browser           TEXT,
  deleted_at        TIMESTAMPTZ   DEFAULT NULL,
  user_id           UUID          REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ   DEFAULT NOW()
);

-- Indexes for fast filtering
CREATE INDEX IF NOT EXISTS highlights_url_idx        ON highlights(url);
CREATE INDEX IF NOT EXISTS highlights_timestamp_idx  ON highlights(timestamp DESC);
CREATE INDEX IF NOT EXISTS highlights_user_idx       ON highlights(user_id);
CREATE INDEX IF NOT EXISTS highlights_deleted_at_idx ON highlights(deleted_at)
  WHERE deleted_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- Step 2: Upgrade columns if you have an existing table
-- (safe to run even on a fresh table)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE highlights ADD COLUMN IF NOT EXISTS tags       JSONB       DEFAULT '[]';
ALTER TABLE highlights ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE highlights ADD COLUMN IF NOT EXISTS user_id    UUID        REFERENCES auth.users(id) ON DELETE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- Step 3: Enable Row Level Security (RLS)
-- Each user can only read and modify their own rows.
-- The anon key alone cannot access any data without a valid JWT.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE highlights ENABLE ROW LEVEL SECURITY;

-- Drop old permissive policies if they exist
DROP POLICY IF EXISTS "Allow all"         ON highlights;
DROP POLICY IF EXISTS "device_isolation"  ON highlights;
DROP POLICY IF EXISTS "user_isolation"    ON highlights;

-- New policy: rows are visible/mutable only if user_id = the JWT's subject
CREATE POLICY "user_isolation" ON highlights
  FOR ALL
  USING     (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- Step 4: Scope grants — anon can SELECT/INSERT/UPDATE only.
-- No DELETE (soft deletes use UPDATE), no TRUNCATE, no DDL.
-- ─────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE highlights FROM anon;
REVOKE ALL ON TABLE highlights FROM authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE highlights TO anon;
GRANT SELECT, INSERT, UPDATE ON TABLE highlights TO authenticated;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- Step 5: Server-side purge via pg_cron
-- Deletes soft-deleted rows older than 30 days automatically.
-- Runs at 3am UTC daily — no client needs to be online.
-- ─────────────────────────────────────────────────────────────
-- Enable pg_cron extension (only needed once per project):
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule the purge job:
SELECT cron.schedule(
  'purge-soft-deleted-highlights',
  '0 3 * * *',
  \$\$
    DELETE FROM highlights
    WHERE deleted_at IS NOT NULL
      AND deleted_at < NOW() - INTERVAL '30 days';
  \$\$
);

-- ─────────────────────────────────────────────────────────────
-- Step 6: Insert rate limit (abuse prevention)
-- Prevents a compromised client from flooding the table.
-- Limit: 200 inserts per minute per user.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_insert_rate_limit()
RETURNS TRIGGER LANGUAGE plpgsql AS \$\$
BEGIN
  IF (
    SELECT COUNT(*) FROM highlights
    WHERE user_id   = auth.uid()
      AND created_at > NOW() - INTERVAL '1 minute'
  ) >= 200 THEN
    RAISE EXCEPTION 'Rate limit exceeded: too many inserts in one minute.';
  END IF;
  RETURN NEW;
END;
\$\$;

DROP TRIGGER IF EXISTS highlights_rate_limit ON highlights;
CREATE TRIGGER highlights_rate_limit
  BEFORE INSERT ON highlights
  FOR EACH ROW EXECUTE FUNCTION check_insert_rate_limit();`;

  // ── State ────────────────────────────────────────────────────────────────────
  let allHighlights = [];
  let activeColor   = 'all';
  let activeTag     = '';
  let searchQuery   = '';
  let sortBy        = 'date-desc';
  let activeSidebarFilter = null; // { type: 'domain'|'tag'|'quick', value: string }
  window.__whSetSidebarFilter = (f) => { activeSidebarFilter = f; if(window.buildSidebarDomains) window.buildSidebarDomains(); if(window.buildSidebarTags) window.buildSidebarTags(); if(window.buildSidebarQuickFilters) window.buildSidebarQuickFilters(); renderDashboard(); };

  // ── Init ─────────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    setupTabs();
    setupSQL();
    setupFilters();
    setupSearch();
    setupSort();
    setupBulkDelete();
    setupSyncNow();
    setupSettingsForm();
    setupAutoDelete();
    setupCopyBtn();
    setupViewMode();
    setupSidebarFilters();
    setupSiteControls();
    await Promise.all([loadDashboard(), loadSettings()]);
  });

  // ── Tabs ─────────────────────────────────────────────────────────────────────
  function setupTabs() {
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        switchTab(link.dataset.tab);
      });
    });
  }

  let currentTab = 'dashboard';
  let previousTab = 'dashboard';

  function switchTab(tabName) {
    // Settings button acts as a toggle — click again to go back
    if (tabName === 'settings' && currentTab === 'settings') {
      tabName = previousTab === 'settings' ? 'dashboard' : previousTab;
    }
    previousTab = currentTab;
    currentTab = tabName;

    document.querySelectorAll('.nav-link').forEach(l => {
      l.classList.toggle('active', l.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
    document.getElementById(`tab-${tabName}`)?.classList.remove('hidden');

    // Update settings button icon to show "back" affordance when in settings
    const settingsBtn = document.querySelector('.topbar-icon-btn[data-tab="settings"]');
    if (settingsBtn) {
      if (tabName === 'settings') {
        settingsBtn.title = 'Back to highlights';
        settingsBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
      } else {
        settingsBtn.title = 'Settings';
        settingsBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
      }
    }
  }

  function setupSQL() {
    const pre = document.getElementById('sql-snippet');
    if (pre) pre.textContent = SQL;
  }

  function setupCopyBtn() {
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const text = document.getElementById(btn.dataset.target)?.textContent || '';
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy SQL'; }, 2000);
        });
      });
    });
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────────
  async function loadDashboard() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ALL_LOCAL_HIGHLIGHTS' });
    allHighlights = response?.highlights || [];
    window.__whAllHighlights = allHighlights;
    renderTagFilterBar();
    renderReadingProgress();
    buildSidebarDomains();
    buildSidebarTags();
    buildSidebarQuickFilters();
    updateStatTotal();
    renderDashboard();
    updateSyncStatus();
  }

  function getFilteredHighlights() {
    return allHighlights.filter(h => {
      // Sidebar filter
      if (activeSidebarFilter) {
        const { type, value } = activeSidebarFilter;
        if (type === 'domain') {
          let domain = '(unknown)';
          try { domain = new URL(h.url).hostname; } catch {}
          if (domain !== value) return false;
        } else if (type === 'tag') {
          if (!(h.tags||[]).includes(value)) return false;
        } else if (type === 'quick') {
          if (value === 'today') {
            const start = new Date(); start.setHours(0,0,0,0);
            if (h.timestamp < start.getTime()) return false;
          } else if (value === 'has-notes') {
            if (!(h.note||'').trim()) return false;
          } else if (value === 'untagged') {
            if ((h.tags||[]).length > 0) return false;
          }
        }
      }
      if (activeColor === 'has-notes' && !(h.note||'').trim()) return false;
      if (activeColor === 'no-notes'  &&  (h.note||'').trim()) return false;
      if (!['all','has-notes','no-notes'].includes(activeColor) && h.color !== activeColor) return false;
      if (activeTag && !(h.tags||[]).includes(activeTag)) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!h.text.toLowerCase().includes(q) &&
            !(h.note||'').toLowerCase().includes(q) &&
            !(h.tags||[]).join(' ').toLowerCase().includes(q) &&
            !h.url.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }

  // ── Tag filter bar ─────────────────────────────────────────────────────────────
  function renderTagFilterBar() {
    const bar = document.getElementById('tag-filter-bar');
    if (!bar) return;

    const allTags = [...new Set(allHighlights.flatMap(h => h.tags || []))].sort();
    bar.innerHTML = '';

    if (!allTags.length) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');

    const clearBtn = document.createElement('button');
    clearBtn.className = 'tag-filter-btn' + (!activeTag ? ' active' : '');
    clearBtn.textContent = 'All tags';
    clearBtn.addEventListener('click', () => { activeTag = ''; renderTagFilterBar(); renderDashboard(); });
    bar.appendChild(clearBtn);

    allTags.forEach(tag => {
      const count = allHighlights.filter(h => (h.tags||[]).includes(tag)).length;
      const btn = document.createElement('button');
      btn.className = 'tag-filter-btn' + (activeTag === tag ? ' active' : '');
      btn.innerHTML = `<span class="tag-hash">#</span>${tag} <span class="tag-count">${count}</span>`;
      btn.addEventListener('click', () => { activeTag = tag; renderTagFilterBar(); renderDashboard(); });
      bar.appendChild(btn);
    });
  }

  // ── Reading Progress ──────────────────────────────────────────────────────────
  async function renderReadingProgress() {
    const section = document.getElementById('reading-progress-section');
    if (!section) return;

    // Load all visited data
    const all = await new Promise(r => chrome.storage.local.get(null, r));
    const domains = {};

    for (const [key, val] of Object.entries(all)) {
      if (!key.startsWith(VISITED_KEY_PREFIX)) continue;
      const domain = key.replace(VISITED_KEY_PREFIX, '');
      domains[domain] = val; // { [url]: { lastVisited, title } }
    }

    if (!Object.keys(domains).length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');

    const grid = document.getElementById('progress-grid');
    if (!grid) return;
    grid.innerHTML = '';

    // Build domain cards
    const sorted = Object.entries(domains).sort((a, b) => {
      const aLast = Math.max(...Object.values(a[1]).map(v => v.lastVisited || 0));
      const bLast = Math.max(...Object.values(b[1]).map(v => v.lastVisited || 0));
      return bLast - aLast;
    });

    for (const [domain, pages] of sorted.slice(0, 6)) {
      const pageUrls    = Object.keys(pages);
      const highlighted = [...new Set(allHighlights.filter(h => {
        try { return new URL(h.url).hostname === domain; } catch { return false; }
      }).map(h => h.url))];
      const lastVisited = Math.max(...Object.values(pages).map(v => v.lastVisited || 0));

      const card = document.createElement('div');
      card.className = 'progress-card';

      const favicon = document.createElement('img');
      favicon.className = 'progress-favicon';
      favicon.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
      favicon.onerror = () => { favicon.style.display = 'none'; };

      card.innerHTML = `
        <div class="progress-card-header">
          <span class="progress-domain">${domain}</span>
          <span class="progress-time">${formatTime(lastVisited)}</span>
        </div>
        <div class="progress-stats">
          <span class="progress-stat"><strong>${highlighted.length}</strong> highlighted pages</span>
          <span class="progress-stat"><strong>${pageUrls.length}</strong> visited</span>
        </div>
      `;
      card.querySelector('.progress-card-header').prepend(favicon);
      grid.appendChild(card);
    }
  }

  // ── Main Dashboard Render ─────────────────────────────────────────────────────
  function renderDashboard() {
    const filtered = getFilteredHighlights();
    const total    = allHighlights.length;

    document.getElementById('total-count-label').textContent =
      `${filtered.length} of ${total} highlight${total !== 1 ? 's' : ''}`;

    const visEl = document.getElementById('bulk-visible-count');
    if (visEl) visEl.textContent = filtered.length;

    if (window.__whSelectMode) window.__whSelectMode.setFilterRef(() => getFilteredHighlights());

    // Update active filter chip
    renderActiveFilterChip();

    const container = document.getElementById('domain-groups');
    const empty     = document.getElementById('dashboard-empty');
    container.innerHTML = '';

    if (!filtered.length) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');

    const byDomain = {};
    for (const h of filtered) {
      let domain = '(unknown)';
      try { domain = new URL(h.url).hostname; } catch {}
      if (!byDomain[domain]) byDomain[domain] = [];
      byDomain[domain].push(h);
    }

    sortDomainGroups(Object.entries(byDomain))
      .forEach(([domain, items]) => container.appendChild(renderDomainGroup(domain, items)));
  }

  function sortDomainGroups(entries) {
    switch (sortBy) {
      case 'date-asc':  return entries.sort((a,b) => Math.min(...a[1].map(h=>h.timestamp)) - Math.min(...b[1].map(h=>h.timestamp)));
      case 'domain':    return entries.sort((a,b) => a[0].localeCompare(b[0]));
      default:          return entries.sort((a,b) => Math.max(...b[1].map(h=>h.timestamp)) - Math.max(...a[1].map(h=>h.timestamp)));
    }
  }

  function sortHighlightsInGroup(items) {
    switch (sortBy) {
      case 'date-asc':    return [...items].sort((a,b) => a.timestamp - b.timestamp);
      case 'color':       return [...items].sort((a,b) => COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color));
      case 'notes-first': return [...items].sort((a,b) => {
        const an = (a.note||'').trim().length > 0 ? 1 : 0;
        const bn = (b.note||'').trim().length > 0 ? 1 : 0;
        return bn !== an ? bn - an : b.timestamp - a.timestamp;
      });
      case 'note-alpha':  return [...items].sort((a,b) => (a.note||'').localeCompare(b.note||''));
      default:            return [...items].sort((a,b) => b.timestamp - a.timestamp);
    }
  }

  // ── Domain Group ─────────────────────────────────────────────────────────────
  function renderDomainGroup(domain, items) {
    const group = document.createElement('div');
    group.className = 'domain-group';

    const header = document.createElement('div');
    header.className = 'domain-header';

    const favicon = document.createElement('img');
    favicon.className = 'domain-favicon';
    favicon.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
    favicon.onerror = () => { favicon.style.display = 'none'; };

    const nameEl = document.createElement('span');
    nameEl.className = 'domain-name';
    nameEl.textContent = domain;

    const countEl = document.createElement('span');
    countEl.className = 'domain-count';
    countEl.textContent = `${items.length} highlight${items.length !== 1 ? 's' : ''}`;

    const delBtn = document.createElement('button');
    delBtn.className = 'domain-delete-btn';
    delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg> Delete domain`;
    delBtn.addEventListener('click', () => deleteDomainHighlights(domain, items));

    header.appendChild(favicon);
    header.appendChild(nameEl);
    header.appendChild(countEl);
    header.appendChild(delBtn);

    const cards = document.createElement('div');
    cards.className = 'highlight-cards';
    sortHighlightsInGroup(items).forEach(h => cards.appendChild(renderHighlightCard(h)));

    group.appendChild(header);
    group.appendChild(cards);
    return group;
  }

  // ── Highlight Card ────────────────────────────────────────────────────────────
  function renderHighlightCard(h) {
    const sm   = window.__whSelectMode;
    const inSM = sm?.isActive();

    const card = document.createElement('div');
    card.className = 'highlight-card' + (inSM ? ' selectable' : '') + (inSM && sm.isSelected(h.id) ? ' selected' : '');
    card.dataset.color = h.color;
    card.dataset.id    = h.id;

    if (inSM) {
      const wrap = document.createElement('label');
      wrap.className = 'card-checkbox-wrap';
      wrap.addEventListener('click', e => e.stopPropagation());
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'card-checkbox';
      chk.checked = sm.isSelected(h.id);
      chk.addEventListener('change', () => {
        sm.toggle(h.id);
        card.classList.toggle('selected', sm.isSelected(h.id));
      });
      wrap.appendChild(chk);
      card.appendChild(wrap);
    }

    // Color bar — data-color drives the background via CSS (no inline style)
    // Card also carries data-color for the border-left CSS rule
    const colorBar = document.createElement('div');
    colorBar.className = 'card-color-bar';
    colorBar.dataset.color = h.color;

    const body = document.createElement('div');
    body.className = 'card-body';

    const textEl = document.createElement('div');
    textEl.className = 'card-text';
    textEl.textContent = h.text;
    body.appendChild(textEl);

    // Note
    if ((h.note||'').trim()) {
      const noteEl = document.createElement('div');
      noteEl.className = 'card-note';
      noteEl.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg><span>${escapeHtml(h.note)}</span>`;
      body.appendChild(noteEl);
    }

    // Tags
    if ((h.tags||[]).length) {
      const tagRow = document.createElement('div');
      tagRow.className = 'card-tags';
      h.tags.forEach(tag => {
        const chip = document.createElement('button');
        chip.className = 'card-tag' + (activeTag === tag ? ' active' : '');
        chip.textContent = '#' + tag;
        chip.addEventListener('click', e => {
          e.stopPropagation();
          activeTag = activeTag === tag ? '' : tag;
          renderTagFilterBar();
          renderDashboard();
        });
        tagRow.appendChild(chip);
      });
      body.appendChild(tagRow);
    }

    // Meta
    const meta = document.createElement('div');
    meta.className = 'card-meta';

    let displayUrl = h.url;
    try {
      const u = new URL(h.url);
      displayUrl = u.pathname + (u.search || '');
      if (displayUrl.length > 55) displayUrl = displayUrl.slice(0, 52) + '…';
    } catch {}

    const urlEl = document.createElement('a');
    urlEl.className = 'card-url';
    urlEl.href = h.url;
    urlEl.textContent = displayUrl;
    urlEl.title = h.url;
    urlEl.target = '_blank';
    urlEl.rel = 'noopener noreferrer';
    urlEl.addEventListener('click', e => e.stopPropagation());

    const timeEl = document.createElement('span');
    timeEl.className = 'card-time';
    timeEl.textContent = formatTime(h.timestamp);

    meta.appendChild(urlEl);
    meta.appendChild(timeEl);
    body.appendChild(meta);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const openBtn = document.createElement('button');
    openBtn.className = 'card-action-btn open-btn';
    openBtn.title = 'Open page and scroll to highlight';
    openBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
    openBtn.addEventListener('click', e => { e.stopPropagation(); openAndScrollTo(h); });

    const delBtn = document.createElement('button');
    delBtn.className = 'card-action-btn';
    delBtn.title = 'Delete';
    delBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
    delBtn.addEventListener('click', e => { e.stopPropagation(); deleteSingleHighlight(h.id, h.url); });

    actions.appendChild(openBtn);
    actions.appendChild(delBtn);

    card.addEventListener('click', () => {
      if (sm?.isActive()) {
        sm.toggle(h.id);
        card.classList.toggle('selected', sm.isSelected(h.id));
        const chk = card.querySelector('.card-checkbox');
        if (chk) chk.checked = sm.isSelected(h.id);
      } else {
        openAndScrollTo(h);
      }
    });

    card.appendChild(colorBar);
    card.appendChild(body);
    card.appendChild(actions);
    return card;
  }

  // ── Open & Scroll ─────────────────────────────────────────────────────────────
  async function openAndScrollTo(h) {
    // Always open in a new tab — preserves the user's current context (dashboard)
    const tab = await chrome.tabs.create({ url: h.url, active: true });
    chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
      if (tabId !== tab.id || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { type: 'SCROLL_TO_HIGHLIGHT', id: h.id }).catch(() => {});
      }, 800);
    });
  }

  // ── Delete ────────────────────────────────────────────────────────────────────
  async function deleteSingleHighlight(id, url) {
    const key = STORAGE_KEY_PREFIX + normalizeUrl(url);
    const stored = await new Promise(r => chrome.storage.local.get([key], res => r(res[key] || [])));
    await new Promise(r => chrome.storage.local.set({ [key]: stored.filter(h => h.id !== id) }, r));
    chrome.runtime.sendMessage({ type: 'SYNC_HIGHLIGHT_DELETE', id }).catch(() => {});
    allHighlights = allHighlights.filter(h => h.id !== id);
    window.__whAllHighlights = allHighlights;
    renderTagFilterBar();
    renderDashboard();
  }

  async function deleteDomainHighlights(domain, items) {
    if (!confirm(`Delete all ${items.length} highlight${items.length !== 1 ? 's' : ''} from ${domain}?`)) return;
    const ids = items.map(h => h.id);
    const byUrl = {};
    for (const h of items) {
      const k = STORAGE_KEY_PREFIX + normalizeUrl(h.url);
      if (!byUrl[k]) byUrl[k] = [];
      byUrl[k].push(h.id);
    }
    for (const [key, idsToRemove] of Object.entries(byUrl)) {
      const stored = await new Promise(r => chrome.storage.local.get([key], res => r(res[key] || [])));
      await new Promise(r => chrome.storage.local.set({ [key]: stored.filter(h => !idsToRemove.includes(h.id)) }, r));
    }
    chrome.runtime.sendMessage({ type: 'BULK_DELETE_IDS', ids }).catch(() => {});
    allHighlights = allHighlights.filter(h => !ids.includes(h.id));
    window.__whAllHighlights = allHighlights;
    renderTagFilterBar();
    renderDashboard();
  }

  async function bulkDeleteHighlights(highlights) {
    const ids = highlights.map(h => h.id);
    const byUrl = {};
    for (const h of highlights) {
      const k = STORAGE_KEY_PREFIX + normalizeUrl(h.url);
      if (!byUrl[k]) byUrl[k] = new Set();
      byUrl[k].add(h.id);
    }
    for (const [key, idsSet] of Object.entries(byUrl)) {
      const stored = await new Promise(r => chrome.storage.local.get([key], res => r(res[key] || [])));
      await new Promise(r => chrome.storage.local.set({ [key]: stored.filter(h => !idsSet.has(h.id)) }, r));
    }
    chrome.runtime.sendMessage({ type: 'BULK_DELETE_IDS', ids }).catch(() => {});
    allHighlights = allHighlights.filter(h => !ids.includes(h.id));
    renderTagFilterBar();
    renderDashboard();
  }

  // ── Filters ───────────────────────────────────────────────────────────────────
  function setupFilters() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeColor = btn.dataset.color;
        renderDashboard();
      });
    });
  }

  function setupSearch() {
    const input = document.getElementById('search-input');
    if (!input) return;
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { searchQuery = input.value.trim().toLowerCase(); renderDashboard(); }, 200);
    });
  }

  function setupSort() {
    const select = document.getElementById('sort-select');
    if (!select) return;
    select.addEventListener('change', () => { sortBy = select.value; renderDashboard(); });
  }

  // ── Bulk Delete ───────────────────────────────────────────────────────────────
  function setupBulkDelete() {
    const bulkBtn  = document.getElementById('bulk-btn');
    const bulkMenu = document.getElementById('bulk-menu');
    bulkBtn?.addEventListener('click', e => { e.stopPropagation(); bulkMenu?.classList.toggle('hidden'); });
    document.addEventListener('click', () => bulkMenu?.classList.add('hidden'));

    document.getElementById('bulk-select-mode')?.addEventListener('click', () => {
      bulkMenu?.classList.add('hidden');
      enterSelectMode();
    });

    document.getElementById('bulk-delete-visible')?.addEventListener('click', async () => {
      const f = getFilteredHighlights();
      if (!f.length) return;
      if (!confirm(`Delete ${f.length} highlight${f.length !== 1 ? 's' : ''}?`)) return;
      bulkMenu?.classList.add('hidden');
      await bulkDeleteHighlights(f);
    });

    document.getElementById('bulk-delete-all')?.addEventListener('click', async () => {
      if (!confirm(`Delete ALL ${allHighlights.length} highlights? This cannot be undone.`)) return;
      bulkMenu?.classList.add('hidden');
      await bulkDeleteHighlights(allHighlights);
    });
  }

  // ── Select Mode ────────────────────────────────────────────────────────────────
  let selectModeActive = false;
  const selectedIds    = new Set();

  function enterSelectMode() {
    selectModeActive = true;
    selectedIds.clear();
    document.getElementById('select-toolbar')?.classList.remove('hidden');
    document.getElementById('domain-groups')?.classList.add('select-mode');
    updateSelectUI();
    renderDashboard();
  }

  function exitSelectMode() {
    selectModeActive = false;
    selectedIds.clear();
    document.getElementById('select-toolbar')?.classList.add('hidden');
    document.getElementById('domain-groups')?.classList.remove('select-mode');
    renderDashboard();
  }

  function updateSelectUI() {
    const count = selectedIds.size;
    const label = document.getElementById('select-count-label');
    const btn   = document.getElementById('delete-selected-btn');
    if (label) label.textContent = `${count} selected`;
    if (btn)   btn.disabled = count === 0;
    const chk = document.getElementById('select-all-chk');
    if (chk) {
      const f = getFilteredHighlights();
      chk.indeterminate = count > 0 && count < f.length;
      chk.checked = count > 0 && count === f.length;
    }
  }

  window.__whSelectMode = {
    isActive:   () => selectModeActive,
    isSelected: id => selectedIds.has(id),
    toggle:     id => { selectedIds.has(id) ? selectedIds.delete(id) : selectedIds.add(id); updateSelectUI(); },
    setFilterRef: () => {},
  };

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('cancel-select-btn')?.addEventListener('click', exitSelectMode);
    document.getElementById('select-all-chk')?.addEventListener('change', e => {
      const f = getFilteredHighlights();
      e.target.checked ? f.forEach(h => selectedIds.add(h.id)) : selectedIds.clear();
      updateSelectUI();
      renderDashboard();
    });
    document.getElementById('delete-selected-btn')?.addEventListener('click', async () => {
      const count = selectedIds.size;
      if (!count) return;
      if (!confirm(`Delete ${count} selected highlight${count !== 1 ? 's' : ''}?`)) return;
      const toDelete = allHighlights.filter(h => selectedIds.has(h.id));
      exitSelectMode();
      await bulkDeleteHighlights(toDelete);
    });
  });

  // ── Sync Now ──────────────────────────────────────────────────────────────────
  function setupSyncNow() {
    const btn = document.getElementById('sync-now-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Syncing…';
      const result = await chrome.runtime.sendMessage({ type: 'SYNC_NOW' });
      btn.disabled = false;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Sync now`;
      if (result?.status === 'ok') await loadDashboard();
      updateSyncStatus();
    });
  }

  // ── Settings ──────────────────────────────────────────────────────────────────
  async function loadSettings() {
    const status = await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATUS' });
    const connected = status.configured && status.authenticated;
    document.getElementById('st-connection').textContent = connected ? '✓ Connected & Authenticated' : (status.configured ? '⚠ Configured (auth pending)' : '✗ Not configured');
    document.getElementById('st-connection').style.color = connected ? '#34d399' : (status.configured ? '#fbbf24' : '#f87171');
    document.getElementById('st-last-sync').textContent  = status.lastSync ? formatTime(status.lastSync) : 'Never';
    document.getElementById('st-device').textContent     = status.deviceId || '—';
    document.getElementById('st-browser').textContent    = status.browser  || '—';
    const userIdEl = document.getElementById('st-user-id');
    if (userIdEl) userIdEl.textContent = status.userId ? status.userId.slice(0, 18) + '…' : '—';
    chrome.runtime.sendMessage({ type: 'GET_STORAGE_USAGE' }, r => {
      if (r) document.getElementById('st-storage').textContent = `${r.kb} KB`;
    });
    chrome.storage.local.get(['wh_supabase_config'], result => {
      const cfg = result['wh_supabase_config'];
      if (cfg) {
        const u = document.getElementById('input-url'); if (u) u.value = cfg.url || '';
        const k = document.getElementById('input-key'); if (k) k.value = cfg.anonKey || '';
      }
    });
    const autoSelect = document.getElementById('auto-delete-select');
    if (autoSelect && status.autoDeleteDays !== undefined) autoSelect.value = String(status.autoDeleteDays);
    updateSyncStatus(status);
  }

  function setupSettingsForm() {
    // Toggle visibility buttons (password fields)
    document.querySelectorAll('.toggle-visibility').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        if (!input) return;
        input.type = input.type === 'password' ? 'text' : 'password';
        btn.textContent = input.type === 'password' ? 'Show' : 'Hide';
      });
    });

    // Save Supabase project config (URL + anon key only — no auth yet)
    document.getElementById('save-config-btn')?.addEventListener('click', async () => {
      const url     = document.getElementById('input-url')?.value.trim();
      const anonKey = document.getElementById('input-key')?.value.trim();
      const fb      = document.getElementById('config-feedback');
      if (!url || !anonKey) { showFeedback(fb, 'error', 'Both fields required.'); return; }
      if (!url.startsWith('https://')) { showFeedback(fb, 'error', 'URL must start with https://'); return; }
      const result = await chrome.runtime.sendMessage({ type: 'SAVE_SUPABASE_CONFIG', config: { url, anonKey } });
      if (result?.status === 'ok') {
        showFeedback(fb, 'success', '✓ Project saved. Now sign in or create an account below.');
        await loadSettings();
      } else {
        showFeedback(fb, 'error', `Failed: ${result?.error || 'Check your URL and key.'}`);
      }
    });

    document.getElementById('clear-config-btn')?.addEventListener('click', async () => {
      if (!confirm('Disconnect from Supabase? Your local highlights are kept.')) return;
      await chrome.runtime.sendMessage({ type: 'CLEAR_SUPABASE_CONFIG' });
      showFeedback(document.getElementById('config-feedback'), 'success', 'Disconnected. Highlights remain locally.');
      await loadSettings();
    });

    // Auth tab switching
    document.querySelectorAll('.auth-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.auth-tab-panel').forEach(p => p.classList.add('hidden'));
        tab.classList.add('active');
        document.getElementById(`auth-tab-${tab.dataset.authTab}`)?.classList.remove('hidden');
      });
    });

    // Sign In
    document.getElementById('signin-btn')?.addEventListener('click', async () => {
      const email    = document.getElementById('signin-email')?.value.trim();
      const password = document.getElementById('signin-password')?.value;
      const fb       = document.getElementById('auth-feedback');
      if (!email || !password) { showFeedback(fb, 'error', 'Email and password required.'); return; }
      const btn = document.getElementById('signin-btn');
      btn.disabled = true; btn.textContent = 'Signing in…';
      const result = await chrome.runtime.sendMessage({ type: 'AUTH_SIGN_IN', email, password });
      btn.disabled = false; btn.textContent = 'Sign In & Sync';
      if (result?.status === 'ok') {
        showFeedback(fb, 'success', `✓ Signed in. Pulled ${result.pulled ?? 0} highlights.`);
        await loadSettings();
        await loadDashboard();
      } else {
        showFeedback(fb, 'error', result?.error || 'Sign-in failed. Check your email and password.');
      }
    });

    // Allow Enter key on password field to trigger sign in
    document.getElementById('signin-password')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('signin-btn')?.click();
    });

    // Sign Up
    document.getElementById('signup-btn')?.addEventListener('click', async () => {
      const email    = document.getElementById('signup-email')?.value.trim();
      const password = document.getElementById('signup-password')?.value;
      const confirm  = document.getElementById('signup-confirm')?.value;
      const fb       = document.getElementById('auth-feedback');
      if (!email || !password) { showFeedback(fb, 'error', 'Email and password required.'); return; }
      if (password.length < 8)  { showFeedback(fb, 'error', 'Password must be at least 8 characters.'); return; }
      if (password !== confirm)  { showFeedback(fb, 'error', 'Passwords do not match.'); return; }
      const btn = document.getElementById('signup-btn');
      btn.disabled = true; btn.textContent = 'Creating account…';
      const result = await chrome.runtime.sendMessage({ type: 'AUTH_SIGN_UP', email, password });
      btn.disabled = false; btn.textContent = 'Create Account';
      if (result?.status === 'needs_confirmation') {
        showFeedback(fb, 'success', '✓ Account created! Check your email to confirm, then sign in.');
      } else if (result?.status === 'ok') {
        showFeedback(fb, 'success', `✓ Account created and signed in. Pushed ${result.pushed ?? 0} highlights.`);
        await loadSettings();
        await loadDashboard();
      } else {
        showFeedback(fb, 'error', result?.error || 'Sign-up failed.');
      }
    });

    // Sign Out
    document.getElementById('signout-btn')?.addEventListener('click', async () => {
      if (!confirm('Sign out? Your highlights stay locally. Sign in again to re-sync.')) return;
      await chrome.runtime.sendMessage({ type: 'AUTH_SIGN_OUT' });
      await loadSettings();
    });

    // In-settings sync now button
    document.getElementById('auth-sync-now-btn')?.addEventListener('click', async () => {
      const fb  = document.getElementById('auth-sync-feedback');
      const btn = document.getElementById('auth-sync-now-btn');
      btn.disabled = true;
      showFeedback(fb, 'success', 'Syncing…');
      const result = await chrome.runtime.sendMessage({ type: 'SYNC_NOW' });
      btn.disabled = false;
      if (result?.status === 'ok') {
        showFeedback(fb, 'success', `✓ Pulled ${result.pulled ?? 0}, pushed ${result.pushed ?? 0}.`);
        await loadDashboard();
        await loadSettings();
      } else if (result?.status === 'auth_required') {
        showFeedback(fb, 'error', 'Not signed in — please sign in above.');
      } else {
        showFeedback(fb, 'error', result?.error || 'Sync failed.');
      }
    });
  }

  function setupAutoDelete() {
    document.getElementById('save-auto-delete-btn')?.addEventListener('click', async () => {
      const days = parseInt(document.getElementById('auto-delete-select')?.value || '0', 10);
      const fb   = document.getElementById('auto-delete-feedback');
      await chrome.runtime.sendMessage({ type: 'SAVE_AUTO_DELETE', days });
      showFeedback(fb, 'success', `✓ Auto-delete ${days === 0 ? 'disabled' : `set to ${days} days`}.`);
    });
    document.getElementById('run-auto-delete-btn')?.addEventListener('click', async () => {
      const fb = document.getElementById('auto-delete-feedback');
      showFeedback(fb, 'success', 'Running…');
      await chrome.runtime.sendMessage({ type: 'RUN_AUTO_DELETE_NOW' });
      showFeedback(fb, 'success', '✓ Done.');
      await loadDashboard();
    });
  }

  function showFeedback(el, type, message) {
    if (!el) return;
    el.className = `feedback ${type}`;
    el.textContent = message;
  }

  async function updateSyncStatus(statusArg) {
    const status = statusArg || await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATUS' });
    const badge  = document.getElementById('sync-status-badge');
    const info   = document.getElementById('device-info');
    if (badge) {
      badge.className = `status-badge ${status.configured && status.lastSync ? 'synced' : 'offline'}`;
      badge.textContent = !status.configured ? '⬤ Not configured'
        : status.lastSync ? `⬤ Synced ${formatTime(status.lastSync)}` : '⬤ Pending sync';
    }
    if (info && status.deviceId) info.textContent = `${status.browser} · ${status.deviceId.slice(0,14)}…`;
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────
  function normalizeUrl(url) {
    try { const u = new URL(url); u.hash = ''; return u.toString().replace(/\/$/, ''); } catch { return url; }
  }

  function formatTime(ts) {
    const date = new Date(ts), now = new Date();
    const diffMins  = Math.floor((now - date) / 60000);
    const diffHours = Math.floor((now - date) / 3600000);
    const diffDays  = Math.floor((now - date) / 86400000);
    if (diffMins  <  1) return 'Just now';
    if (diffMins  < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays  <  7) return `${diffDays}d ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (['HIGHLIGHT_DELETED','HIGHLIGHT_NOTE_UPDATED'].includes(msg.type)) loadDashboard();
  });

})();


  // ─── Site Controls ───────────────────────────────────────────────────────────
  const USER_BLOCKED_KEY = 'wh_blocked_domains';

  async function getUserBlockedDomains() {
    return new Promise(r => chrome.storage.local.get([USER_BLOCKED_KEY], res => r(res[USER_BLOCKED_KEY] || [])));
  }

  async function setUserBlockedDomains(list) {
    return new Promise(r => chrome.storage.local.set({ [USER_BLOCKED_KEY]: list }, r));
  }

  function normalizeDomainInput(raw) {
    // Strip protocol, path, trailing slashes — keep just the hostname
    let s = raw.trim().toLowerCase();
    if (s.startsWith('http://') || s.startsWith('https://')) {
      try { s = new URL(s).hostname; } catch {}
    }
    s = s.replace(/^www\./, '').replace(/[/:].*$/, '').trim();
    return s;
  }

  function renderUserBlockedList(list) {
    const container = document.getElementById('user-blocked-list');
    const noMsg     = document.getElementById('no-blocks-msg');
    const countEl   = document.getElementById('user-blocked-count');
    if (!container) return;

    if (countEl) countEl.textContent = `${list.length} site${list.length !== 1 ? 's' : ''}`;

    // Clear except the no-blocks message
    Array.from(container.children).forEach(el => {
      if (el.id !== 'no-blocks-msg') el.remove();
    });

    if (!list.length) {
      noMsg?.classList.remove('hidden');
      return;
    }
    noMsg?.classList.add('hidden');

    list.forEach(domain => {
      const row = document.createElement('div');
      row.className = 'user-blocked-row';

      const img = document.createElement('img');
      img.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
      img.className = 'user-blocked-favicon';
      img.onerror = () => { img.style.display = 'none'; };

      const name = document.createElement('span');
      name.className = 'user-blocked-domain';
      name.textContent = domain;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'user-blocked-remove';
      removeBtn.title = `Re-enable highlighting on ${domain}`;
      removeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      removeBtn.addEventListener('click', async () => {
        const current = await getUserBlockedDomains();
        const updated = current.filter(d => d !== domain);
        await setUserBlockedDomains(updated);
        renderUserBlockedList(updated);
      });

      row.appendChild(img);
      row.appendChild(name);
      row.appendChild(removeBtn);
      container.appendChild(row);
    });
  }

  function setupSiteControls() {
    // Load and render existing user-blocked list
    getUserBlockedDomains().then(renderUserBlockedList);

    // Manual add
    const input   = document.getElementById('block-domain-input');
    const addBtn  = document.getElementById('block-domain-btn');
    const fb      = document.getElementById('block-feedback');

    addBtn?.addEventListener('click', async () => {
      const raw = input?.value || '';
      const domain = normalizeDomainInput(raw);
      if (!domain || !domain.includes('.')) {
        showFeedback(fb, 'error', 'Enter a valid domain, e.g. notion.so');
        return;
      }
      const current = await getUserBlockedDomains();
      if (current.includes(domain)) {
        showFeedback(fb, 'error', `${domain} is already disabled.`);
        return;
      }
      current.push(domain);
      await setUserBlockedDomains(current);
      renderUserBlockedList(current);
      if (input) input.value = '';
      showFeedback(fb, 'success', `✓ Highlighting disabled on ${domain}.`);
    });

    input?.addEventListener('keydown', e => {
      if (e.key === 'Enter') addBtn?.click();
    });
  }

// ═══════════════════════════════════════════════════════════════
// SIDEBAR FILTERING & VIEW MODE (additions — do not remove above)
// ═══════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── View mode ──────────────────────────────────────────────────────────────
  function setupViewMode() {
    // Restore persisted view mode
    const stored = localStorage.getItem('wh_viewMode') || 'grouped';
    applyViewMode(stored);

    // Restore persisted theme
    const storedTheme = localStorage.getItem('wh_theme') || 'dark';
    applyTheme(storedTheme);

    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        applyViewMode(btn.dataset.view);
        localStorage.setItem('wh_viewMode', btn.dataset.view);
      });
    });

    const themeBtn = document.getElementById('theme-toggle-btn');
    themeBtn?.addEventListener('click', () => {
      const current = document.documentElement.dataset.theme || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      localStorage.setItem('wh_theme', next);
    });
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;
    if (theme === 'light') {
      btn.title = 'Switch to dark mode';
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
    } else {
      btn.title = 'Switch to light mode';
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
    }
  }

  function applyViewMode(mode) {
    document.body.classList.remove('view-grouped', 'view-list', 'view-compact');
    document.body.classList.add('view-' + mode);
    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === mode);
    });
  }

  window.setupViewMode = setupViewMode;

  // ── Sidebar state helpers ─────────────────────────────────────────────────
  function setSidebarFilter(filter) {
    // filter = { type, value } or null
    window.__whActiveSidebarFilter = filter;
    // sync to main IIFE's activeSidebarFilter via a custom event
    document.dispatchEvent(new CustomEvent('wh:sidebarfilter', { detail: filter }));
  }

  // ── Active filter chip ────────────────────────────────────────────────────
  function renderActiveFilterChip() {
    const chip = document.getElementById('active-filter-chip');
    if (!chip) return;
    chip.innerHTML = '';
    const f = window.__whActiveSidebarFilter;
    if (!f) return;

    const labels = { domain: '🌐', tag: '#', quick: '⚡' };
    const el = document.createElement('span');
    el.className = 'filter-chip';
    const icon = labels[f.type] || '';
    el.innerHTML = `${icon} ${escSidebar(f.value)} <button class="filter-chip-dismiss" title="Clear filter">×</button>`;
    el.querySelector('.filter-chip-dismiss').addEventListener('click', () => {
      clearSidebarFilter();
    });
    chip.appendChild(el);
  }

  function clearSidebarFilter() {
    setSidebarFilter(null);
    // Reset active states in sidebar
    document.querySelectorAll('.sidebar-domain-item, .sidebar-filter-item, .sidebar-tag-chip').forEach(el => {
      el.classList.remove('active');
    });
    document.getElementById('sidebar-all-btn')?.classList.add('active');
  }

  function escSidebar(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  window.renderActiveFilterChip = renderActiveFilterChip;

  // ── Sidebar: domain list ──────────────────────────────────────────────────
  function buildSidebarDomains() {
    const tree = document.getElementById('domain-tree');
    if (!tree) return;
    tree.innerHTML = '';

    // Get all highlights (unfiltered by sidebar, but apply color/tag/search)
    const base = window.__whAllHighlights || [];
    const domainMap = {};
    for (const h of base) {
      let d = '(unknown)';
      try { d = new URL(h.url).hostname; } catch {}
      if (!domainMap[d]) domainMap[d] = 0;
      domainMap[d]++;
    }

    const sorted = Object.entries(domainMap).sort((a,b) => b[1] - a[1]);
    const active = window.__whActiveSidebarFilter;

    for (const [domain, count] of sorted) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'sidebar-domain-item' +
        (active?.type === 'domain' && active.value === domain ? ' active' : '');
      btn.title = domain;

      const fav = document.createElement('img');
      fav.className = 'sidebar-domain-favicon';
      fav.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
      fav.onerror = () => { fav.style.display = 'none'; };

      const name = document.createElement('span');
      name.className = 'sidebar-domain-name';
      name.textContent = domain;

      const cnt = document.createElement('span');
      cnt.className = 'sidebar-count mono';
      cnt.textContent = count;

      btn.appendChild(fav);
      btn.appendChild(name);
      btn.appendChild(cnt);

      btn.addEventListener('click', () => {
        const isActive = btn.classList.contains('active');
        clearSidebarFilter();
        if (!isActive) {
          btn.classList.add('active');
          document.getElementById('sidebar-all-btn')?.classList.remove('active');
          setSidebarFilter({ type: 'domain', value: domain });
        }
      });

      li.appendChild(btn);
      tree.appendChild(li);
    }
  }

  // ── Sidebar: tag chips ────────────────────────────────────────────────────
  function buildSidebarTags() {
    const container = document.getElementById('sidebar-tags');
    const section   = document.getElementById('sidebar-tags-section');
    if (!container) return;
    container.innerHTML = '';

    const base = window.__whAllHighlights || [];
    const tagMap = {};
    for (const h of base) {
      for (const t of (h.tags || [])) {
        tagMap[t] = (tagMap[t] || 0) + 1;
      }
    }

    const tags = Object.entries(tagMap).sort((a,b) => b[1] - a[1]);
    if (!tags.length) { section?.classList.add('hidden'); return; }
    section?.classList.remove('hidden');

    const active = window.__whActiveSidebarFilter;

    for (const [tag, count] of tags) {
      const btn = document.createElement('button');
      btn.className = 'sidebar-tag-chip' +
        (active?.type === 'tag' && active.value === tag ? ' active' : '');
      btn.innerHTML = `<span class="tag-hash">#</span>${escSidebar(tag)} <span class="sidebar-count mono">${count}</span>`;
      btn.addEventListener('click', () => {
        const isActive = btn.classList.contains('active');
        clearSidebarFilter();
        if (!isActive) {
          btn.classList.add('active');
          document.getElementById('sidebar-all-btn')?.classList.remove('active');
          setSidebarFilter({ type: 'tag', value: tag });
        }
      });
      container.appendChild(btn);
    }
  }

  // ── Sidebar: quick filter counts ──────────────────────────────────────────
  function buildSidebarQuickFilters() {
    const base = window.__whAllHighlights || [];

    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayCount   = base.filter(h => h.timestamp >= todayStart.getTime()).length;
    const notesCount   = base.filter(h => (h.note||'').trim()).length;
    const untaggedCount = base.filter(h => !(h.tags||[]).length).length;

    const qfToday = document.getElementById('qf-today');
    const qfNotes = document.getElementById('qf-has-notes');
    const qfUntag = document.getElementById('qf-untagged');
    if (qfToday) qfToday.textContent = todayCount;
    if (qfNotes) qfNotes.textContent = notesCount;
    if (qfUntag) qfUntag.textContent = untaggedCount;

    const active = window.__whActiveSidebarFilter;
    document.querySelectorAll('.sidebar-filter-item[data-quick]').forEach(btn => {
      const isActive = active?.type === 'quick' && active.value === btn.dataset.quick;
      btn.classList.toggle('active', isActive);
      btn.addEventListener('click', () => {
        const wasActive = btn.classList.contains('active');
        clearSidebarFilter();
        if (!wasActive) {
          btn.classList.add('active');
          document.getElementById('sidebar-all-btn')?.classList.remove('active');
          setSidebarFilter({ type: 'quick', value: btn.dataset.quick });
        }
      });
    });
  }

  // ── Stat total ────────────────────────────────────────────────────────────
  function updateStatTotal() {
    const el = document.getElementById('stat-total');
    if (el) el.textContent = (window.__whAllHighlights || []).length;
  }

  // ── All button ────────────────────────────────────────────────────────────
  function setupSidebarFilters() {
    document.getElementById('sidebar-all-btn')?.addEventListener('click', () => {
      clearSidebarFilter();
    });
    // Listen for sidebar filter changes to re-render
    document.addEventListener('wh:sidebarfilter', (e) => {
      // activeSidebarFilter is in the outer IIFE scope — set it via the exposed setter
      if (window.__whSetSidebarFilter) window.__whSetSidebarFilter(e.detail);
    });
  }

  window.buildSidebarDomains     = buildSidebarDomains;
  window.buildSidebarTags        = buildSidebarTags;
  window.buildSidebarQuickFilters = buildSidebarQuickFilters;
  window.updateStatTotal         = updateStatTotal;
  window.setupSidebarFilters     = setupSidebarFilters;
  window.renderActiveFilterChip  = renderActiveFilterChip;

})();

// ══════════════════════════════════════════════════════════════════════════════
// EXPORT ENGINE
// ══════════════════════════════════════════════════════════════════════════════
(function setupExport() {

  const COLOR_HEX_EXPORT = {
    yellow:'#fde68a', blue:'#93c5fd', green:'#6ee7b7', red:'#fca5a5',
    purple:'#c4b5fd', orange:'#fdba74', teal:'#5eead4', pink:'#f9a8d4',
  };

  // ── Menu toggle ──────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    const exportBtn  = document.getElementById('export-btn');
    const exportMenu = document.getElementById('export-menu');

    exportBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu?.classList.toggle('hidden');
      // Close other menus
      document.getElementById('bulk-menu')?.classList.add('hidden');
    });

    document.addEventListener('click', () => exportMenu?.classList.add('hidden'));

    document.getElementById('export-html')?.addEventListener('click', () => {
      exportMenu?.classList.add('hidden');
      exportHighlights('html');
    });

    document.getElementById('export-pdf')?.addEventListener('click', () => {
      exportMenu?.classList.add('hidden');
      exportHighlights('pdf');
    });
  });

  // ── Main export dispatcher ───────────────────────────────────────────────
  async function exportHighlights(format) {
    const response = await chrome.runtime.sendMessage({ type: 'GET_ALL_LOCAL_HIGHLIGHTS' });
    const highlights = (response?.highlights || []).filter(h => !h.deleted_at);

    if (!highlights.length) {
      alert('No highlights to export.');
      return;
    }

    const html = buildExportHTML(highlights, format === 'pdf');

    if (format === 'html') {
      downloadFile(html, `web-highlights-${datestamp()}.html`, 'text/html');
    } else {
      // PDF: open in a new tab and trigger print dialog
      // The HTML file has a print stylesheet that renders cleanly as PDF
      const blob = new Blob([html], { type: 'text/html' });
      const url  = URL.createObjectURL(blob);
      const tab  = await chrome.tabs.create({ url });

      // Trigger print after page loads
      chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => setTimeout(() => window.print(), 400),
          }).catch(() => {});
        }
      });
    }
  }

  // ── HTML builder ──────────────────────────────────────────────────────────
  function buildExportHTML(highlights, forPrint) {
    const grouped = groupByDomain(highlights);
    const totalCount = highlights.length;
    const exportDate = new Date().toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric'
    });

    const domainSections = Object.entries(grouped).map(([domain, items]) => {
      const sorted = [...items].sort((a, b) => b.timestamp - a.timestamp);
      const cards  = sorted.map(h => buildCard(h)).join('\n');
      return `
        <section class="domain-section">
          <div class="domain-header">
            <img class="favicon" src="https://www.google.com/s2/favicons?domain=${escHtml(domain)}&sz=16" onerror="this.style.display='none'" />
            <span class="domain-name">${escHtml(domain)}</span>
            <span class="domain-count">${items.length} highlight${items.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="cards">${cards}</div>
        </section>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Web Highlights Export — ${exportDate}</title>
  <style>
    /* ── Base ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
      background: #0f0f1e;
      color: #d0d0e8;
      line-height: 1.6;
      padding: 0;
    }

    a { color: #93c5fd; text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* ── Header ── */
    .export-header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16162a 100%);
      border-bottom: 1px solid #2a2a45;
      padding: 40px 48px 32px;
    }

    .export-header-inner {
      max-width: 900px;
      margin: 0 auto;
    }

    .export-logo {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 20px;
    }

    .export-logo svg { flex-shrink: 0; }

    .export-logo-text {
      font-size: 13px;
      font-weight: 600;
      color: #6060a0;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .export-title {
      font-size: 28px;
      font-weight: 700;
      color: #e8e8f8;
      margin-bottom: 8px;
      letter-spacing: -0.02em;
    }

    .export-meta {
      font-size: 13px;
      color: #5050a0;
      display: flex;
      gap: 20px;
    }

    .export-meta span::before {
      content: '·';
      margin-right: 8px;
      opacity: 0.4;
    }
    .export-meta span:first-child::before { content: ''; margin: 0; }

    /* ── Layout ── */
    .export-body {
      max-width: 900px;
      margin: 0 auto;
      padding: 32px 48px 64px;
    }

    /* ── Domain sections ── */
    .domain-section {
      margin-bottom: 36px;
    }

    .domain-header {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 10px 0 8px;
      border-bottom: 1px solid #1e1e38;
      margin-bottom: 10px;
    }

    .favicon {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }

    .domain-name {
      font-size: 13px;
      font-weight: 600;
      color: #8080b8;
    }

    .domain-count {
      font-size: 11px;
      color: #3a3a68;
      margin-left: auto;
    }

    /* ── Cards ── */
    .cards {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .highlight-card {
      display: flex;
      border: 1px solid #1e1e38;
      border-radius: 8px;
      background: #131328;
      overflow: hidden;
    }

    .card-accent {
      width: 4px;
      flex-shrink: 0;
    }

    .card-content {
      flex: 1;
      padding: 12px 16px;
      min-width: 0;
    }

    .card-text {
      font-size: 13px;
      color: #c0c0e0;
      line-height: 1.6;
      margin-bottom: 6px;
    }

    .card-note {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      background: rgba(96, 165, 250, 0.06);
      border-left: 2px solid rgba(96, 165, 250, 0.25);
      border-radius: 0 4px 4px 0;
      padding: 6px 10px;
      margin: 6px 0;
      font-size: 12px;
      color: #7090c0;
      line-height: 1.55;
    }

    .card-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 6px;
    }

    .card-tag {
      font-size: 10px;
      font-weight: 500;
      background: rgba(147, 197, 253, 0.1);
      color: #6080b0;
      border: 1px solid rgba(147, 197, 253, 0.15);
      border-radius: 4px;
      padding: 2px 7px;
    }

    .card-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 8px;
      font-size: 11px;
      color: #30305a;
    }

    .card-meta a {
      color: #40407a;
      max-width: 500px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: inline-block;
    }

    .card-meta a:hover { color: #93c5fd; }

    /* ── Print / PDF styles ── */
    @media print {
      body {
        background: #fff;
        color: #111;
      }

      .export-header {
        background: #fff;
        border-bottom: 2px solid #e0e0e0;
        padding: 24px 32px 20px;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      .export-title { color: #111; }
      .export-meta  { color: #666; }
      .export-logo-text { color: #999; }

      .export-body { padding: 24px 32px 48px; }

      .highlight-card {
        background: #fafafa;
        border-color: #e0e0e0;
        break-inside: avoid;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      .card-text   { color: #1a1a1a; }
      .card-note   { background: #f0f5ff; border-color: #aabcdd; color: #334; }
      .card-tag    { background: #eef2ff; border-color: #c7d2fe; color: #4456a0; }
      .card-meta   { color: #999; }
      .card-meta a { color: #5566aa; }

      .domain-header { border-bottom-color: #e0e0e0; }
      .domain-name   { color: #444; }
      .domain-count  { color: #aaa; }

      .card-accent {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      @page {
        margin: 18mm 18mm 22mm;
        size: A4;
      }
    }
  </style>
</head>
<body>
  <header class="export-header">
    <div class="export-header-inner">
      <div class="export-logo">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M3 5h12M3 8h9M3 11h12M3 14h7" stroke="#fde68a" stroke-width="2.5" stroke-linecap="round"/>
          <path d="M15 10l4 4-2 6-5-3 3-7z" fill="#fde68a"/>
        </svg>
        <span class="export-logo-text">Persistent Web Highlighter</span>
      </div>
      <h1 class="export-title">Highlights Export</h1>
      <div class="export-meta">
        <span>Exported ${exportDate}</span>
        <span>${totalCount} highlight${totalCount !== 1 ? 's' : ''}</span>
        <span>${Object.keys(grouped).length} domain${Object.keys(grouped).length !== 1 ? 's' : ''}</span>
      </div>
    </div>
  </header>

  <div class="export-body">
    ${domainSections}
  </div>

  ${forPrint ? '<script>window.addEventListener("load", () => setTimeout(() => window.print(), 300));<\/script>' : ''}
</body>
</html>`;
  }

  // ── Card builder ──────────────────────────────────────────────────────────
  function buildCard(h) {
    const color   = COLOR_HEX_EXPORT[h.color] || '#fde68a';
    const timeStr = new Date(h.timestamp).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric'
    });

    let displayUrl = h.url;
    try {
      const u = new URL(h.url);
      displayUrl = u.pathname + (u.search || '');
      if (displayUrl.length > 80) displayUrl = displayUrl.slice(0, 77) + '…';
    } catch {}

    const noteHTML = h.note ? `
      <div class="card-note">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;margin-top:2px"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        ${escHtml(h.note)}
      </div>` : '';

    const tags = (h.tags || []);
    const tagsHTML = tags.length ? `
      <div class="card-tags">
        ${tags.map(t => `<span class="card-tag">${escHtml(t)}</span>`).join('')}
      </div>` : '';

    return `
      <div class="highlight-card">
        <div class="card-accent" style="background:${color}"></div>
        <div class="card-content">
          <div class="card-text">${escHtml(h.text)}</div>
          ${noteHTML}
          ${tagsHTML}
          <div class="card-meta">
            <a href="${escHtml(h.url)}" target="_blank" rel="noopener">${escHtml(displayUrl)}</a>
            <span>${timeStr}</span>
          </div>
        </div>
      </div>`;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function groupByDomain(highlights) {
    const sorted = [...highlights].sort((a, b) => b.timestamp - a.timestamp);
    const out = {};
    for (const h of sorted) {
      let domain = '(unknown)';
      try { domain = new URL(h.url).hostname; } catch {}
      if (!out[domain]) out[domain] = [];
      out[domain].push(h);
    }
    return out;
  }

  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function datestamp() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

})();
