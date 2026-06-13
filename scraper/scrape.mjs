// PSC tennis results scraper
// -----------------------------------------------------------------------------
// Drives a headless Chromium browser (via Playwright) to read the club's results
// from the LTA / TournamentSoftware competition site, which has no public API and
// gates content behind a cookie-consent wall. Output: ../data/results.json.
//
// Design goals:
//   * Fail safe  - if a run produces no teams, the existing results.json is kept.
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
const OUT = resolve(__dirname, "../data/results.json");
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
    const m = /\/(draw|team|event)\//i.test(l.href);
    if (!m || seen.has(l.href)) return false;
    seen.add(l.href);
    return true;
  });
  log(`found ${teamLinks.length} candidate team/draw links`);
  return teamLinks;
}

// Parse one division/draw page into { division, standings[], matches[] }.
async function scrapeDraw(page, link) {
  await page.goto(link.href, { waitUntil: "networkidle", timeout: 60000 });
  await acceptCookies(page);
  await page.waitForTimeout(1200);

  const data = await page.evaluate(() => {
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
    const num = (s) => { const m = String(s).match(/-?\d+/); return m ? +m[0] : null; };

    // --- standings: the table whose header mentions team + played + points ---
    let standings = [];
    let division = txt(document.querySelector("h1, h2, .title, .draw-title")) || "";
    for (const table of document.querySelectorAll("table")) {
      const head = txt(table.querySelector("thead, tr")).toLowerCase();
      const looksLikeStandings = /team|club/.test(head) && /(point|pts)/.test(head);
      if (!looksLikeStandings) continue;
      const rows = [...table.querySelectorAll("tbody tr, tr")].filter((r) => r.querySelectorAll("td").length >= 3);
      standings = rows.map((r, i) => {
        const cells = [...r.querySelectorAll("td")].map(txt);
        const nameCell = cells.find((c) => /[a-z]{3,}/i.test(c)) || cells[1] || "";
        const nums = cells.map(num).filter((n) => n !== null);
        return {
          rank: num(cells[0]) || i + 1,
          name: nameCell,
          played: nums[0] ?? null,
          won: nums[1] ?? null,
          lost: nums[2] ?? null,
          sets: cells.find((c) => /\d+\s*[-–]\s*\d+/.test(c)) || "",
          points: nums[nums.length - 1] ?? null,
        };
      });
      if (standings.length) break;
    }

    // --- matches: rows/blocks with "Team  s - s  Team" ---
    const matches = [];
    const scoreRe = /(.+?)\s+(\d+)\s*[-–]\s*(\d+)\s+(.+)/;
    for (const row of document.querySelectorAll("tr, li, .match, .match-row")) {
      const t = txt(row);
      const m = t.match(scoreRe);
      if (m && /[a-z]{3,}/i.test(m[1]) && /[a-z]{3,}/i.test(m[4]) && t.length < 120) {
        matches.push({ home: m[1].trim(), homeScore: +m[2], awayScore: +m[3], away: m[4].trim() });
      }
    }
    return { division, standings, matches };
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

function buildTeam(draw) {
  const standings = (draw.standings || []).filter((r) => r.name);
  const me = standings.find((r) => isPsc(r.name));
  const myResults = (draw.matches || []).filter((m) => isPsc(m.home) || isPsc(m.away));
  return {
    name: draw.teamLabel || draw.division || "Team",
    division: draw.division || "",
    leagueUrl: draw.url,
    position: me ? me.rank : 0,
    of: standings.length,
    played: me?.played ?? myResults.length,
    won: me?.won ?? 0,
    lost: me?.lost ?? 0,
    points: me?.points ?? 0,
    form: myResults.slice(-5).map((m) => {
      const win = isPsc(m.home) ? m.homeScore > m.awayScore : m.awayScore > m.homeScore;
      return win ? "W" : "L";
    }),
    standings,
    results: myResults.slice(0, 6),
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
        if (!draw.standings.length && !draw.matches.length) { log("skip (empty):", link.href); continue; }
        const rule = classify(draw.division || link.text);
        buckets.get(rule.id).teams.push(buildTeam(draw));
        log("ok:", rule.id, "←", draw.division || link.text, `(${draw.standings.length} rows, ${draw.matches.length} matches)`);
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
    await writeFile(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
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
