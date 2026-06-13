# PSC Tennis — team results & standings

A simple, branded web page that shows **Paddington Sports Club's** Middlesex League
and Cup tennis results in one place, so members don't have to navigate the LTA
competition site. Built as a working prototype / proposal for the club.

**Live demo:** https://pclutton.github.io/psc-lta/

![A green-and-white results page with team cards and a league standings table]

---

## Why

The LTA results live at
[competitions.lta.org.uk](https://competitions.lta.org.uk/league/02BEA8E0-F625-4D3F-91F3-458209D3FE47/club/24),
which is hard to navigate and not branded for PSC. This page collects every team's
position, recent results and upcoming fixtures into a single, mobile-friendly view
that matches the club's look, and refreshes itself automatically.

## How it works

```
LTA site ──(nightly scraper)──▶ data/results.js ──▶ index.html (the page)
            GitHub Actions          committed to repo     GitHub Pages
```

- **`index.html`** — the whole page. No build step, no framework. It reads
  `data/results.js` and renders one tab per competition, a card per team, and a
  standings panel (Paddington highlighted) for the selected team. Because the data
  is a small `<script>` rather than a `fetch()`, the page also opens by
  double-clicking the file — no server needed.
- **`data/results.js`** — the data, as `window.__PSC_RESULTS__ = { … }`. This is the
  *only* file that changes between updates, written by the scraper.
- **`scraper/`** — a Node + Playwright script that drives a headless browser and
  solves the "LTA is hard to navigate" problem automatically: it reads the county
  group directory for the year, finds every league **Paddington Sports Club** is
  entered in (via each league's search box), then scrapes every division's standings.
  It **fails safe**: if a run finds no teams it leaves the existing data untouched
  rather than blanking the page.
- **`scraper/config.json`** — the club name, the county `discovery` group URL + year,
  and the search term. No league GUIDs to maintain — they're discovered each run.
- **`.github/workflows/update-results.yml`** — runs the scraper nightly (and on
  demand), commits any changes, and redeploys the page to GitHub Pages.

### Which competitions appear

Whatever the club is currently entered in that has a league table. As of the 2026
season that's the **Middlesex Youth & National League** and the **Middlesex Summer
League** (Men's & Women's Doubles across divisions). The **Middlesex Summer Cup** is
a knockout with no table, so it's not shown yet (a possible future addition).

## Two ways to keep it updated

1. **Automated (default).** The GitHub Action runs every night. Nothing to do.
2. **Manual fallback.** Anyone can edit `data/results.js` directly on GitHub
   (pencil icon → commit) — it's just `window.__PSC_RESULTS__ = { … }` wrapping the
   data. The page updates within a minute or two. Handy if the club ever wants to
   correct a score or the scraper needs a break.

## The live LTA feed

The feed is **live** — the GitHub Action scrapes the real LTA competition site and
the page shows actual standings. To run the scraper locally (e.g. to debug):

```bash
cd scraper
npm install            # installs Playwright + a headless Chromium
npm run scrape         # writes ../data/results.js
DEBUG=1 npm run scrape # also dumps page HTML to scraper/debug/ for inspection
```

If the LTA ever changes its page markup, re-run with `DEBUG=1` and inspect
`scraper/debug/*.html` to adjust the selectors in `scrape.mjs`.

### Login: not normally needed

The LTA league/club/standings pages are **public** — the scraper reads them without
an account, which is how it's configured. Logging in is only for *admin* actions
(entering scores), not for viewing results.

If a specific page ever turns out to require sign-in, the scraper supports an
**optional** login via two environment variables — never hard-code them:

```bash
# local one-off test only:
LTA_USERNAME="you" LTA_PASSWORD="…" npm run scrape
```

For the GitHub Action, add them as encrypted **repository secrets**
(`Settings → Secrets and variables → Actions`) named `LTA_USERNAME` / `LTA_PASSWORD`.
The workflow passes them through automatically; if they're absent, the scraper just
runs anonymously. **Do not commit credentials to the repo.**

## Make it yours / hand it to the club

- **Branding:** colours and fonts are CSS variables at the top of `index.html`
  (`--psc-green`, `--font`, …). Swap in the exact PSC palette and logo.
- **Club / league IDs:** set in `scraper/config.json`.
- **Embedding in psclondon.com:** the club's site appears to be Wix — this page can
  be embedded with a Wix *Embed → Custom Embed (iframe)* element pointing at the
  Pages URL, or the club can fork this repo and take over the Action entirely.

## Local preview

It's a static page — just open `index.html` in a browser, or:

```bash
python -m http.server 8000   # then visit http://localhost:8000
```

## Status

Prototype. Sample data shown until the live LTA feed is confirmed (see above).
Built as a proposal for Paddington Sports Club to adopt and maintain.
