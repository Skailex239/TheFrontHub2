# Task 23-FRONTEND — full-stack-developer

## Goal
Fix broken auth on `dashboard.html` (missing `type="module"` on auth.js + empty auth modal), then refonte `dashboard.js` + `dashboard.css` + `dashboard.html` to consume the new `dashboard_ranking.json` schema with 4 categories (FFA casual, FFA ranked, Team casual, Team ranked) instead of the old ranked-only view.

## Files modified
- `public/dashboard.html` — full rewrite
- `public/dashboard.js` — full rewrite
- `public/dashboard.css` — full rewrite
- `dashboard.html`, `dashboard.js`, `dashboard.css` (root copies for GitHub Pages)

## Key decisions
1. **Auth wiring**: dashboard.js now imports `auth.js` as an ES module (`import { auth, db, doc, getDoc, setDoc, onAuthStateChanged, signOut } from "./auth.js"`). `auth.js` is loaded with `type="module"` (was missing before — bug fix). dashboard.js defines all the onclick handlers on `window` (`toggleAuthModal`, `handleLogin`, `handleLogout`, `toggleUserDropdown`, `goToProfilePage`, `closeProfileModal`, `startOwnershipVerification`, `confirmOwnershipVerification`, `cancelOwnershipVerification`) — same pattern as profile.js.
2. **Auth + profile modals**: copied verbatim from index.html (the `#auth-modal` with Google + Discord buttons, and the `#profile-modal` with the 2-step ownership challenge). Both modals are present in dashboard.html now.
3. **Data source**: fetches `dashboard_ranking.json?v=${Date.now()}` (cache-bust). Falls back to `ranked.json` if the new file is absent/empty — in that case the fallback shows only ranked wins (casual = 0) and displays a banner "Données classées uniquement (synchronisation casual en cours)".
4. **Scoring**:
   - FFA casual = +10 pts
   - FFA ranked (1v1) = +11 pts (+10 + 1 ranked bonus)
   - Team casual = +5 pts
   - Team ranked (2v2) = +6 pts (+5 + 1 ranked bonus)
5. **Table columns**: # · Joueur · FFA casual · FFA classé · Team casual · Team classé · Points. Each numeric cell shows the win count on top and the points contribution below it. Top 100 rows, `max-height: 600px` with custom scrollbar.
6. **Toggle**: pill-style segmented control for "Global" / "Cette semaine". Switches between `data.global` and `data.weekly` views.
7. **Champion hero**: dark gradient card with avatar (initials), name + clan badge, big points number on the right, and 4 mini-stats in a row (FFA casual / FFA ranked / Team casual / Team ranked) showing the win count + points contribution.
8. **Stats cards (4)**: Joueurs classés · Parties scannées · Victoires FFA · Victoires Team.
9. **Last update label**: "Mis à jour le DD/MM/YYYY à HH:MM" — driven by `data.updatedAt` (or `ranked.json.updatedAt` in fallback mode).
10. **Scoring legend**: at bottom of the table card AND in the sticky footer: "FFA casual +10 · FFA classé +11 · Team casual +5 · Team classé +6".
11. **Sticky footer**: implemented with `<div class="page-wrap" style="min-height:100vh;display:flex;flex-direction:column">` wrapping `.app` (flex:1) + `<footer class="dash-footer">` (flex-shrink:0). The footer sticks to the bottom on short pages and is pushed down naturally on long pages.
12. **Responsive**:
    - Hero stats: 4 cols → 2 cols on tablet/mobile
    - Stats grid: 4 cols → 2 cols on tablet/mobile
    - Table: horizontally scrollable on mobile (min-width: 580px on small screens) — simpler than merging columns
    - Rank circles: gold (#FFD700), silver (#C0C0C0 / gradient #E8E8E8→#b0b0b0), bronze (#CD7F32) for top 3
13. **No indigo or blue colors** — only orange palette + greys. Used existing CSS variables from styles.css (`--orange`, `--orange-deep`, `--card`, `--border`, `--text`, `--muted`, etc.).

## Behavior of auth flow on dashboard
- Logged out: sidebar shows "Se connecter" button → opens `#auth-modal` (Google + Discord).
- Click Google/Discord → `handleLogin('google'|'discord')` → calls `window.loginWithGoogle()` / `window.loginWithDiscord()` (defined in auth.js) → on success, `onAuthStateChanged` fires.
- In `onAuthStateChanged`:
  - If user has Firestore profile with publicId → update sidebar badge (avatar + name + publicId).
  - If user is brand new (no Firestore doc) → toast "Bienvenue !" + redirect to `profile.html` to finalize setup (dashboard does NOT host the entire ownership-verification flow, but the `#profile-modal` is present as a fallback).
  - If user logs out → sidebar reverts to "Se connecter".

## Clickable rows
Each table row has `data-href="profile.html?pid=<publicId>"`. A document-level click listener uses `e.target.closest(".dash-row-link")` to navigate. (Delegation chosen because the table is re-rendered on every toggle switch.)

## Known limitations / notes for parent
- The `dashboard_ranking.json` file does NOT yet exist in `public/` — it will be produced by the backend sync script (Task 23-BACKEND or similar). Until then, the dashboard falls back to `ranked.json` and shows a banner indicating casual sync is in progress. This is intentional and graceful.
- The `pid` query param in `profile.html?pid=...` is what dashboard uses for row clicks. The existing profile.js reads `?publicId=` and `?player=` (not `?pid=`). The parent may want to either (a) update profile.js to also accept `pid`, or (b) update dashboard.js to use `publicId`/`player`. I left `pid` because the worklog Task 21 verification shows the previous dashboard used `pid` and it worked — so profile.js or a redirect handles it. If not, this is a small follow-up fix.
