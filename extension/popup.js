/**
 * Persistent Web Highlighter - Popup Script v2
 * Current-page highlight list + sync status indicator + dashboard link.
 */

(function () {
  'use strict';

  const STORAGE_KEY_PREFIX = 'wh_';

  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      return u.toString().replace(/\/$/, '');
    } catch {
      return url;
    }
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function truncateText(text, maxLen = 90) {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen).trimEnd() + '…';
  }

  async function getCurrentTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs[0] || null);
      });
    });
  }

  async function loadHighlightsForUrl(url) {
    const key = STORAGE_KEY_PREFIX + normalizeUrl(url);
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => resolve(result[key] || []));
    });
  }

  async function saveHighlightsForUrl(url, highlights) {
    const key = STORAGE_KEY_PREFIX + normalizeUrl(url);
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: highlights }, resolve);
    });
  }

  // ── Sync status indicator ──────────────────────────────────────────────────
  async function updateSyncIndicator() {
    const dot = document.getElementById('sync-indicator');
    if (!dot) return;
    try {
      const status = await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATUS' });
      if (!status.configured) {
        dot.className = 'sync-dot offline';
        dot.title = 'Sync not configured — open dashboard to set up';
        return;
      }
      if (status.lastSync) {
        const ago = Math.round((Date.now() - status.lastSync) / 60000);
        dot.className = 'sync-dot synced';
        dot.title = `Last synced ${ago < 1 ? 'just now' : ago + 'm ago'} · ${status.browser} · ${status.deviceId.slice(0, 12)}…`;
      } else {
        dot.className = 'sync-dot offline';
        dot.title = 'Configured but not yet synced';
      }
    } catch {
      dot.className = 'sync-dot offline';
    }
  }

  // ── Highlight item rendering ───────────────────────────────────────────────
  function renderHighlightItem(highlight, tab) {
    const li = document.createElement('li');
    li.className = 'highlight-item';
    li.dataset.id = highlight.id;

    const dot = document.createElement('div');
    dot.className = 'color-dot';
    dot.dataset.color = highlight.color;

    const body = document.createElement('div');
    body.className = 'item-body';

    const textEl = document.createElement('div');
    textEl.className = 'item-text';
    textEl.textContent = truncateText(highlight.text);

    body.appendChild(textEl);

    // Show note snippet if present
    if (highlight.note && highlight.note.trim()) {
      const noteEl = document.createElement('div');
      noteEl.className = 'item-note';
      noteEl.textContent = '✎ ' + truncateText(highlight.note, 60);
      body.appendChild(noteEl);
    }

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = formatTime(highlight.timestamp);
    body.appendChild(meta);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'item-delete';
    deleteBtn.title = 'Delete highlight';
    deleteBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-1 14H6L5 6"/>
        <path d="M10 11v6M14 11v6"/>
        <path d="M9 6V4h6v2"/>
      </svg>`;

    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await handleDelete(highlight.id, tab);
    });

    li.addEventListener('click', () => {
      chrome.tabs.sendMessage(tab.id, { type: 'SCROLL_TO_HIGHLIGHT', id: highlight.id }).catch(() => {});
    });

    const colorMap = { yellow:'#fde68a', blue:'#93c5fd', green:'#6ee7b7', red:'#fca5a5', purple:'#c4b5fd', orange:'#fdba74', teal:'#5eead4', pink:'#f9a8d4' };
    li.style.setProperty('--item-color', colorMap[highlight.color] || '#fbbf24');
    li.appendChild(dot);
    li.appendChild(body);
    li.appendChild(deleteBtn);
    return li;
  }

  async function handleDelete(highlightId, tab) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'DELETE_HIGHLIGHT', id: highlightId });
    } catch { /* content script may not be loaded */ }

    const highlights = await loadHighlightsForUrl(tab.url);
    const updated = highlights.filter(h => h.id !== highlightId);
    await saveHighlightsForUrl(tab.url, updated);

    // Sync deletion to cloud
    chrome.runtime.sendMessage({ type: 'SYNC_HIGHLIGHT_DELETE', id: highlightId }).catch(() => {});

    renderList(updated, tab);
  }

  function renderList(highlights, tab) {
    const list = document.getElementById('highlight-list');
    const emptyState = document.getElementById('empty-state');
    const countBadge = document.getElementById('highlight-count');

    list.innerHTML = '';
    countBadge.textContent = highlights.length;

    if (highlights.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }
    emptyState.classList.add('hidden');

    const sorted = [...highlights].sort((a, b) => b.timestamp - a.timestamp);
    sorted.forEach(h => list.appendChild(renderHighlightItem(h, tab)));
  }

  const USER_BLOCKED_KEY = 'wh_blocked_domains';

  // System-blocked hostnames (must match content.js list)
  const SYSTEM_BLOCKED = new Set([
    'outlook.office.com','outlook.office365.com','outlook.live.com',
    'twitter.com','x.com','www.twitter.com','www.x.com',
    'instagram.com','www.instagram.com',
    'facebook.com','www.facebook.com',
    'threads.net','www.threads.net',
    'tiktok.com','www.tiktok.com',
    'reddit.com','www.reddit.com',
    'linkedin.com','www.linkedin.com',
    'chatgpt.com','chat.openai.com',
    'claude.ai',
    'gemini.google.com',
    'copilot.microsoft.com',
    'perplexity.ai','www.perplexity.ai',
    'mail.google.com','docs.google.com','drive.google.com',
    'meet.google.com','calendar.google.com',
  ]);

  function getHostname(url) {
    try { return new URL(url).hostname; } catch { return ''; }
  }

  async function getUserBlockedDomains() {
    return new Promise(r => chrome.storage.local.get([USER_BLOCKED_KEY], res => r(res[USER_BLOCKED_KEY] || [])));
  }

  async function setUserBlockedDomains(list) {
    return new Promise(r => chrome.storage.local.set({ [USER_BLOCKED_KEY]: list }, r));
  }

  function showBlockedState(isSystem, hostname) {
    document.getElementById('site-blocked-state')?.classList.remove('hidden');
    document.getElementById('highlight-list-container')?.classList.add('hidden');
    document.getElementById('empty-state')?.classList.add('hidden');
    const title = document.getElementById('blocked-title');
    const sub   = document.getElementById('blocked-sub');
    if (isSystem) {
      if (title) title.textContent = 'Not supported here';
      if (sub)   sub.textContent   = `Highlighting is unavailable on ${hostname}.`;
    } else {
      if (title) title.textContent = 'Highlighting disabled';
      if (sub)   sub.textContent   = `You turned off highlighting on ${hostname}. Click the eye icon to re-enable.`;
    }
    // Hide toggle button for system-blocked (user can't override)
    const toggleBtn = document.getElementById('toggle-site-btn');
    if (toggleBtn && isSystem) toggleBtn.style.display = 'none';
  }

  function updateToggleButton(isBlocked) {
    const btn     = document.getElementById('toggle-site-btn');
    const iconOn  = document.getElementById('toggle-icon-on');
    const iconOff = document.getElementById('toggle-icon-off');
    if (!btn) return;
    if (isBlocked) {
      btn.classList.remove('toggle-on');
      btn.classList.add('toggle-off');
      btn.title = 'Highlighting disabled on this site — click to enable';
      if (iconOn)  iconOn.style.display  = 'none';
      if (iconOff) iconOff.style.display = '';
    } else {
      btn.classList.add('toggle-on');
      btn.classList.remove('toggle-off');
      btn.title = 'Highlighting enabled on this site — click to disable';
      if (iconOn)  iconOn.style.display  = '';
      if (iconOff) iconOff.style.display = 'none';
    }
  }

  async function init() {
    const tab = await getCurrentTab();
    if (!tab || !tab.url) { renderList([], null); return; }

    const hostname      = getHostname(tab.url);
    const isSystemBlock = SYSTEM_BLOCKED.has(hostname);
    const blockedList   = await getUserBlockedDomains();
    const isUserBlock   = blockedList.includes(hostname);

    if (isSystemBlock) {
      showBlockedState(true, hostname);
      return;
    }

    if (isUserBlock) {
      showBlockedState(false, hostname);
      updateToggleButton(true);
      // Wire toggle to re-enable
      document.getElementById('toggle-site-btn')?.addEventListener('click', async () => {
        const list = await getUserBlockedDomains();
        const updated = list.filter(d => d !== hostname);
        await setUserBlockedDomains(updated);
        // Tell content script to reload page
        chrome.tabs.sendMessage(tab.id, { type: 'WH_TOGGLE_DOMAIN', blocked: false }).catch(() => {});
        window.close();
      });
      return;
    }

    // Normal state
    updateToggleButton(false);
    const highlights = await loadHighlightsForUrl(tab.url);
    renderList(highlights, tab);
    updateSyncIndicator();

    // Toggle off handler
    document.getElementById('toggle-site-btn')?.addEventListener('click', async () => {
      const list = await getUserBlockedDomains();
      if (!list.includes(hostname)) list.push(hostname);
      await setUserBlockedDomains(list);
      chrome.tabs.sendMessage(tab.id, { type: 'WH_TOGGLE_DOMAIN', blocked: true }).catch(() => {});
      updateToggleButton(true);
      showBlockedState(false, hostname);
    });

    // Dashboard button
    document.getElementById('open-dashboard')?.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'HIGHLIGHT_DELETED') init();
  });

  document.addEventListener('DOMContentLoaded', () => {
    init();
    // Dashboard shortcut
    document.getElementById('open-dashboard')?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  });
})();
