# PSC Tennis — team results & standings

A simple, branded web page that shows **Paddington Sports Club's** Middlesex League
and Cup tennis results in one place, so members don't have to navigate the LTA
competition site. Built as a working prototype / proposal for the club.

**Live demo:** https://YOUR-USERNAME.github.io/psc-tennis/

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
LTA site ──(nightly scraper)──▶ data/results.json ──▶ index.html (the page)
            GitHub Actions          committed to repo      GitHub Pages
```

- **`index.html`** — the whole page. No build step, no framework. It reads
  `data/results.json` and renders tabs (Summer League / Winter Floodlit / Cups),
  a card per team, and a standings + results + fixtures panel for the selected team.
- **`data/results.json`** — the data. This is the *only* file that changes between
  updates. It currently holds **sample data** (clearly labelled on the page) so the
  layout is visible before the live feed is switched on.
- **`scraper/`** — a Node + Playwright script that drives a headless browser,
  accepts the LTA cookie wall, reads the rendered results, and writes
  `data/results.json`. It **fails safe**: if a run finds no teams it leaves the
  existing data untouched rather than blanking the page.
- **`.github/workflows/update-results.yml`** — runs the scraper nightly (and on
  demand), commits any changes, and redeploys the page to GitHub Pages.

## Two ways to keep it updated

1. **Automated (default).** The GitHub Action runs every night. Nothing to do.
2. **Manual fallback.** Anyone can edit `data/results.json` directly on GitHub
   (pencil icon → commit). The page updates within a minute or two. Handy if the
   club ever wants to correct a score or the scraper needs a break.

## Connecting the live LTA feed (one-time)

The scraper is written generically, but the LTA site is a single-page app whose
markup isn't a public API, so the extraction selectors need a quick one-time
confirmation against the live page:

```bash
cd scraper
npm install            # installs Playwright + a headless Chromium
DEBUG=1 npm run scrape # writes scraper/debug/*.html and ../data/results.json
```

Open the files in `scraper/debug/` to confirm the standings-table and match-row
selectors in `scrape.mjs` (search for the `CONFIRM` comments). Once a local run
produces a correct `data/results.json`, the nightly Action will do the same.

Until then, the page runs happily on the sample data in `data/results.json`.

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
