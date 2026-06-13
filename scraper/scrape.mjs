// PSC tennis results scraper
// -----------------------------------------------------------------------------
// Drives a headless Chromium browser (via Playwright) to read the club's results
// from the LTA / TournamentSoftware competition site, which has no public API and
// gates content behind a cookie-consent wall. Output: ../data/results.js (a JS
// global, so the page also opens straight from disk via file://).
//
// Design goals:
//   * Fail safe  - if a run produces no teams, the existing results.js is kept.
//   * Debuggable - on failure (or with DEBUG=1) the rendered HTML is saved to
//                  scraper/debug/ so the selectors below can be confirmed/tuned.
//
// NOTE ON SELECTORS: the LTA site is a single-page app whose markup is not public
// API. The extraction heuristics in scrapeDraw() are written generically (find the
// standings table by its header words, find matches by "team score - score team"
// rows). They are marked CONFIRM and may need a quick one-time tweak against the
// live DOM — run `DEBUG=1 npm run scrape` and inspect scraper/debug/*.html.
// -----------------------------------------------------------------------------

import { chromium } from "playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../data/results.js");
const DEBUG_DIR = resolve(__dirname, "debug");
const DEBUG = process.env.DEBUG === "1";

const cfg = JSON.parse(await readFile(resolve(__dirname, "config.json"), "utf8"));
const clubUrl = `${cfg.baseUrl}/league/${cfg.leagueId}/club/${cfg.clubId}`;

const log = (...a) => console.log("[scrape]", ...a);
const isPsc = (name) => name && name.toLowerCase().includes("paddington");

async function dumpDebug(page, tag) {
  try {
    await mkdir(DEBUG_DIR, { recursive: true });
    const html = await page.content();
    const file = resolve(DEBUG_DIR, `${tag}-${Date.now()}.html`);
    await writeFile(file, html, "utf8");
    log("debug HTML saved:", file);
  } catch (e) { log("debug dump failed:", e.message); }
}

async function acceptCookies(page) {
  // TournamentSoftware shows a consent gate before content renders. Try the known
  // patterns; clicking any one of them is enough.
  const candidates = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    '#cookiescript_accept',
    '.cookie-consent button',
    '[aria-label*="accept" i]',
  ];
  for (const sel of candidates) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click({ timeout: 2000 }); log("cookie consent accepted via", sel); await page.waitForTimeout(800); return true; }
    } catch { /* try next */ }
  }
  // As a fallback, set the consent cookie directly so future navigations skip the gate.
  try {
    await page.context().addCookies([{ name: "CookieScriptConsent", value: '{"action":"accept"}', domain: ".lta.org.uk", path: "/" }]);
  } catch { /* ignore */ }
  log("no consent button found (continuing — may already be accepted)");
  return false;
}

// Optional login. Only runs when LTA_USERNAME + LTA_PASSWORD are set (e.g. via
// GitHub Secrets). Public results pages do NOT need this — it's a fallback only.
// CONFIRM: login form selectors against the live page if you ever enable it.
async function maybeLogin(page) {
  const user = process.env.LTA_USERNAME, pass = process.env.LTA_PASSWORD;
  if (!user || !pass) { log("no credentials set — scraping anonymously (expected)"); return; }
  try {
    log("LTA_USERNAME set — attempting login");
    await page.goto(`${cfg.baseUrl}/login`, { waitUntil: "networkidle", timeout: 60000 });
    await acceptCookies(page);
    await page.fill('input[type="email"], input[name*="user" i], #username', user);
    await page.fill('input[type="password"], #password', pass);
    await page.click('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in")');
    await page.waitForLoadState("networkidle", { timeout: 30000 });
    log("login submitted");
  } catch (e) { log("login attempt failed (continuing anonymously):", e.message); }
}

// Collect links from the club page to each team's division/draw page.
async function findTeamLinks(page) {
  await page.goto(clubUrl, { waitUntil: "networkidle", timeout: 60000 });
  await acceptCookies(page);
  await page.goto(clubUrl, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500);
  if (DEBUG) await dumpDebug(page, "club");

  // CONFIRM: club page lists each team with a link into its draw/standings.
  const links = await page.$$eval("a[href]", (as) =>
    as.map((a) => ({ href: a.href, text: a.textContent.trim() }))
  );
  const seen = new Set();
  const teamLinks = links.filter((l) => {
    // Only the /draw/ links — these are the division/group standings pages, which
    // already contain PSC's row. The parallel /team/ links are duplicates with no
    // standings table, so we skip them.
    const m = /\/draw\//i.test(l.href);
    if (!m || seen.has(l.href)) return false;
    seen.add(l.href);
    return true;
  });
  log(`found ${teamLinks.length} candidate team/draw links`);
  return teamLinks;
}

