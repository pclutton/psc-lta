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

// Collect from a club page the /draw/ links (division standings) and the /team/
// links (team rosters, used for the players leaderboard).
async function findTeamLinks(page, clubUrl) {
  await page.goto(clubUrl, { waitUntil: "networkidle", timeout: 60000 });
  await acceptCookies(page);
  await page.goto(clubUrl, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500);
  if (DEBUG) await dumpDebug(page, "club");

  const links = await page.$$eval("a[href]", (as) =>
    as.map((a) => ({ href: a.href, text: a.textContent.trim() }))
  );
  const pick = (re) => {
    const seen = new Set();
    return links.filter((l) => re.test(l.href) && !seen.has(l.href) && seen.add(l.href));
  };
  const draws = pick(/\/draw\//i);
  const teams = pick(/\/team\/\d+/i);
  log(`found ${draws.length} draws, ${teams.length} team rosters`);
  return { draws, teams };
}

// Parse one division/draw page into { division, standings[], matches[] }.
let drawDumpCount = 0;
async function scrapeDraw(page, link) {
  await page.goto(link.href, { waitUntil: "networkidle", timeout: 60000 });
  await acceptCookies(page);
  await page.waitForTimeout(1200);
  // The match list renders lower down and lazily — scroll to it and wait so the
  // results matrix can be read.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForSelector(".match--team-match", { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(500);
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
        // Body rows may omit a leading column the header has (e.g. a blank rank
        // cell), so align body cells to header indices by the team-name column.
        const bodyTeamIdx = cells.findIndex((c) => /[a-z]{3,}/i.test(c));
        const off = (bodyTeamIdx >= 0 ? bodyTeamIdx : ix.team) - ix.team;
        const at = (hi) => (hi >= 0 ? cells[hi + off] : undefined);
        const name = at(ix.team) || cells[bodyTeamIdx] || "";
        const histCell = at(ix.hist) || cells.find((c) => /^[\sWLD]+$/.test(c) && /[WLD]/.test(c)) || "";
        rank += 1;
        return {
          rank,
          name,
          played: num(at(ix.pl)),
          won: num(at(ix.w)),
          drawn: ix.d >= 0 ? num(at(ix.d)) : 0,
          lost: num(at(ix.l)),
          rubbers: ix.r >= 0 ? (at(ix.r) || "") : "",
          points: num(at(ix.pts)),
          form: (histCell.match(/[WLD]/gi) || []).map((x) => x.toUpperCase()),
        };
      }).filter((row) => /[a-z]{3,}/i.test(row.name));
      if (standings.length) break;
    }

    // Matches list — each fixture block carries both team names + the score, e.g.
    // "<team1> 14 - 10 <team2>". Used to build the head-to-head results matrix.
    const matches = [];
    for (const m of document.querySelectorAll(".match--team-match")) {
      // The team name is text inside .team-match__name (the .nav-link__value span
      // is empty), so read the name container directly.
      const home = txt(m.querySelector(".team-match__name.is-team-1"));
      const away = txt(m.querySelector(".team-match__name.is-team-2"));
      const hs = num(txt(m.querySelector(".score .is-team-1")));
      const as = num(txt(m.querySelector(".score .is-team-2")));
      const date = txt(m.querySelector(".match__header-title"));
      if (home && away) matches.push({ home, away, hs, as, date });
    }

    return { standings, matches };
  });

  data.url = link.href;
  data.teamLabel = link.text;
  return data;
}

// Decide if a league is still running from its name's season + year vs today.
// Rough active windows: summer ~Apr–Sep of its year; winter ~Oct of its year to
// Apr of the next. Anything clearly past is "completed" (shown with a Finished tag).
function leagueStatus(name) {
  const n = (name || "").toLowerCase();
  const now = new Date();
  const y = now.getFullYear();
  const month = now.getMonth() + 1; // 1–12
  const yr = +((n.match(/\b(20\d\d)\b/) || [])[1] || y);
  if (/winter|floodlit/.test(n)) {
    // Winter YR runs into YR+1; done once we're past spring of the following year.
    return (y < yr + 1 || (y === yr + 1 && month <= 4)) ? "current" : "completed";
  }
  // Summer / cup / youth: done after its own year, or late in its own year.
  if (yr < y) return "completed";
  if (yr === y && month >= 11) return "completed";
  return "current";
}

