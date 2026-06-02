# Web Highlighter — Persistent, Synced Highlights for the Web

> **A Chrome, Edge and Brave extension that lets you highlight text on any webpage and come back to it — exactly where you left it — across sessions, devices, and browsers.**

---

## The Story Behind This

I enjoy reading technical documentation and articles from various sources. Over time a growing frustration built up: I wanted a highlighting tool that would let me come back to specific passages later, on my own terms. Most tools I found did not deliver truly persistent web highlights, and if anything, they lacked proper links back to the source so you could return to the exact page.

Anyone in tech understands this frustration. You read an entire article, don't highlight it, and when you need that information again weeks later you end up re-reading the whole thing just to find the one paragraph that mattered. Bookmarking entire pages is clunky for the same reason — the bookmark gets you to the page, but you still have to hunt for the content all over again.

The scenario that pushed me to build this: you have numerous tabs open, you are deep in documentation, and then a meeting comes up. Or you are leaving for home. You need the ability to not just retain the information but to return to the exact sentence, with your own notes giving you the context you had in your head when you first read it. No more re-reading. No more hunting. Just your highlights, your notes, and a direct link back.

That growing frustration became this tool.

---

## What Makes This Different

Most browser highlight extensions break. They use XPath paths or DOM structure to remember where a highlight lives, and when a page reloads, updates its ads, or shifts its layout — the highlight is gone.

