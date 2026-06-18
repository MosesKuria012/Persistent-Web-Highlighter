/**
 * Web Highlighter - Content Script v3
 * Features: highlights, notes, tags, duplicate detection, keyboard shortcut (Alt+H)
 * Depends on anchoring.js (window.AnchoringLib) being loaded first.
 */

(async function () {
  'use strict';

  if (window.__whLoaded) return;
  window.__whLoaded = true;

  // ─── Domain Blocklist ─────────────────────────────────────────────────────────
  // These domains are always blocked regardless of user settings.
  // Reasons: volatile/session URLs (Outlook, AI chats), social feeds with
  // ephemeral content, or sites where accidental highlights cause confusion.
  const SYSTEM_BLOCKED_PATTERNS = [
    // Outlook Web — session-based URLs, iframes, CSP issues
    /^(outlook\.office\.com|outlook\.office365\.com|outlook\.live\.com)$/,
    // Social media feeds — content is ephemeral and URL-unstable
    /^(www\.)?(twitter\.com|x\.com)$/,
    /^(www\.)?instagram\.com$/,
    /^(www\.)?facebook\.com$/,
    /^(www\.)?threads\.net$/,
    /^(www\.)?tiktok\.com$/,
    /^(www\.)?reddit\.com$/,
    /^(www\.)?linkedin\.com$/,
    // AI chat interfaces — evolving URLs, conversation context changes constantly
    /^(chatgpt\.com|chat\.openai\.com)$/,
    /^(claude\.ai)$/,
    /^(gemini\.google\.com)$/,
    /^(copilot\.microsoft\.com)$/,
    /^(www\.)?perplexity\.ai$/,
    // Google products with volatile/authenticated content
    /^(mail\.google\.com)$/,          // Gmail
    /^(docs\.google\.com)$/,          // Google Docs (has own annotation system)
    /^(drive\.google\.com)$/,         // Google Drive
    /^(meet\.google\.com)$/,          // Google Meet
    /^(calendar\.google\.com)$/,      // Google Calendar
    // Browser internal pages (these would fail anyway but exit cleanly)
    /^(about|chrome|chrome-extension|moz-extension|edge)$/,
  ];

  const USER_BLOCKED_KEY = 'wh_blocked_domains';

  function getHostname() {
    try { return new URL(window.location.href).hostname; } catch { return ''; }
  }

  function isSystemBlocked(hostname) {
    return SYSTEM_BLOCKED_PATTERNS.some(p => p.test(hostname));
  }

  async function isUserBlocked(hostname) {
    return new Promise(r => {
      chrome.storage.local.get([USER_BLOCKED_KEY], res => {
        const blocked = res[USER_BLOCKED_KEY] || [];
        r(blocked.includes(hostname));
      });
    });
  }

  // ─── Block check — runs before anything else ──────────────────────────────────
  const _hostname = getHostname();

  if (isSystemBlocked(_hostname)) {
    // Silent exit — no UI, no storage access, no observers
    console.log(`[PWH] Highlighting disabled on ${_hostname} (system blocked).`);
    return;
  }

  // User-toggle check is async — wrap the rest of the script init in a guard
  // We use a self-invoking async function to avoid top-level await in an IIFE
  let _userBlockedResult = false;
  await new Promise(r => {
    chrome.storage.local.get([USER_BLOCKED_KEY], res => {
      const blocked = res[USER_BLOCKED_KEY] || [];
      _userBlockedResult = blocked.includes(_hostname);
      r();
    });
  });

  if (_userBlockedResult) {
    console.log(`[PWH] Highlighting disabled on ${_hostname} (user preference).`);
    // Still listen for toggle-on messages from popup/options
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'WH_TOGGLE_DOMAIN') {
        // Reload the page so the content script re-evaluates from scratch
        if (!msg.blocked) window.location.reload();
        sendResponse({ ok: true });
      }
    });
    return;
  }

  // ─── Constants ────────────────────────────────────────────────────────────────
  const COLORS = [
    { name: 'yellow', hex: '#fde68a' },
    { name: 'blue', hex: '#93c5fd' },
    { name: 'green', hex: '#6ee7b7' },
    { name: 'red', hex: '#fca5a5' },
    { name: 'purple', hex: '#c4b5fd' },
    { name: 'orange', hex: '#fdba74' },
    { name: 'teal', hex: '#5eead4' },
    { name: 'pink', hex: '#f9a8d4' },
  ];

  const STORAGE_KEY_PREFIX  = 'wh_';
  const VISITED_KEY_PREFIX  = 'wh_visited_';
  let PAGE_URL              = normalizeUrl(window.location.href);

  // ─── State ────────────────────────────────────────────────────────────────────
  let lastColor        = 'yellow';
  let activeRange      = null;
  let colorPicker      = null;
  let deleteTooltip    = null;
  let notePreview      = null;
  let notePreviewTimer = null;

  // ─── Utilities ────────────────────────────────────────────────────────────────
  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      // Preserve the hash — AWS docs and many SPAs use hashes as real page
      // identifiers (e.g. concepts.html#what-is-ec2 vs concepts.html#ami).
      // Stripping it collapses distinct pages into one storage key.
      // We only strip the hash if it is empty.
      if (!u.hash || u.hash === '#') u.hash = '';
      return u.toString().replace(/\/$/, '');
    }
    catch { return url; }
  }

  function generateId() {
    return `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function getStorageKey()  { return STORAGE_KEY_PREFIX + PAGE_URL; }
  function getVisitedKey()  { return VISITED_KEY_PREFIX + getDomain(); }
  function getDomain() {
    try { return new URL(PAGE_URL).hostname; } catch { return PAGE_URL; }
  }

  async function loadHighlights() {
    return new Promise(r => chrome.storage.local.get([getStorageKey()], res => r(res[getStorageKey()] || [])));
  }

  async function saveHighlights(highlights) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [getStorageKey()]: highlights }, () =>
        chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve()
      );
    });
  }

  // ─── Reading Progress: record this page visit ─────────────────────────────────
  async function recordVisit() {
    const key = getVisitedKey();
    const data = await new Promise(r => chrome.storage.local.get([key], res => r(res[key] || {})));
    data[PAGE_URL] = { lastVisited: Date.now(), title: document.title || PAGE_URL };
    chrome.storage.local.set({ [key]: data });
  }

  // ─── Duplicate Detection ──────────────────────────────────────────────────────
  function textSimilarity(a, b) {
    // Jaccard similarity on word sets — fast, no external dep
    const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
    const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
    const intersection = new Set([...setA].filter(w => setB.has(w)));
    const union = new Set([...setA, ...setB]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  async function findDuplicate(newText) {
    const existing = await loadHighlights();
    for (const h of existing) {
      if (textSimilarity(newText, h.text) >= 0.82) return h;
    }
    return null;
  }

  // ─── Anchoring ────────────────────────────────────────────────────────────────
  function createSelectors(range) {
    const lib = window.AnchoringLib;
    const root = document.body;
    let quoteSelector = null, positionSelector = null;
    try {
      const q = lib.TextQuoteAnchor.fromRange(root, range);
      quoteSelector = { exact: q.exact, prefix: q.prefix || '', suffix: q.suffix || '' };
    } catch (e) { console.warn('[WH] TextQuoteAnchor:', e); }
    try {
      const p = lib.TextPositionAnchor.fromRange(root, range);
      positionSelector = { start: p.start, end: p.end };
    } catch (e) { console.warn('[WH] TextPositionAnchor:', e); }
    return { quoteSelector, positionSelector };
  }

  function resolveRange(h) {
    const lib = window.AnchoringLib;
    const root = document.body;
    if (h.selector?.exact) {
      try { const r = lib.TextQuoteAnchor.toRange(root, h.selector); if (r) return r; } catch {}
    }
    if (h.positionSelector) {
      try { const r = lib.TextPositionAnchor.toRange(root, h.positionSelector); if (r) return r; } catch {}
    }
    return null;
  }

  // ─── DOM Rendering ────────────────────────────────────────────────────────────
  function createHighlightSpan(id, color, note = '', tags = []) {
    const span = document.createElement('span');
    span.className = 'wh-highlight';
    span.dataset.highlightId = id;
    span.dataset.color  = color;
    span.dataset.note   = note;
    span.dataset.tags   = JSON.stringify(tags);
    const hex = COLORS.find(c => c.name === color)?.hex || '#fde68a';
    span.style.cssText = [
      `background-color:${hex}`,
      'color:#1a1a1a',          // force dark text for readability on dark-mode pages
      'display:inline', 'padding:0', 'margin:0', 'border:none',
      'outline:none', 'font-size:inherit', 'font-family:inherit',
      'font-weight:inherit', 'line-height:inherit', 'vertical-align:baseline',
      'position:static', 'float:none', 'box-shadow:none',
      'border-radius:2px', 'cursor:pointer',
    ].join('!important;') + '!important';
    return span;
  }

  function wrapRangeWithHighlight(range, id, color, note = '', tags = []) {
    if (document.querySelector(`[data-highlight-id="${id}"]`)) return;
    try {
      const span = createHighlightSpan(id, color, note, tags);
      range.surroundContents(span);
      return;
    } catch {}
    const textNodes = getTextNodesInRange(range);
    textNodes.forEach(textNode => {
      const sub = document.createRange();
      sub.selectNodeContents(textNode);
      if (textNode === range.startContainer) sub.setStart(textNode, range.startOffset);
      if (textNode === range.endContainer)   sub.setEnd(textNode, range.endOffset);
      if (sub.collapsed) return;
      try {
        const span = createHighlightSpan(id, color, note, tags);
        sub.surroundContents(span);
      } catch (e) { console.warn('[WH] wrap text node:', e); }
    });
  }

  function getTextNodesInRange(range) {
    const nodes = [];
    const root  = range.commonAncestorContainer;
    const walker = document.createTreeWalker(
      root.nodeType === Node.TEXT_NODE ? root.parentNode : root,
      NodeFilter.SHOW_TEXT,
      { acceptNode: n => {
        if (!range.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
        if (!n.textContent.trim())    return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }}
    );
    let n; while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function removeHighlightFromDOM(id) {
    document.querySelectorAll(`[data-highlight-id="${id}"]`).forEach(span => {
      const p = span.parentNode;
      if (!p) return;
      while (span.firstChild) p.insertBefore(span.firstChild, span);
      p.removeChild(span);
      p.normalize();
    });
  }

  function updateSpanData(id, note, tags) {
    document.querySelectorAll(`[data-highlight-id="${id}"]`).forEach(span => {
      span.dataset.note = note;
      span.dataset.tags = JSON.stringify(tags);
    });
  }

  // ─── Keyboard Shortcut ────────────────────────────────────────────────────────
  document.addEventListener('keydown', async (e) => {
    if (!e.altKey || e.key !== 'h') return;
    e.preventDefault();

    const selection = window.getSelection();
    if (!selection || !selection.toString().trim()) return;

    const range = selection.getRangeAt(0).cloneRange();
    hideColorPicker();
    await onColorSelected(lastColor, range, true /* fromShortcut */);
  });

  // ─── Color Picker ─────────────────────────────────────────────────────────────
  function showColorPicker(range) {
    hideColorPicker();
    const rect = range.getBoundingClientRect();
    const top  = rect.bottom + window.scrollY + 6;
    const cx   = rect.left + window.scrollX + rect.width / 2;

    colorPicker = document.createElement('div');
    colorPicker.id = 'wh-color-picker';
    colorPicker.style.cssText = `top:${top}px;left:${cx}px;transform:translateX(-50%)`;

    COLORS.forEach(({ name }) => {
      const btn = document.createElement('div');
      btn.className = `wh-color-btn${name === lastColor ? ' wh-active' : ''}`;
      btn.dataset.color = name;
      btn.title = name.charAt(0).toUpperCase() + name.slice(1);
      btn.addEventListener('mousedown', e => {
        e.preventDefault(); e.stopPropagation();
        onColorSelected(name, range);
      });
      colorPicker.appendChild(btn);
    });

    // Shortcut hint
    const hint = document.createElement('div');
    hint.className = 'wh-picker-hint';
    hint.textContent = 'Alt+H → last color';
    colorPicker.appendChild(hint);

    document.body.appendChild(colorPicker);
  }

  function hideColorPicker() { colorPicker?.remove(); colorPicker = null; }

  // ─── Duplicate Warning Banner ─────────────────────────────────────────────────
  function showDuplicateWarning(range, duplicate, color) {
    hideColorPicker();
    const rect = range.getBoundingClientRect();
    const top  = rect.bottom + window.scrollY + 6;
    const cx   = rect.left + window.scrollX + rect.width / 2;

    const warn = document.createElement('div');
    warn.id = 'wh-dupe-warning';
    warn.style.cssText = `top:${top}px;left:${cx}px;transform:translateX(-50%)`;

    warn.innerHTML = `
      <div class="wh-dupe-msg">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Similar highlight exists
      </div>
      <div class="wh-dupe-preview">"${duplicate.text.slice(0, 60)}${duplicate.text.length > 60 ? '…' : ''}"</div>
    `;

    const actions = document.createElement('div');
    actions.className = 'wh-dupe-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'wh-dupe-btn-save';
    saveBtn.textContent = 'Save anyway';
    saveBtn.addEventListener('click', e => {
      e.stopPropagation();
      warn.remove();
      commitHighlight(range, color);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'wh-dupe-btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', e => { e.stopPropagation(); warn.remove(); });

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    warn.appendChild(actions);
    document.body.appendChild(warn);
  }

  // ─── Highlight Action Tooltip (note + tags + delete) ─────────────────────────
  function showHighlightTooltip(highlightId, targetEl, existingNote, existingTags) {
    hideDeleteTooltip();
    hideNotePreview();

    const rect = targetEl.getBoundingClientRect();
    const top  = rect.bottom + window.scrollY + 6;
    let   cx   = rect.left + window.scrollX + rect.width / 2;

    deleteTooltip = document.createElement('div');
    deleteTooltip.id = 'wh-delete-tooltip';

    // ── Note ──
    const noteSection = document.createElement('div');
    noteSection.className = 'wh-tooltip-note-section';

    const noteLabel = document.createElement('div');
    noteLabel.className = 'wh-tooltip-label';
    noteLabel.textContent = 'NOTE';

    const noteArea = document.createElement('textarea');
    noteArea.className = 'wh-note-input';
    noteArea.placeholder = 'Add context… (max 280 chars)';
    noteArea.maxLength = 280;
    noteArea.value = existingNote || '';
    noteArea.rows  = 2;

    const counter = document.createElement('div');
    counter.className = 'wh-note-counter';
    counter.textContent = `${(existingNote||'').length}/280`;
    noteArea.addEventListener('input',   () => { counter.textContent = `${noteArea.value.length}/280`; });
    noteArea.addEventListener('keydown', e => e.stopPropagation());
    noteArea.addEventListener('mousedown', e => e.stopPropagation());

    noteSection.appendChild(noteLabel);
    noteSection.appendChild(noteArea);
    noteSection.appendChild(counter);

    // ── Tags ──
    const tagSection = document.createElement('div');
    tagSection.className = 'wh-tooltip-tag-section';

    const tagLabel = document.createElement('div');
    tagLabel.className = 'wh-tooltip-label';
    tagLabel.textContent = 'TAGS';

    const tagChips = document.createElement('div');
    tagChips.className = 'wh-tag-chips';

    const currentTags = Array.isArray(existingTags) ? [...existingTags] : [];

    function renderChips() {
      tagChips.innerHTML = '';
      currentTags.forEach((tag, i) => {
        const chip = document.createElement('span');
        chip.className = 'wh-tag-chip';
        chip.textContent = tag;
        const x = document.createElement('button');
        x.className = 'wh-tag-remove';
        x.textContent = '×';
        x.addEventListener('mousedown', e => {
          e.preventDefault(); e.stopPropagation();
          currentTags.splice(i, 1);
          renderChips();
        });
        chip.appendChild(x);
        tagChips.appendChild(chip);
      });
    }
    renderChips();

    const tagInputWrap = document.createElement('div');
    tagInputWrap.className = 'wh-tag-input-wrap';

    const tagInput = document.createElement('input');
    tagInput.className  = 'wh-tag-input';
    tagInput.type       = 'text';
    tagInput.placeholder = '#tag';
    tagInput.maxLength  = 32;

    // Tag autocomplete from existing tags on this page
    loadHighlights().then(existing => {
      const allTags = [...new Set(existing.flatMap(h => h.tags || []))].sort();
      if (allTags.length === 0) return;
      const datalist = document.createElement('datalist');
      datalist.id = 'wh-tag-datalist';
      allTags.forEach(t => { const opt = document.createElement('option'); opt.value = t; datalist.appendChild(opt); });
      document.body.appendChild(datalist);
      tagInput.setAttribute('list', 'wh-tag-datalist');
    });

    function addTag(raw) {
      const tag = raw.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-');
      if (!tag || currentTags.includes(tag) || currentTags.length >= 8) return;
      currentTags.push(tag);
      renderChips();
      tagInput.value = '';
    }

    tagInput.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput.value); }
      if (e.key === 'Backspace' && !tagInput.value && currentTags.length) {
        currentTags.pop(); renderChips();
      }
    });
    tagInput.addEventListener('mousedown', e => e.stopPropagation());

    tagInputWrap.appendChild(tagInput);

    tagSection.appendChild(tagLabel);
    tagSection.appendChild(tagChips);
    tagSection.appendChild(tagInputWrap);

    // ── Actions ──
    const actions = document.createElement('div');
    actions.className = 'wh-tooltip-actions';

    const saveBtn = document.createElement('button');
    saveBtn.id = 'wh-save-note-btn';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (tagInput.value.trim()) addTag(tagInput.value);
      updateHighlightMeta(highlightId, noteArea.value.trim(), currentTags);
      hideDeleteTooltip();
    });

    const div1 = document.createElement('div'); div1.className = 'wh-delete-divider';

    const deleteBtn = document.createElement('button');
    deleteBtn.id = 'wh-delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', e => { e.stopPropagation(); deleteHighlight(highlightId); });

    const div2 = document.createElement('div'); div2.className = 'wh-delete-divider';

    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'wh-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', e => { e.stopPropagation(); hideDeleteTooltip(); });

    actions.appendChild(saveBtn);
    actions.appendChild(div1);
    actions.appendChild(deleteBtn);
    actions.appendChild(div2);
    actions.appendChild(cancelBtn);

    deleteTooltip.appendChild(noteSection);
    deleteTooltip.appendChild(tagSection);
    deleteTooltip.appendChild(actions);
    document.body.appendChild(deleteTooltip);

    // Position — clamp to viewport
    const tw = 300;
    const vw = window.innerWidth;
    cx = Math.max(tw / 2 + 8, Math.min(cx, vw - tw / 2 - 8));
    deleteTooltip.style.cssText = `top:${top}px;left:${cx}px;transform:translateX(-50%)`;

    setTimeout(() => noteArea.focus(), 60);
  }

  function hideDeleteTooltip() {
    deleteTooltip?.remove();
    deleteTooltip = null;
    document.getElementById('wh-tag-datalist')?.remove();
  }

  // ─── Note Hover Preview ────────────────────────────────────────────────────────
  function showNoteOrTagPreview(span) {
    const note = span.dataset.note || '';
    const tags = (() => { try { return JSON.parse(span.dataset.tags || '[]'); } catch { return []; } })().catch(e => console.error('[PWH] Init error:', e));
    if (!note && !tags.length) return;
    if (deleteTooltip) return;

    clearTimeout(notePreviewTimer);
    notePreviewTimer = setTimeout(() => {
      hideNotePreview();
      const rect = span.getBoundingClientRect();
      notePreview = document.createElement('div');
      notePreview.id = 'wh-note-preview';
      notePreview.style.cssText =
        `top:${rect.top + window.scrollY - 8}px;` +
        `left:${rect.left + window.scrollX + rect.width / 2}px;` +
        `transform:translateX(-50%) translateY(-100%)`;

      if (note) {
        const p = document.createElement('div');
        p.className = 'wh-preview-note';
        p.textContent = note;
        notePreview.appendChild(p);
      }
      if (tags.length) {
        const wrap = document.createElement('div');
        wrap.className = 'wh-preview-tags';
        tags.forEach(t => {
          const chip = document.createElement('span');
          chip.className = 'wh-preview-tag';
          chip.textContent = '#' + t;
          wrap.appendChild(chip);
        });
        notePreview.appendChild(wrap);
      }
      document.body.appendChild(notePreview);
    }, 400);
  }

  function hideNotePreview() {
    clearTimeout(notePreviewTimer);
    notePreviewTimer = null;
    notePreview?.remove();
    notePreview = null;
  }

  // ─── Shortcut flash ────────────────────────────────────────────────────────────
  function flashConfirmation(spans) {
    spans.forEach(span => {
      span.style.outline = '2px solid rgba(255,255,255,0.9)';
      span.style.outlineOffset = '1px';
      setTimeout(() => { span.style.outline = ''; span.style.outlineOffset = ''; }, 800);
    });
  }

  // ─── Core Actions ─────────────────────────────────────────────────────────────
  async function onColorSelected(color, range, fromShortcut = false) {
    lastColor = color;
    hideColorPicker();

    const selectedText = range.toString().trim();
    if (!selectedText) return;

    // Duplicate detection
    const dupe = await findDuplicate(selectedText);
    if (dupe && !fromShortcut) {
      showDuplicateWarning(range, dupe, color);
      return;
    }

    await commitHighlight(range, color, fromShortcut);
  }

  async function commitHighlight(range, color, fromShortcut = false) {
    const selectedText = range.toString().trim();
    const { quoteSelector, positionSelector } = createSelectors(range);
    if (!quoteSelector && !positionSelector) return;

    const id = generateId();
    const highlight = {
      id,
      text: selectedText,
      selector: quoteSelector,
      positionSelector,
      color,
      note: '',
      tags: [],
      timestamp: Date.now(),
      url: PAGE_URL,
    };

    try {
      wrapRangeWithHighlight(range, id, color, '', []);
    } catch (e) {
      console.error('[WH] wrap failed:', e);
      return;
    }

    window.getSelection()?.removeAllRanges();
    activeRange = null;

    if (fromShortcut) {
      // Flash confirmation for keyboard shortcut (no tooltip shown)
      const spans = [...document.querySelectorAll(`[data-highlight-id="${id}"]`)];
      flashConfirmation(spans);
    }

    try {
      const highlights = await loadHighlights();
      highlights.push(highlight);
      await saveHighlights(highlights);
    } catch (e) { console.error('[WH] save failed:', e); return; }

    chrome.runtime.sendMessage({ type: 'SYNC_HIGHLIGHT_SAVE', highlight }).catch(() => {});
  }

  async function deleteHighlight(id) {
    hideDeleteTooltip();
    removeHighlightFromDOM(id);
    try {
      const highlights = await loadHighlights();
      await saveHighlights(highlights.filter(h => h.id !== id));
      chrome.runtime.sendMessage({ type: 'HIGHLIGHT_DELETED', id }).catch(() => {});
      chrome.runtime.sendMessage({ type: 'SYNC_HIGHLIGHT_DELETE', id }).catch(() => {});
    } catch (e) { console.error('[WH] delete failed:', e); }
  }

  async function updateHighlightMeta(id, note, tags) {
    updateSpanData(id, note, tags);
    const highlights = await loadHighlights();
    const updated = highlights.map(h => h.id === id ? { ...h, note, tags } : h);
    await saveHighlights(updated);
    const h = updated.find(h => h.id === id);
    if (h) chrome.runtime.sendMessage({ type: 'SYNC_HIGHLIGHT_SAVE', highlight: h }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'HIGHLIGHT_NOTE_UPDATED', id, note, tags }).catch(() => {});
  }

  // ─── Restore Highlights on Load ───────────────────────────────────────────────
  async function restoreHighlights() {
    await new Promise(r => setTimeout(r, 300));
    const highlights = await loadHighlights();
    if (!highlights.length) return;
    let fail = 0;
    for (const h of highlights) {
      try {
        const range = resolveRange(h);
        if (range) wrapRangeWithHighlight(range, h.id, h.color, h.note || '', h.tags || []);
        else fail++;
      } catch (e) { fail++; console.error('[WH] restore error:', h.id, e); }
    }
    if (fail) console.log(`[WH] ${highlights.length - fail}/${highlights.length} restored. ${fail} failed.`);
  }

  // ─── Event Listeners ──────────────────────────────────────────────────────────
  document.addEventListener('mouseup', e => {
    if (e.target.closest('#wh-color-picker') || e.target.closest('#wh-delete-tooltip') || e.target.closest('#wh-dupe-warning')) return;

    const span = e.target.closest('.wh-highlight');
    if (span) {
      e.stopPropagation();
      hideNotePreview();
      const tags = (() => { try { return JSON.parse(span.dataset.tags || '[]'); } catch { return []; } })();
      showHighlightTooltip(span.dataset.highlightId, span, span.dataset.note || '', tags);
      return;
    }

    const selection = window.getSelection();
    if (!selection || !selection.toString().trim()) { hideColorPicker(); return; }
    activeRange = selection.getRangeAt(0).cloneRange();
    showColorPicker(activeRange);
  });

  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#wh-color-picker') &&
        !e.target.closest('#wh-delete-tooltip') &&
        !e.target.closest('#wh-dupe-warning') &&
        !e.target.closest('.wh-highlight')) {
      hideColorPicker();
      hideDeleteTooltip();
      document.getElementById('wh-dupe-warning')?.remove();
    }
  });

  document.addEventListener('mouseover', e => {
    const span = e.target.closest('.wh-highlight');
    if (span) showNoteOrTagPreview(span);
  });

  document.addEventListener('mouseout', e => {
    if (e.target.closest('.wh-highlight')) hideNotePreview();
  });

  document.addEventListener('scroll', () => { hideColorPicker(); hideNotePreview(); }, { passive: true });

  // ─── Message Listener ─────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'DELETE_HIGHLIGHT') {
      deleteHighlight(msg.id).then(() => sendResponse({ success: true }));
      return true;
    }
    if (msg.type === 'GET_PAGE_URL') { sendResponse({ url: PAGE_URL }); return false; }
    if (msg.type === 'SCROLL_TO_HIGHLIGHT') {
      const span = document.querySelector(`[data-highlight-id="${msg.id}"]`);
      if (span) {
        span.scrollIntoView({ behavior: 'smooth', block: 'center' });
        span.style.outline = '3px solid rgba(255,255,255,0.8)';
        setTimeout(() => { span.style.outline = ''; }, 1200);
      }
      sendResponse({ found: !!span });
      return false;
    }
    // Domain status query — used by popup to show enable/disable toggle
    if (msg.type === 'WH_GET_DOMAIN_STATUS') {
      sendResponse({
        hostname:        _hostname,
        systemBlocked:   false,   // if we reach here, not system-blocked
        userBlocked:     false,   // if we reach here, not user-blocked
        highlightingOn:  true,
      });
      return false;
    }
    // Toggle from popup — when disabling, reload so the block check fires next time
    if (msg.type === 'WH_TOGGLE_DOMAIN') {
      if (msg.blocked) {
        // Turning OFF — reload after a short delay so any open tooltip closes first
        setTimeout(() => window.location.reload(), 200);
      }
      sendResponse({ ok: true });
      return false;
    }
  });

  // ─── SPA Navigation Detection ────────────────────────────────────────────────
  // Uses three complementary signals to catch every navigation method:
  //   1. pushState / replaceState intercept — catches most SPA frameworks
  //   2. popstate + hashchange events       — catches back/forward + hash routing
  //   3. URL polling (500ms)                — bulletproof fallback for any framework
  //      that bypasses all of the above (e.g. AWS docs' custom router)

  let _spaTransitionTimer = null;
  let _pollInterval       = null;

  function onUrlChanged() {
    const newUrl = normalizeUrl(window.location.href);
    if (newUrl === PAGE_URL) return; // same URL, nothing to do

    console.log(`[WH] SPA navigation: ${PAGE_URL} → ${newUrl}`);

    // Clean up current page state
    hideColorPicker();
    hideDeleteTooltip();
    hideNotePreview();
    document.getElementById('wh-dupe-warning')?.remove();
    activeRange = null;

    // Remove all rendered highlight spans from the DOM
    document.querySelectorAll('.wh-highlight').forEach(span => {
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      try { parent.normalize(); } catch {}
    });

    // Commit the new URL
    PAGE_URL = newUrl;

    // Wait for SPA to finish rendering the new page content, then restore
    clearTimeout(_spaTransitionTimer);
    _spaTransitionTimer = setTimeout(() => {
      restoreHighlights();
      recordVisit();
    }, 700);
  }

  // Signal 1: intercept pushState / replaceState
  (function interceptHistoryMethods() {
    const _push    = history.pushState.bind(history);
    const _replace = history.replaceState.bind(history);
    history.pushState = function (...args) {
      _push(...args);
      window.dispatchEvent(new Event('wh-urlchange'));
    };
    history.replaceState = function (...args) {
      _replace(...args);
      window.dispatchEvent(new Event('wh-urlchange'));
    };
  })();

  // Signal 2: standard navigation events
  window.addEventListener('wh-urlchange', onUrlChanged);
  window.addEventListener('popstate',     onUrlChanged);
  window.addEventListener('hashchange',   onUrlChanged);

  // Signal 3: polling fallback — catches frameworks that bypass pushState entirely.
  // AWS docs' navigation router is the primary case for this.
  // Runs every 500ms, zero cost when URL is stable.
  _pollInterval = setInterval(() => {
    const current = normalizeUrl(window.location.href);
    if (current !== PAGE_URL) onUrlChanged();
  }, 500);

  // ─── Init ─────────────────────────────────────────────────────────────────────
  restoreHighlights();
  recordVisit();

})();
