# Tennis team results & standings — multi-club

A simple, branded web page that collects a club's LTA (and NPL) tennis team results,
standings, fixtures and a player leaderboard into one mobile-friendly view, so members
don't have to navigate the LTA competition site. **One shared codebase serves many
clubs**, each with its own branded page.

**Live:** https://pclutton.github.io/lta-club/ (Paddington Sports Club; Cumberland LTC at `/cltc/`)

---

## How it works

```
LTA site ──(nightly scraper)──▶ clubs/<slug>/data/results.js ─┐
                                                              ├─(build)──▶ _site/<slug>/ ──▶ GitHub Pages
app/index.html  +  clubs/<slug>/club.json ────────────────────┘
   shared shell        per-club branding + scrape config
```

- **`app/index.html`** — the entire app (no framework, no build step for the page
  itself). It carries *no* club identity: branding (name, logo, colours, nav, social,
  the home-club row matcher) all come from `window.__CLUB__`, and the data from
  `window.__RESULTS__`. Renders a tab per competition, a team table, standings /
  head-to-head matrix / players views, and a club-wide player leaderboard.
- **`clubs/<slug>/`** — everything specific to one club, and nothing else:
  - `club.json` — branding **and** the scraper's `scrape` block (see below).
  - `assets/logo.png` + `icon-180/192/512.png` (home-screen icons).
  - `data/results.js` — that club's scraped data (`window.__RESULTS__ = { … }`),
    committed by the scraper.
- **`scraper/scrape.mjs`** — Node + Playwright. Loops every `clubs/*/club.json` and,
  per club, discovers the leagues it's entered in and scrapes each division. **Fails
  safe per club**: a transient hiccup keeps that club's last-good data (retries,
  regression/▷ richness guards, `lastSeen`-based retention; see comments in the file).
- **`scripts/build-site.mjs`** — assembles `_site/<slug>/` from `app/index.html` +
  each club folder (writes `club.js`, copies data/assets, generates the manifest), and
  a root `index.html` that redirects to the default club so the original URL keeps working.
- **`scripts/make_icon.py`** — generates a club's home-screen icons from its crest +
  brand colours: `uv run --with pillow python scripts/make_icon.py <slug>`.
- **`.github/workflows/update-results.yml`** — nightly (and on demand): scrape all
  clubs → commit changed data → build `_site` → deploy. A plain push just rebuilds and
  deploys (no scrape).

### `club.json` scrape sources

`scrape.sources` is a list, so a club can pull from several places:

- `{ "type": "group", "url": "…/association/group/<GUID>" }` — crawl a county/association
  group page for the year and auto-find every league the club is in (no GUIDs to maintain).
- `{ "type": "leagues", "leagues": [{ "id": "<GUID>", "name": "…" }] }` — explicit
  modern-site league GUIDs.
- `{ "type": "link", "name": "NPL …", "url": "https://npltennis.com/results" }` — a
  link-only tab (no table scraped).

**NPL note:** the NPL publishes results through LTA's *legacy* `/sport/draw.aspx`
interface, which has a different page structure from the modern `/league/` site this
scraper parses. So NPL is currently shown as a **link-out tab**; table-scraping the
legacy interface is a possible future addition.

## Add a club

1. `clubs/<slug>/club.json` — name, shortName, matcher (regex that matches the club's
   rows in a standings table, e.g. `"cumberland"`), colours, nav, social, address, and
   the `scrape` block (clubSearch + sources).
2. `clubs/<slug>/assets/logo.png` — the crest; then
   `uv run --with pillow python scripts/make_icon.py <slug>`.
3. Push. The nightly run (or a manual dispatch) scrapes it and it appears at `/<slug>/`.

Because each club folder is self-contained and the app is a single shared file,
extracting a club to its own repo later is a copy-paste relocation, not a rewrite.

## Local preview

No Node? The page is static once built. With Node:

```bash
cd scraper && npm install && cd ..   # Playwright (only needed to scrape)
node scripts/build-site.mjs          # assemble _site/
python -m http.server 8000 --directory _site   # visit http://localhost:8000/psc/
```

To scrape locally: `cd scraper && npm run scrape` (or `DEBUG=1 npm run scrape` to dump
page HTML to `scraper/debug/` when adjusting selectors).

### Login: not normally needed

The LTA league/standings pages are public; the scraper reads them anonymously. An
optional login is supported via `LTA_USERNAME` / `LTA_PASSWORD` env vars (locally) or
repository secrets (for the Action) — never commit credentials.

## Roadmap / TODO

- **Knockout cups & NPL are link-only — do better.** Cup competitions (e.g. Middlesex
  Summer Cup) and NPL currently show as a tab that links out, because they have no
  league table. Render the actual **knockout draw** instead (bracket / rounds + match
  results), scraped from the draw page. NPL additionally needs a parser for LTA's
  legacy `/sport/draw.aspx` interface (different DOM from the modern site).

## Status

Working prototype / proposal. PSC runs on the live LTA feed; Cumberland is newly
onboarded (its brand colour is sampled from its crest and is easily adjusted in
`clubs/cltc/club.json`).