// Which year filters to crawl on the county group page. With year "auto" (or
// unset) this advances itself: always the current calendar year, plus the
// previous year's WINTER leagues during Jan–Apr (winter seasons span the new
// year). Set a fixed year in config to override (handy for testing).
function discoveryTargets() {
  const set = cfg.discovery?.year;
  if (set && set !== "auto") return [{ year: String(set), winterOnly: false }];
  const now = new Date();
  const y = now.getFullYear();
  const targets = [{ year: String(y), winterOnly: false }];
  if (now.getMonth() <= 3) targets.push({ year: String(y - 1), winterOnly: true });
  return targets;
}

// Find the club within one league via its autosuggest search box
// (#Query → /LeagueHome/DoSearch). Returns the club id or null.
let leagueDumpCount = 0;
async function probeClub(page, lg, clubQuery) {
  await page.goto(`${cfg.baseUrl}/league/${lg.id}`, { waitUntil: "networkidle", timeout: 60000 });
  await acceptCookies(page);
  await page.waitForTimeout(800);
  const input = await page.$('#Query, input[name="Query"]');
  if (!input) return null;
  await input.click();
  await input.type(clubQuery, { delay: 40 });
  // Suggestions are <li data-asg-href="/league/…/club/{id}" data-asg-title="…">
  await page.waitForSelector("[data-asg-href]", { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(400);
  if (DEBUG && leagueDumpCount < 2) { leagueDumpCount++; await dumpDebug(page, "league-search"); }
  // Match the FULL club name — "Paddington" alone also hits "Paddington Recreation Ground".
  return page.evaluate((clubName) => {
    const want = clubName.toLowerCase();
    const pick = [...document.querySelectorAll("[data-asg-href]")].find(
      (el) => /\/club\/\d+/.test(el.getAttribute("data-asg-href") || "") &&
        (el.getAttribute("data-asg-title") || "").toLowerCase().includes(want)
    );
    const m = pick && (pick.getAttribute("data-asg-href") || "").match(/\/club\/(\d+)/);
    return m ? m[1] : null;
  }, clubQuery);
}

// Discover every league the club is in across the rolling year window, then find
// the club's id within each. Falls back to a single configured league.
async function discoverSources(page) {
  const out = [];
  const seenLeague = new Set();
  const clubQuery = cfg.discovery?.clubSearch || cfg.clubName;
  if (cfg.discovery?.groupUrl) {
    for (const tgt of discoveryTargets()) {
      await page.goto(`${cfg.discovery.groupUrl}?LeagueFilterYear=${tgt.year}`, { waitUntil: "networkidle", timeout: 60000 });
      await acceptCookies(page);
      await page.waitForTimeout(1500);
      if (DEBUG) await dumpDebug(page, "group");

      let leagues = await page.$$eval("a[href*='/league/']", (as) => {
        const seen = {}, res = [];
        for (const a of as) {
          const m = a.href.match(/\/league\/([0-9A-Fa-f-]{36})(?:[/?#]|$)/);
          const name = a.textContent.replace(/\s+/g, " ").trim();
          if (m && name && name.length > 4 && !seen[m[1]]) { seen[m[1]] = 1; res.push({ id: m[1], name }); }
        }
        return res;
      });
      if (tgt.winterOnly) leagues = leagues.filter((l) => /winter|floodlit/i.test(l.name));
      log(`discovery: ${leagues.length} leagues for ${tgt.year}${tgt.winterOnly ? " (winter only)" : ""}`);

      for (const lg of leagues) {
        if (seenLeague.has(lg.id)) continue;
        seenLeague.add(lg.id);
        try {
          const clubId = await probeClub(page, lg, clubQuery);
          if (clubId) { log(`  ✓ ${lg.name} → club ${clubId}`); out.push({ leagueId: lg.id, leagueName: lg.name, clubId }); }
          else log(`  · ${lg.name} → club not found in search`);
        } catch (e) { log("  league probe failed:", lg.id, e.message); }
      }
    }
  }
  if (!out.length && cfg.fallbackLeagueId && cfg.fallbackClubId) {
    out.push({ leagueId: cfg.fallbackLeagueId, leagueName: cfg.season, clubId: cfg.fallbackClubId });
  }
  return out;
}

// Turn a club-page link label like
//   "14U Boys – 14U Boys - Div 1 – Group 1"
// into { name: "14U Boys", division: "Division 1 · Group 1" }.
const escapeReg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function parseLabel(raw) {
  const label = (raw || "").replace(/\s+/g, " ").trim();
  const segs = label.split("–").map((s) => s.trim()).filter(Boolean);
  const name = segs[0] || label || "Team";
  // The division/tier is the last meaningful segment (e.g. "West Intermediate",
  // "Division 3 West") — keep it verbatim, dropping the internal "Group N". Blank
  // it when it just repeats the team name, so the card doesn't show it twice.
  const nonGroup = segs.slice(1).filter((s) => !/^group\b/i.test(s));
  let division = (nonGroup[nonGroup.length - 1] || "")
    .replace(new RegExp("^(?:" + escapeReg(name) + "\\s*-\\s*)+", "i"), "")
    .trim();
  if (division.toLowerCase() === name.toLowerCase()) division = "";
  return { name, division };
}

// Group teams by gender: men's first, then women's, then anything else. Check
// "women" before "men" since "women"/"womens" contains "men".
function genderOrder(name) {
  const n = (name || "").toLowerCase();
  if (/wom|girl|ladies/.test(n)) return 1;
  if (/men|boy|gent/.test(n)) return 0;
  return 2;
}

// Rank a division highest→lowest: Premier, Intermediate, then Division 1..N.
// The geographic prefix (West / North West / …) is cosmetic and ignored here.
function divisionRank(division) {
  const d = (division || "").toLowerCase();
  if (/premier/.test(d)) return 0;
  if (/intermediate/.test(d)) return 1;
  const m = d.match(/division\s*(\d+)/) || d.match(/\bdiv\.?\s*(\d+)/);
  if (m) return 1 + parseInt(m[1], 10);
  return 999;
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
    // Head-to-head fixtures for this division, used to build the results matrix.
    matches: (draw.matches || []).filter((m) => m.home && m.away),
    results: [],
    fixtures: [],
  };
}

// Read a player's name + season Win-Draw-Loss from their league player page.
// The page shows: "Win-Draw-Loss"  "8-1-4 (13)".
async function scrapePlayer(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const name = (document.title.split(" - ")[0] || "").replace(/\s+/g, " ").trim();
    const body = document.body.textContent.replace(/\s+/g, " ");
    const m = body.match(/win-?draw-?loss[^0-9]{0,12}(\d+)\s*-\s*(\d+)\s*-\s*(\d+)/i);
    return { name, won: m ? +m[1] : 0, drawn: m ? +m[2] : 0, lost: m ? +m[3] : 0, found: !!m };
  });
}

// Build the club-wide players leaderboard: gather rosters from team pages, read
// each player's W-D-L, merge by name, score 3·W + 1·D.
async function buildPlayers(page, sources) {
  const roster = new Map(); // leagueId|playerId -> { name, url }
  for (const src of sources) {
    for (const team of src.teamLinks || []) {
      try {
        await page.goto(team.href, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(300);
        const players = await page.$$eval('a[href*="/player/"]', (as) =>
          as.map((a) => ({ href: a.href, name: a.textContent.replace(/\s+/g, " ").trim() }))
            .filter((p) => /\/player\/\d+/.test(p.href) && p.name.length > 1)
        );
        for (const pl of players) {
          const id = (pl.href.match(/\/player\/(\d+)/) || [])[1];
          const key = src.leagueId + "|" + id;
          if (!roster.has(key)) roster.set(key, { name: pl.name, url: pl.href });
        }
      } catch (e) { log("roster failed:", team.href, e.message); }
    }
  }
  log(`found ${roster.size} unique player entries; reading records…`);

  const raw = [];
  for (const { name, url } of roster.values()) {
    try {
      const rec = await scrapePlayer(page, url);
      raw.push({ name: rec.name || name, url, won: rec.won, drawn: rec.drawn, lost: rec.lost });
    } catch (e) { log("player failed:", url, e.message); }
  }

  // Merge by name (a player can appear in several teams/leagues); link to the page
  // where they played the most.
  const byName = new Map();
  for (const p of raw) {
    const k = p.name.toLowerCase();
    const cur = byName.get(k) || { name: p.name, won: 0, drawn: 0, lost: 0, url: p.url, _best: -1 };
    cur.won += p.won; cur.drawn += p.drawn; cur.lost += p.lost;
    const played = p.won + p.drawn + p.lost;
    if (played > cur._best) { cur._best = played; cur.url = p.url; }
    byName.set(k, cur);
  }

  const players = [...byName.values()]
    .map((p) => ({
      name: p.name, url: p.url,
      won: p.won, drawn: p.drawn, lost: p.lost,
      played: p.won + p.drawn + p.lost,
      points: p.won * 3 + p.drawn,
    }))
    .filter((p) => p.played > 0)
    .sort((a, b) => b.points - a.points || b.won - a.won || b.played - a.played);
  log(`leaderboard: ${players.length} players`);
  return players;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0 (compatible; PSC-results-bot/1.0)" });
  try {
    await maybeLogin(page);

    const sources = await discoverSources(page);
    if (!sources.length) throw new Error("No leagues found for the club (discovery returned nothing).");
    log(`scraping ${sources.length} competition(s)`);

    const competitions = [];
    for (const src of sources) {
      const clubUrl = `${cfg.baseUrl}/league/${src.leagueId}/club/${src.clubId}`;
      let clubLinks = { draws: [], teams: [] };
      try { clubLinks = await findTeamLinks(page, clubUrl); }
      catch (e) { log("club page failed:", clubUrl, e.message); continue; }
      src.teamLinks = clubLinks.teams;

      const teams = [];
      for (const link of clubLinks.draws) {
        try {
          const draw = await scrapeDraw(page, link);
          if (!draw.standings.length) {
            log("skip (no standings):", link.href);
            if (DEBUG) await dumpDebug(page, "draw-empty");
            continue;
          }
          const team = buildTeam(draw);
          teams.push(team);
          log(`  ok: ${team.name} | ${team.division} (${team.standings.length} teams, ${team.matches.length} matches)`);
        } catch (e) { log("draw failed:", link.href, e.message); }
      }
      if (teams.length) {
        // Men's teams together then women's; within each, highest division first
        // (geographic prefix is only a tiebreak).
        teams.sort((a, b) =>
          genderOrder(a.name) - genderOrder(b.name) ||
          divisionRank(a.division || a.name) - divisionRank(b.division || b.name) ||
          a.division.localeCompare(b.division) ||
          a.name.localeCompare(b.name));
        competitions.push({
          id: src.leagueId.slice(0, 8).toLowerCase(),
          name: src.leagueName,
          status: leagueStatus(src.leagueName),
          teams,
        });
      }
    }

    const totalTeams = competitions.reduce((n, c) => n + c.teams.length, 0);
    if (totalTeams === 0) {
      await dumpDebug(page, "no-teams");
      throw new Error("Scrape produced 0 teams — keeping existing results.json untouched.");
    }

    let players = [];
    try { players = await buildPlayers(page, sources); }
    catch (e) { log("players build failed:", e.message); }

    const out = {
      clubName: cfg.clubName,
      season: (cfg.discovery?.year && cfg.discovery.year !== "auto") ? cfg.discovery.year : String(new Date().getFullYear()),
      sourceUrl: cfg.discovery?.groupUrl || cfg.baseUrl,
      generatedAt: new Date().toISOString(),
      sample: false,
      competitions,
      players,
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