**Web Highlighter uses the same anchoring technology as [Hypothesis](https://hypothes.is)**, one of the most widely used annotation platforms in academic and research publishing. Specifically it uses two libraries from the Hypothesis project:

- **`dom-anchor-text-quote`** — stores the highlighted text itself along with a small window of surrounding context (prefix and suffix). When the page loads, it finds your highlight by matching the text content, not the DOM structure. Minor page changes, lazy-loaded ads, content reflows — none of these matter.
- **`dom-anchor-text-position`** — stores the character offset from the start of the page body as a fallback. If the text match fails for any reason, this catches it.

This two-layer anchoring is why your highlights survive. It is production-grade, battle-tested, and the same approach used in production by Hypothesis on millions of annotations across thousands of sites.

---

## Features

### Core Highlighting
- Highlight text on **any webpage** — documentation, articles, Wikipedia, GitHub READMEs, anything
- Select text with your mouse → a color picker tooltip appears → click a color to save
- **Five colors**: Yellow, Blue, Green, Red, Purple — each visually distinct and readable
- Last chosen color becomes the new default for the session
- **`Alt+H` keyboard shortcut** — with text selected, press `Alt+H` to highlight instantly with your last-used color, no click required. A brief flash confirms the action
- Highlights render immediately and restore automatically on every page load

### Notes
- Click any highlight to open an action tooltip
- Add a note up to 280 characters for context — your interpretation, a question, a reminder
- Notes are resizable so you can write and read comfortably
- Hover over any highlighted text to see a preview of the note without opening the full tooltip
- Notes appear on dashboard cards and are fully searchable

### Tags
- Attach free-form tags to any highlight — `#security`, `#todo`, `#confusing`, `#revisit`
- One highlight can carry multiple tags
- Tags autocomplete from existing tags on the page
- The dashboard has a live tag filter bar — click any tag to instantly filter all highlights to it
- Tags survive if you later change what colors mean to you
- Tags are included in search queries

### Persistent Storage — Why Highlights Don't Disappear
Highlights are stored in `chrome.storage.local` — a sandboxed database managed by the browser on your machine. This is entirely separate from browser history or cookies and is not cleared when you clear browsing data. It persists across browser restarts indefinitely.

The extension deliberately uses **local storage, not sync storage**, because Chrome's sync storage has a hard 100KB limit that a regular reader would exhaust within weeks. Local storage has no practical limit for text highlights.

### Cross-Device Sync with Supabase
For highlights to follow you across computers and browsers, the extension connects to [Supabase](https://supabase.com) — a free, open-source database platform. See the **Supabase Setup** section below for full instructions. Once connected:

- Highlights sync automatically every 5 minutes in the background
- A manual **Sync now** button is available in the dashboard
- Each device registers itself — you can see which browser and device last synced
- Works across Chrome on your work PC, Brave or Microsoft Edge on your personal laptop, any combination

### Dashboard — All Highlights in One Place
Open the dashboard via **right-click extension icon → Options** (or the grid icon in the popup):

- All highlights grouped by domain, sorted by your choice
- **Sort options**: Newest first, Oldest first, By color, Domain A–Z, Notes first, Notes A–Z
- **Color filter**: filter to a single color instantly
- **Notes filter**: show only highlights that have notes, or only those without
- **Tag filter bar**: one-click filtering by any tag you've used
- **Search**: full-text search across highlight text, notes, tags, and URLs simultaneously
- **Per-card actions**: open the source page and scroll directly to the highlight, or delete
- **Per-domain delete**: remove all highlights from a domain in one click
- **Select mode**: checkbox-select specific highlights for bulk deletion
- **Reading progress**: a panel showing every domain you've visited, how many pages have highlights, and when you last visited
- Notes displayed in full on each card — not truncated

### Duplicate Detection
When you try to highlight text that is 82% or more similar to an existing highlight on the same page, the extension surfaces a warning showing the existing highlight and asks whether you want to save anyway or cancel. Prevents quietly accumulating duplicate annotations across sessions.

### Auto-Delete
In Settings you can configure automatic deletion of highlights older than 7, 30, 90 days, or 1 year. The background worker checks every hour and on browser startup. Deletions sync to Supabase so they propagate to all your devices.

---

## Storage — Will It Run Out?

**No, not for any realistic use.**

A single highlight with note and tags is approximately 300–500 bytes of JSON. `chrome.storage.local` has a default quota of 10MB, which holds roughly 20,000–30,000 individual highlights. A committed reader saving 20 highlights per day would take **3–4 years** to approach that limit. The extension can also request `unlimitedStorage` permission, which removes the cap entirely and makes available disk space the only limit.

For the Supabase cloud sync: the free tier provides **500MB of database storage**. At 500 bytes per highlight, that is **one million highlights** before you would need to consider upgrading. The free tier also supports unlimited reads and writes for personal use.

In short: storage is not a concern you will ever need to think about.

---

## Supabase Setup — Cloud Sync Across All Your Devices

Supabase is a free, open-source alternative to Firebase. Your data lives in a Postgres database in your Supabase account — not on any third-party server associated with this extension. The free tier is permanent and sufficient for any personal use.

### Step 1 — Create a Supabase account
Go to [supabase.com](https://supabase.com) and sign up for free. No credit card required.

### Step 2 — Create a project
Click **New project**. Choose any name (e.g. `web-highlighter`). Pick the region geographically closest to you. The database password can be anything — you won't need it again.

Wait about 60 seconds for the project to provision.

### Step 3 — Create the highlights table
In the left sidebar, go to **SQL Editor**. Paste and run the following:

```sql
-- Run in Supabase SQL Editor
CREATE TABLE IF NOT EXISTS highlights (
  id                TEXT PRIMARY KEY,
  text              TEXT NOT NULL,
  selector          JSONB,
  position_selector JSONB,
  color             TEXT NOT NULL DEFAULT 'yellow',
  note              TEXT DEFAULT '',
  tags              JSONB DEFAULT '[]',
  timestamp         BIGINT NOT NULL,
  url               TEXT NOT NULL,
  device_id         TEXT,
  browser           TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS highlights_url_idx       ON highlights(url);
CREATE INDEX IF NOT EXISTS highlights_timestamp_idx ON highlights(timestamp DESC);
ALTER TABLE highlights DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE highlights TO anon;
GRANT ALL ON TABLE highlights TO authenticated;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;

-- Add tags column if upgrading from earlier version
ALTER TABLE highlights ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]';
```

### Step 4 — Get your credentials
In the left sidebar, go to **Project Settings → API**. Copy two values:
- **Project URL** — looks like `https://xxxxxxxxxxxx.supabase.co`
- **anon public** key — a long JWT string starting with `eyJ...`

### Step 5 — Connect the extension
Right-click the Web Highlighter icon → **Options** → **Sync & Settings** tab. Paste your Project URL and anon key. Click **Save & Connect**.

The extension will immediately do a first sync and confirm the connection. From this point, install the extension on any other device, paste the same credentials, and all your highlights will appear.

---

## Installation

### Download from GitHub

#### Option A — Download as ZIP (easiest, no technical knowledge required)

1. Go to the repository page on GitHub
2. Click the green **Code** button near the top right
3. Click **Download ZIP**
4. Unzip the downloaded file — you will get a folder called `web-highlighter-main` or similar
5. Inside it, find the `extension` folder — this is what you need

#### Option B — Clone with Git (for developers)
```bash
git clone https://github.com/YOUR_USERNAME/web-highlighter.git
cd web-highlighter
```

---

### Install in Chrome (Windows, Mac, Linux)

1. Open Chrome and go to `chrome://extensions` in the address bar
2. In the top right, toggle **Developer mode** ON
3. Click **Load unpacked**
4. Navigate to and select the `extension` folder
5. The Web Highlighter icon will appear in your browser toolbar

> **To pin it**: Click the puzzle piece icon in the toolbar → click the pin next to Web Highlighter

---

### macOS — A Note on Unzipping
macOS unzips archives automatically when you double-click them. The resulting folder will be in your Downloads folder. You do not need any additional software.

### Windows — A Note on Unzipping
Right-click the downloaded ZIP file and select **Extract All**. Choose a destination folder. The `extension` folder will be inside the extracted result.

---

## How to Use

| Action | How |
|--------|-----|
| Highlight text | Select any text on a webpage → click a color in the tooltip |
| Quick highlight | Select text → press `Alt+H` |
| Add a note | Click a highlighted passage → type in the note field → Save |
| Add tags | Click a highlighted passage → type a tag → Enter |
| View all highlights | Click the extension icon → grid icon, or right-click → Options |
| Filter by tag | Open dashboard → click any tag in the tag filter bar |
| Search | Open dashboard → type in the search box |
| Jump to a highlight | Click any card in the dashboard — opens the page and scrolls to it |
| Delete a highlight | Click the highlight → Delete, or use the dashboard trash icon |
| Sync now | Open dashboard → Sync now button |

---

## Cost

**Completely free.**

- The extension itself: free, open source
- `chrome.storage.local`: built into the browser, free
- Supabase free tier: permanent, no credit card, 500MB storage, sufficient for millions of highlights

There are no paid tiers, no subscriptions, no limits that a personal user would ever reach.

---

## Frequently Asked Questions

**Will my highlights disappear if I clear my browser history?**
No. Highlights are stored in `chrome.storage.local`, which is separate from browsing history, cookies, and cache. Standard "Clear browsing data" does not touch extension storage. The only way to lose local highlights is to uninstall the extension or explicitly clear extension data.

**Do I need Supabase?**
No. The extension works fully offline and locally without any Supabase account. Supabase is only needed if you want your highlights to sync across multiple devices or browsers. If you only use one browser on one machine, you never need to configure it. Although you might hit capacity or lose your highlights if your browser crashes. 

**Does it work on every website?**
It works on any `http://` or `https://` page. It cannot run on browser internal pages (`chrome://`, `about:`) or the Chrome Web Store by browser security policy. It also does not work on native PDF viewer pages — though PDFs opened as HTML do work.

**My highlight disappeared after a page update. Why?**
This should be rare because of the text-quote anchoring strategy. If it happens, it means the exact text of the highlighted passage changed in the page source — the page was substantially rewritten, not just reflowed. The position fallback also failed, meaning the character offset no longer points to meaningful content. This is the fundamental limitation of client-side web annotation.

**Can I share my highlights with someone else?**
Not directly in the current version. All highlights in your Supabase database belong to whoever has the anon key. A sharing feature (read-only shared views via a public link) is a natural future addition.

**Is my data private?**
Your highlights are stored locally on your machine and optionally in your own Supabase project — a database you control. The extension sends no data to any third-party server. Your Supabase anon key is stored in `chrome.storage.local` on your machine and is never transmitted anywhere except to your own Supabase project.

**What happens if Supabase is down or I'm offline?**
The extension works entirely from local storage. Highlights save locally instantly. When connectivity is restored, the background sync picks up automatically. You will never lose a highlight due to a network issue.

**Can I export my highlights?**
Not yet as a built-in feature. Your data is accessible directly in the Supabase dashboard (Table Editor → highlights) where you can export as CSV. A one-click export to Markdown is a planned feature.

**The extension slowed down my browser. What should I do?**
This should not happen under normal use. If you have accumulated tens of thousands of highlights on a single page, the restore-on-load process could take a noticeable moment. If you experience this, use the auto-delete settings to prune old highlights.

**Does it work on PDFs?**
No. It does not support PDFs, social media. And for pages that require logins it will require that you be logged in to be taken directly to your highlight.

**I found a bug. Where do I report it?**
Open an issue on the GitHub repository with the page URL where it happened, what you were trying to highlight, and what went wrong. Screenshots help.

---

## Reproduce or Extend This Project

The following prompt was used to build this extension from scratch with Claude. If you want to build your own version — with different colors, additional features, a different sync backend, or modified behaviour — start here and adapt it to your needs.

---

### Base Prompt

```
Build a Chrome browser extension called "Web Highlighter" designed for
people who read extensive technical documentation and want persistent,
reliable text highlights across web sessions.

CORE REQUIREMENTS:

1. HIGHLIGHTING BEHAVIOR
- User selects text with mouse on any webpage
- A small color picker tooltip appears immediately below the selection
- Highlight is saved ONLY when user clicks a color (no auto-save timers)
- Highlighted text is visually colored on the page immediately
- Default color is yellow; last chosen color becomes new default
- Support 5 colors: Yellow (#fbbf24), Blue (#60a5fa), Green (#34d399),
  Red (#f87171), Purple (#a78bfa)

2. PERSISTENCE ENGINE (CRITICAL)
- Use the dom-anchor-text-quote and dom-anchor-text-position npm
  packages (published by the Hypothesis annotation project)
- Anchoring strategy must use TextQuoteAnchor as primary method:
  stores { exact, prefix, suffix } — not XPath or DOM paths
- TextPositionAnchor as fallback: stores character offset from body start
- On page load, resolve anchors using fuzzy text matching so highlights
  survive minor DOM changes, ads loading, and content reflows
- Bundle both libraries into a single anchoring.js file using webpack
  so they work as content scripts without requiring a module system
- Expose the bundle as a global variable: window.AnchoringLib

3. STORAGE
- Use chrome.storage.local (not sync) to avoid the 100KB sync limit
- Storage key structure: URL → array of highlight objects
- Each highlight object:
  { id, text, selector: {exact, prefix, suffix}, positionSelector:
  {start, end}, color, note, tags, timestamp, url }
- Store both quote and position selectors for redundancy

4. NOTES AND TAGS
- Each highlight can have a note (max 280 chars) and tags (array of strings)
- Clicking a highlight shows a tooltip with note textarea and tag input
- Tags added by typing and pressing Enter or comma
- Hover over highlight shows note/tag preview

5. DUPLICATE DETECTION
- Before saving, check Jaccard similarity against existing highlights
  on the same page. Warn if similarity >= 0.82 with option to save anyway

6. KEYBOARD SHORTCUT
- Alt+H highlights selected text with last-used color
- Flash outline confirmation instead of tooltip

7. SYNC WITH SUPABASE
- Use Supabase (free tier) as cloud sync backend
- API key stored in chrome.storage.local, entered once via Options page
- Sync runs every 5 minutes via alarms and on every save/delete
- Local-first: highlights save locally instantly, sync in background
- Pull remote on load, push local on save

8. DASHBOARD (Options page)
- All highlights grouped by domain
- Sort by: newest, oldest, color, domain, notes-first, notes A-Z
- Filter by: color, has-notes, no-notes, tag
- Full-text search across text, notes, tags, URLs
- Reading progress panel: domains visited, pages highlighted, last visited
- Bulk delete: select mode with checkboxes, delete visible, delete all
- Per-domain delete button
- Auto-delete preference: never / 7 / 30 / 90 days / 1 year

9. MANIFEST & ARCHITECTURE
- Manifest V3
- Permissions: storage, activeTab, scripting
- Host permissions: <all_urls>
- Content scripts load order: anchoring.js first, then content.js
- run_at: document_idle

TECHNICAL CONSTRAINTS:
- Do NOT use XPath, TreeWalker path recording, or DOM structure paths
- Do NOT use window.find()
- Do NOT use chrome.storage.sync
- Use <span> not <mark> for highlight elements — mark has UA stylesheet
  defaults that documentation sites override, breaking list item layout
- All highlight spans must set display, padding, margin, line-height,
  vertical-align, and position inline with !important to prevent page
  CSS from interfering
- Do NOT use ::after pseudo-elements on highlight spans — these stretch
  line box height inside list items even with line-height:0
- All UI tooltips use z-index: 999999 and position absolute
- UI positioned using getBoundingClientRect() + window.scrollY
```

---

### Suggested Extensions to the Base Prompt

Add any of the following to the base prompt to get additional features:

- *"Add an AI-powered summary feature: select a tag or domain in the dashboard, click Summarise, and call the Anthropic API to produce a structured digest of all highlights and notes under that grouping."*
- *"Add semantic search using embeddings: store a vector embedding for each highlight text in Supabase's pgvector extension. At search time, embed the query and return highlights by cosine similarity."*
- *"Add highlight collections: named groups that span across domains. Each highlight can belong to one or more collections. Collections are filterable in the dashboard and deletable as a unit."*
- *"Add a spaced repetition mode: the popup surfaces one highlight per day as a flashcard, hiding the source URL and asking the user to recall the context. The note becomes the answer."*
- *"Add Markdown export: a button in the dashboard that exports all visible highlights as a structured .md file with source URLs, timestamps, notes, and tags — formatted for Obsidian or Notion."*

---

## License

MIT — free to use, modify, and distribute.

---

## Acknowledgements

- [Hypothesis](https://hypothes.is) — for the `dom-anchor-text-quote` and `dom-anchor-text-position` libraries that make persistent anchoring possible
- [Supabase](https://supabase.com) — for the free, open-source database platform that powers cross-device sync
- Built with [Claude](https://claude.ai) by Anthropic
