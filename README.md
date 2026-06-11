# Persistent Web Highlighter

A browser extension for Chrome and Firefox that lets you highlight text on any webpage, attach notes and tags, and sync everything across your devices through a free Supabase backend. Highlights survive page refreshes, browser restarts, and reinstalls. Your data belongs to you.

DISCLAIMER: THIS TOOL HAS BEEN CREATED USING CLAUDE AI IN ITS ENTIRETY

---

## Table of Contents

- [Why This Exists](#why-this-exists)
- [Feature Overview](#feature-overview)
- [File Structure](#file-structure)
- [Installation](#installation)
- [Supabase Setup](#supabase-setup)
- [How to Use](#how-to-use)
  - [Creating Highlights](#creating-highlights)
  - [Notes and Tags](#notes-and-tags)
  - [The Dashboard](#the-dashboard)
  - [View Modes](#view-modes)
  - [Filtering and Search](#filtering-and-search)
  - [Exporting](#exporting)
  - [Sync and Your Account](#sync-and-your-account)
  - [Auto-Delete](#auto-delete)
- [Security Architecture](#security-architecture)
- [Database Schema](#database-schema)
- [How Sync Works](#how-sync-works)
- [SPA and Dynamic Page Support](#spa-and-dynamic-page-support)
- [FAQ](#faq)


---

## Why This Exists

Most highlighter extensions tie your highlights to a single browser install. Reinstall the extension, switch browsers, or use a second device and everything is gone. This extension solves that by pairing local-first storage (fast, works offline) with optional Supabase cloud sync tied to a real user account — not an anonymous session — so your highlights follow your login, not your machine.

---

## Feature Overview

### Highlighting
- Highlight any selected text on any webpage with one click
- Eight pastel highlight colors: Yellow, Blue, Green, Red, Purple, Orange, Teal, Pink
- Color picker appears on text selection — no toolbar, no UI chrome
- Color memory — the extension remembers your last used color
- Duplicate detection warns before creating the same highlight twice on a page
- Keyboard shortcut `Alt+H` to highlight selected text with the last used color

### Notes and Tags
- Each highlight can carry a note up to 280 characters
- Notes saved inline — no separate save step required
- Tag any highlight with multiple labels (press Enter or comma to add)
- Tags are searchable and filterable across the entire dashboard
- Hover over any highlight on a page to preview its note and tags without opening the tooltip

### Dashboard (`options.html`)
- Two-panel layout: collapsible sidebar + scrollable content area
- Three view modes with persistent preference: Grid (auto-fill card columns), List (single-column with notes visible), Compact (34px dense rows with hover peek)
- Full-text search across highlight text, notes, tags, and URLs
- Sort by: Newest first, Oldest first, By color, Domain A–Z, Notes first, Notes A–Z
- Filter by color, domain, tag, or quick filters (Today, Has notes, Untagged)
- Active filter shown as a dismissible chip in the toolbar
- Bulk operations: delete visible highlights, delete all highlights, checkbox multi-select mode
- Domain-grouped display with collapsible sections and per-domain delete
- Inline domain favicons in sidebar and domain headers
- Reading progress tracking per domain

### Export
- Export as styled HTML — self-contained file with all highlights, notes, tags, and source links
- Export as PDF — print-optimized layout via browser print dialog

### Sync
- Cloud sync via your own free Supabase project
- Email and password account — same credentials on any device pulls your highlights
- Auto-sync every 5 minutes in the background
- Manual sync button in both the topbar and the settings panel
- Soft deletes with 30-day tombstone window — deletions propagate to all devices
- Server-side purge via `pg_cron` — no client needs to be online for cleanup
- Device ID tracking — see which devices have synced

### UI
- Dark mode by default, light mode toggle in the topbar (persisted)
- Highlight colors preserved in both themes as product identity
- Settings panel toggled from the gear icon — clicking again returns to the dashboard without refreshing
- Syne typeface for headings and UI labels, IBM Plex Mono for metadata and counts
- Responsive grid adapts to available panel width

---

## File Structure

```
extension/
├── manifest.json        MV3 manifest — permissions, content scripts, service worker
├── anchoring.js         Bundled dom-anchor-text-quote + dom-anchor-text-position
│                        (same anchoring library used by Hypothesis)
├── content.js           Highlight engine: selection, color picker, notes tooltip,
│                        tag editing, duplicate detection, SPA navigation detection
├── content.css          Highlight span styles, color picker, note tooltip, dupe warning
├── background.js        Service worker: Supabase auth, sync engine, tombstone logic,
│                        auto-delete, message routing
├── popup.html           Extension popup — current-page highlight list
├── popup.css            Popup styles
├── popup.js             Popup logic — renders page highlights, link to dashboard
├── options.html         Dashboard — two-panel layout with topbar
├── options.css          Dashboard styles — dark + light themes, all three view modes
├── options.js           Dashboard logic — rendering, filtering, sidebar, export, settings
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Installation

### Load Unpacked (Development)

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked** and select the `extension/` folder
5. The extension icon appears in your toolbar
6. Click the icon, then open the dashboard to configure Supabase

### Firefox

1. Navigate to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select any file inside the `extension/` folder
4. Note: temporary add-ons are removed on browser restart in Firefox development mode

### Chrome Web Store / Firefox Add-ons

For production distribution, package the extension folder as a `.zip` and submit through the respective developer portals.

---

## Supabase Setup

Supabase provides the cloud database. You create a free project and the extension connects to it. Your data lives in your own Supabase project — not a shared server.

### Step 1 — Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a free account
2. Create a new project — choose any name and region
3. Wait for the project to finish provisioning (about 60 seconds)

### Step 2 — Run the setup SQL

1. In your Supabase project, go to **SQL Editor**
2. Open the extension dashboard (click the extension icon → open dashboard → Settings)
3. Copy the SQL from the **Step 1** section and paste it into the SQL Editor
4. Click **Run**

The SQL creates the `highlights` table, enables Row Level Security, creates the user isolation policy, scopes grants, sets up a `pg_cron` daily purge job, and adds an insert rate limit trigger.

### Step 3 — Get your API credentials

1. In your Supabase project go to **Project Settings → API**
2. Copy the **Project URL** (looks like `https://xxxxxxxxxxxx.supabase.co`)
3. Copy the **anon public** key (the long `eyJ...` string — this is safe to share)

### Step 4 — Connect the extension

1. Open the extension dashboard → Settings → **Step 2: Connect Your Project**
2. Paste your Project URL and anon key
3. Click **Save Project**

### Step 5 — Create your account

1. In **Step 3: Your Account**, click **Create Account**
2. Enter an email and password (minimum 8 characters)
3. Click **Create Account** — the extension signs in and syncs immediately

On any other device or after reinstalling, go to **Sign In** and enter the same email and password. All your highlights will pull down automatically.

> **Email confirmation:** Supabase may require you to confirm your email before signing in. Check your inbox after creating the account. If you want to skip this during development, go to Supabase → Authentication → Providers → Email → disable "Confirm email."

---

## How to Use

### Creating Highlights

1. Select any text on any webpage
2. A color picker appears above or below the selection
3. Click a color circle to save the highlight
4. The highlight is immediately saved locally and queued for cloud sync
5. Highlights persist across page refreshes, navigation, and browser restarts

**Keyboard shortcut:** Select text and press `Alt+H` to highlight with your last used color, skipping the picker.

**Duplicate detection:** If you try to highlight text that overlaps an existing highlight, a warning appears showing the existing text. You can save it anyway or cancel.

### Notes and Tags

Click any existing highlight on a page to open its tooltip.

**Notes**
- Type in the text area — up to 280 characters
- Click **Save** or press outside to save
- A character counter shows remaining space
- Notes appear as a blue-tinted block on dashboard cards and as a hover preview on the page

**Tags**
- Type a tag name in the tag input and press **Enter** or **,** to add it
- Tags appear as chips in the tooltip
- Click the × on any chip to remove it
- Tags are saved with the note — one Save action commits both

**Hover preview:** Hover over any highlighted text for a moment to see its note and tags in a floating preview, without opening the full tooltip.

### The Dashboard

Open the dashboard by clicking the extension icon → grid icon, or right-clicking the extension → Options.

The dashboard has three areas:

**Topbar** — brand, full-text search bar, view mode toggles (grid/list/compact), theme toggle (dark/light), export menu, sync button, settings gear.

**Sidebar (220px)** — All button with total count, domain list with favicons and counts, tag chips, quick filters (Today / Has notes / Untagged), color filter swatches, sync status indicator.

**Content area** — sticky toolbar with result count, active filter chip, sort selector, bulk delete menu. Below: highlights grouped by domain with collapsible sections.

### View Modes

Toggle between view modes using the buttons in the topbar. Your preference is saved.

**Grid** (default)
Cards arranged in an auto-fill grid. Each card shows: highlight text (3-line truncation), note block if present, tag chips, source URL, relative time. Action buttons (open page, delete) appear on card hover.

**List**
Single-column rows showing more of the highlight text and notes inline. Suited for reading through highlights in order.

**Compact**
Fixed 34px rows — maximum density. A colored left bar replaces the colored card border. Text is single-line truncated. Hover over any row to see the full text, note, and tags in a peek card that follows your cursor.

### Filtering and Search

**Search** — The topbar search bar queries highlight text, note content, tag names, and source URLs simultaneously. Results update as you type.

**Sidebar filters** — Click any domain, tag chip, or quick filter in the sidebar to narrow the content area to that subset. The active filter appears as a dismissible chip in the content toolbar. Click the × on the chip or click **All** to clear. Sidebar filters combine with color filters and search.

**Color filters** — Color swatches in the sidebar filter to highlights of that color. **All** resets.

**Quick filters**
- **Today** — highlights created since midnight
- **Has notes** — highlights with any note text
- **Untagged** — highlights with no tags assigned

**Sort options** (sort selector in toolbar)
- Newest first / Oldest first
- By color
- Domain A–Z
- Notes first
- Notes A–Z

### Exporting

Click **Export** in the topbar.

**Export as HTML** — Downloads a self-contained `.html` file. Includes all visible highlights (respects current filters), grouped by domain, with notes, tags, source links, and timestamps. Fully styled — open in any browser.

**Export as PDF** — Opens the browser print dialog with a print-optimized version of the same content. Use **Save as PDF** in the print dialog. Highlight colors are preserved in print output.

### Sync and Your Account

**How identity works:** Your email and password create a Supabase auth account. Every highlight is stored with your user ID. Any device that signs in with the same credentials can read and write your highlights — no sharing of device IDs or config files required.

**Sync flow:**
1. On sign-in, a full pull runs immediately, downloading all your cloud highlights
2. Background sync runs every 5 minutes
3. When you create or delete a highlight, a sync message is sent to the service worker immediately
4. Manual sync via the **Sync** button in the topbar or the **Sync now** button in Settings

**Sessions:** The JWT session is stored locally and refreshed automatically before it expires. If a refresh fails (e.g. you signed out on another device), the extension prompts you to sign in again the next time it tries to sync.

**Signing out:** Settings → Your Account → Sign out. Your local highlights are kept. Sign in again to re-sync.

**Changing devices:** Install the extension, go to Settings, enter your Supabase URL and anon key (same as before — these don't change), then sign in with your email and password. Sync runs automatically.

### Auto-Delete

Settings → Auto-Delete. Choose a retention period: Never, 7 days, 30 days, 90 days, 1 year.

When enabled, highlights older than the chosen period are deleted from local storage and soft-deleted in Supabase on the next auto-delete run (every hour). **Run now** triggers an immediate pass.

Note: auto-delete runs in the client. Server-side purge of soft-deleted rows (rows with `deleted_at` set) runs independently via `pg_cron` at 3am UTC daily regardless of client activity.

---

## Security Architecture

The extension was designed to be safe to distribute publicly. The threat model covers: anon key exposure, cross-user data access, data injection, storage abuse, and session hijacking.

### Row Level Security

Every row in the `highlights` table has a `user_id` column bound to `auth.uid()` — Supabase's function that reads the UUID from the incoming JWT. The RLS policy:

```sql
CREATE POLICY "user_isolation" ON highlights
  FOR ALL
  USING     (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
```

This means a request carrying User A's JWT physically cannot read, write, or modify User B's rows. The policy is enforced server-side by PostgreSQL before any data is returned or written.

### Why the Anon Key Being Public Is Safe

The Supabase anon key identifies your project — it says "which database" not "who are you". With RLS enabled, the anon key alone cannot read any data. All data access requires a valid user JWT, which is only issued after email/password authentication. This is the intended Supabase security model.

### Scoped Database Grants

```sql
GRANT SELECT, INSERT, UPDATE ON TABLE highlights TO anon;
```

`DELETE` is not granted. The extension uses soft deletes (PATCH to set `deleted_at`) exclusively. Hard deletes only happen server-side via `pg_cron`, scoped to the authenticated user's rows.

### Insert Rate Limiting

A `BEFORE INSERT` trigger prevents more than 200 inserts per minute per user. This blocks bulk injection abuse even if credentials are compromised.

### Session Security

- Auth sessions are stored in `chrome.storage.local` (not `localStorage` or cookies)
- Sessions are automatically refreshed before expiry
- When config is cleared or the user signs out, the session is revoked server-side and cleared locally
- A new device cannot impersonate an existing user — they must know the password

---

## Database Schema

```sql
CREATE TABLE highlights (
  id                TEXT PRIMARY KEY,          -- wh_{timestamp}_{random}
  text              TEXT NOT NULL,             -- selected text
  selector          JSONB,                     -- dom-anchor-text-quote selector
  position_selector JSONB,                     -- dom-anchor-text-position fallback
  color             TEXT NOT NULL DEFAULT 'yellow',
  note              TEXT DEFAULT '',
  tags              JSONB DEFAULT '[]',        -- array of tag strings
  timestamp         BIGINT NOT NULL,           -- ms since epoch
  url               TEXT NOT NULL,             -- normalized page URL
  device_id         TEXT,                      -- originating device
  browser           TEXT,                      -- chrome | firefox | edge
  deleted_at        TIMESTAMPTZ DEFAULT NULL,  -- soft delete timestamp
  user_id           UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
```

### Indexes

| Index | Purpose |
|---|---|
| `highlights_url_idx` | Fast per-page highlight load |
| `highlights_timestamp_idx` | Sort by newest/oldest |
| `highlights_user_idx` | RLS policy evaluation |
| `highlights_deleted_at_idx` (partial) | Efficient purge queries |

---

## How Sync Works

### Pull (Cloud → Local)

1. Fetch all rows for `auth.uid()` from Supabase ordered by timestamp descending
2. Split into active rows (`deleted_at IS NULL`) and deleted rows (`deleted_at IS NOT NULL`)
3. For deleted rows: add their IDs to the local tombstone set, remove them from `chrome.storage.local`
4. For active rows: merge into local storage by URL key. A remote row replaces a local row only if `remote.timestamp > local.timestamp` — this prevents older cloud data from overwriting newer local edits

### Push (Local → Cloud)

1. Collect all highlights from `chrome.storage.local`
2. Filter out any IDs present in the tombstone set (avoids re-uploading deleted items)
3. `POST` to Supabase with `Prefer: resolution=merge-duplicates` — this upserts by primary key, so existing rows are updated and new rows are inserted in a single request

### Tombstones

When you delete a highlight, its ID is added to a local tombstone set in `chrome.storage.local`. On every sync:
- Tombstone IDs are excluded from push (won't be re-uploaded)
- Any cloud rows matching tombstone IDs that appear as active are re-patched with `deleted_at` (re-enforcement pass)

Tombstones prevent the classic sync resurrection bug: without them, deleting on device A and then syncing from device B would re-upload the deleted highlight.

### Soft Deletes and Purge

Deleting a highlight sets `deleted_at` on the row rather than hard-deleting it. This lets other devices see the deletion and apply it locally. The `pg_cron` job runs daily and hard-deletes any row where `deleted_at` is older than 30 days. The client also runs a purge pass on startup as a fallback.

---

## SPA and Dynamic Page Support

Single-page applications (React, Vue, Angular, Next.js, and others) navigate without triggering a full page load. The extension detects URL changes via three independent signals:

1. **Intercepted `history.pushState` and `history.replaceState`** — catches framework-level navigation
2. **`popstate` and `hashchange` events** — catches browser back/forward and hash navigation
3. **500ms polling fallback** — catches frameworks that bypass the History API entirely (AWS Console and AWS docs are the primary real-world case)

When a URL change is detected:
1. All rendered highlight spans are removed from the DOM cleanly (text nodes restored)
2. Color picker and tooltips are closed
3. After a 700ms delay (for the SPA to finish rendering its new content), highlights for the new URL are restored

Hash fragments are preserved in the storage key. A URL like `docs.example.com/guide#installation` and `docs.example.com/guide#configuration` are treated as separate pages and store separate highlight sets.

---

## FAQ

**Q: Do my highlights survive a page refresh?**
Yes. Highlights are saved to `chrome.storage.local` immediately on creation. They are restored on every page load before the page becomes interactive.

**Q: Do my highlights work without Supabase?**
Yes. Supabase sync is entirely optional. Without it, highlights are stored locally only and persist until you uninstall the extension or clear browser data. You lose cross-device sync and the ability to recover highlights after a reinstall.

**Q: What happens if I reinstall the extension without Supabase configured?**
Local storage is cleared on uninstall. If you had Supabase configured and an account, install the extension again, enter your project URL and anon key, and sign in. All your cloud highlights will pull down on first sync.

**Q: Can I use the same account on multiple browsers at the same time?**
Yes. Each browser gets its own device ID but shares the same user account. Syncs merge highlights from all devices. Deletions propagate to all devices within the next sync cycle (up to 5 minutes).

**Q: What is the anon key and is it safe to share?**
The anon key is a public identifier for your Supabase project — it is not a secret and is safe to include in a published extension. It does not grant data access on its own. All data access requires a valid user JWT obtained after email/password authentication. Row Level Security enforces this server-side.

**Q: Can other users of my extension see my highlights?**
No. Row Level Security ensures every database query is scoped to the requesting user's ID. A user with valid credentials for your Supabase project can only ever read their own rows.

**Q: Why does the extension open the options page on first install?**
To guide you through Supabase setup and account creation. Without an account, sync is unavailable and highlights are local-only. The onboarding is designed to be completable in under 5 minutes.

**Q: What happens to deleted highlights?**
Deleting a highlight sets a `deleted_at` timestamp on the database row. The row stays in Supabase for 30 days so other devices can see the deletion and remove it locally. After 30 days, a scheduled server-side job (`pg_cron`) hard-deletes the row permanently. You never need to manage this manually.

**Q: Can I export my highlights?**
Yes. The dashboard Export menu (topbar) offers HTML and PDF. HTML exports are self-contained files you can open offline. PDF export uses the browser print dialog — choose Save as PDF. Both formats respect active filters, so you can export highlights for a specific domain, tag, or color.

**Q: Does it work on Chrome and Firefox?**
Yes. The extension uses the MV3 manifest format and the WebExtensions API. Both browsers support the full feature set. Firefox users loading as a temporary add-on will need to reload the extension after each browser restart during development.

**Q: Does it work on SPAs like Twitter, GitHub, or AWS?**
Yes. The SPA detection covers `pushState`, `replaceState`, `popstate`, `hashchange`, and a 500ms polling fallback for frameworks that bypass the History API. AWS documentation specifically was a primary test case.

**Q: What data is stored locally?**
Highlights are stored in `chrome.storage.local` under keys prefixed `wh_`. Your Supabase credentials (URL and anon key) and your auth session (JWT) are also stored in `chrome.storage.local`. Nothing is written to `localStorage`, cookies, or sent to any third-party server. The only external network calls are to your own Supabase project.

**Q: How do I change my password?**
Supabase does not expose a direct password change endpoint in the client without the current session. The simplest approach is to use the Supabase dashboard: Authentication → Users → find your email → send a password reset email.

**Q: Can I host the Supabase backend myself?**
Yes. Supabase is open source. Replace the Project URL in settings with your self-hosted instance URL. The SQL schema and RLS policies are identical.

**Q: What is the free tier limit on Supabase?**
As of 2024, Supabase free tier includes 500MB database storage and 2GB bandwidth per month, with up to 50,000 monthly active users. For personal use or a small team, you will not hit these limits.

---
## License

MIT. Use, modify, and distribute freely with attribution.

---

*Built with dom-anchor-text-quote (MIT), dom-anchor-text-position (MIT), and Supabase (Apache 2.0).*