// Parse one division/draw page into { division, standings[], matches[] }.
let drawDumpCount = 0;
async function scrapeDraw(page, link) {
  await page.goto(link.href, { waitUntil: "networkidle", timeout: 60000 });
  await acceptCookies(page);
  await page.waitForTimeout(1200);
  if (DEBUG && drawDumpCount < 2) { drawDumpCount++; await dumpDebug(page, "draw"); }

  const data = await page.evaluate(() => {
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
    const num = (s) => { const m = String(s).match(/-?\d+/); return m ? +m[0] : null; };

    // The LTA draw page has one table: a league standings table whose columns are
    //   Team | Pl | W | D | L | Pts | R(ubbers) | S | S | Gm | Gm | History | 1..n
    // We map by header text and ignore the trailing results-matrix columns.
    let standings = [];
    for (const table of document.querySelectorAll("table")) {
      const headEls = [...table.querySelectorAll("thead th, tr:first-child th")];
      const headers = headEls.map((th) => txt(th).toLowerCase());
      const looksLikeStandings = headers.includes("pl") && (headers.includes("pts") || headers.includes("points"));
      if (!looksLikeStandings) continue;

      const col = (label) => headers.indexOf(label);
      const ix = {
        team: headers.indexOf("team") >= 0 ? headers.indexOf("team") : 0,
        pl: col("pl"), w: col("w"), d: col("d"), l: col("l"),
        pts: col("pts") >= 0 ? col("pts") : col("points"),
        r: col("r"), hist: col("history"),
      };

      const rows = [...table.querySelectorAll("tbody tr")].filter((r) => r.querySelectorAll("td").length >= 4);
      let rank = 0;
      standings = rows.map((r) => {
        const cells = [...r.querySelectorAll("td")].map(txt);
        const name = cells[ix.team] || "";
        const form = ix.hist >= 0
          ? (cells[ix.hist].match(/[WLD]/gi) || []).map((x) => x.toUpperCase())
          : [];
        rank += 1;
        return {
          rank,
          name,
          played: num(cells[ix.pl]),
          won: num(cells[ix.w]),
          drawn: ix.d >= 0 ? num(cells[ix.d]) : 0,
          lost: num(cells[ix.l]),
          rubbers: ix.r >= 0 ? cells[ix.r] : "",
          points: num(cells[ix.pts]),
          form,
        };
      }).filter((row) => /[a-z]{3,}/i.test(row.name));
      if (standings.length) break;
    }

    return { standings };
  });

  data.url = link.href;
  data.teamLabel = link.text;
  return data;
}

function classify(name) {
  const hay = (name || "").toLowerCase();
  for (const rule of cfg.competitionRules) {
    if (rule.match.some((k) => hay.includes(k))) return rule;
  }
  const def = cfg.competitionRules.find((r) => r.id === cfg.defaultCompetition);
  return def || cfg.competitionRules[cfg.competitionRules.length - 1];
}

// Turn a club-page link label like
//   "14U Boys – 14U Boys - Div 1 – Group 1"
// into { name: "14U Boys", division: "Division 1 · Group 1" }.
function parseLabel(raw) {
  const label = (raw || "").replace(/\s+/g, " ").trim();
  const segs = label.split("–").map((s) => s.trim()).filter(Boolean);
  const name = segs[0] || label || "Team";
  const divPart = segs.find((s) => /div/i.test(s)) || "";
  const grpPart = segs.find((s) => /group/i.test(s)) || "";
  let division = [
    divPart.replace(/.*?(div\b)/i, "$1").replace(/div\b/i, "Division"),
    grpPart,
  ].filter(Boolean).join(" · ").replace(/\s+/g, " ").trim();
  if (!division) division = segs.slice(1).join(" · ");
  return { name, division };
}

function buildTeam(draw) {
  const standings = (draw.standings || []).filter((r) => r.name);
  const me = standings.find((r) => isPsc(r.name));
  const { name, division } = parseLabel(draw.teamLabel || draw.division);
  return {
    name,
    division,
    leagueUrl: draw.url,
    position: me ? me.rank : 0,
    of: standings.length,
    played: me?.played ?? 0,
    won: me?.won ?? 0,
    lost: me?.lost ?? 0,
    points: me?.points ?? 0,
    form: (me?.form || []).slice(-5),
    standings,
    // The draw page carries the league table only; per-match results/fixtures with
    // dates aren't listed here, so these stay empty (a possible later enhancement
    // via each team's /team/ page).
    results: [],
    fixtures: [],
  };
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0 (compatible; PSC-results-bot/1.0)" });
  try {
    await maybeLogin(page);
    const links = await findTeamLinks(page);
    if (!links.length) {
      await dumpDebug(page, "club-no-links");
      throw new Error("No team links found on the club page — selectors need confirming (see scraper/debug/).");
    }

    const buckets = new Map(cfg.competitionRules.map((r) => [r.id, { id: r.id, name: r.name, status: r.status || "current", teams: [] }]));
    for (const link of links) {
      try {
        const draw = await scrapeDraw(page, link);
        if (!draw.standings.length) { log("skip (no standings):", link.href); continue; }
        const team = buildTeam(draw);
        const rule = classify(team.name + " " + team.division);
        buckets.get(rule.id).teams.push(team);
        log("ok:", rule.id, "←", team.name, "|", team.division, `(${draw.standings.length} rows)`);
      } catch (e) { log("draw failed:", link.href, e.message); }
    }

    const competitions = [...buckets.values()].filter((c) => c.teams.length);
    const totalTeams = competitions.reduce((n, c) => n + c.teams.length, 0);

    if (totalTeams === 0) {
      await dumpDebug(page, "no-teams");
      throw new Error("Scrape produced 0 teams — keeping existing results.json untouched.");
    }

    const out = {
      clubName: cfg.clubName,
      season: cfg.season,
      sourceUrl: clubUrl,
      generatedAt: new Date().toISOString(),
      sample: false,
      competitions,
    };
    // Written as a JS global (not bare JSON) so the page also works from file://
    await writeFile(OUT, "window.__PSC_RESULTS__ = " + JSON.stringify(out, null, 2) + ";\n", "utf8");
    log(`wrote ${OUT} — ${totalTeams} teams across ${competitions.length} competitions`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("[scrape] FAILED:", e.message);
  if (!existsSync(OUT)) console.error("[scrape] and no existing results.json exists — the page will show an error.");
  process.exit(1);
});
