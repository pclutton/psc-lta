// Multi-club tennis results scraper
// -----------------------------------------------------------------------------
// Drives a headless Chromium browser (via Playwright) to read each club's results
// from the LTA / TournamentSoftware competition site, which has no public API and
// gates content behind a cookie-consent wall. Loops over every club defined in
// ../clubs/<slug>/club.json and writes ../clubs/<slug>/data/results.js (a JS global,
// so each page also opens straight from disk via file://). NPL competitions live on
// the same LTA platform, so they are just extra discovery sources — not a separate
// backend.
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
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLUBS_DIR = resolve(__dirname, "../clubs");
const DEBUG_DIR = resolve(__dirname, "debug");
const DEBUG = process.env.DEBUG === "1";
const TODAY = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, for lastSeen stamps
const RETAIN_DAYS = 14; // how long a missing competition is kept before it's allowed to retire

// Per-club state, (re)set at the start of each club in scrapeClub(). The helper
// functions below read these, so generalising to many clubs needed no signature churn.
let cfg = null;          // { baseUrl, clubName, discovery: { year, clubSearch } }
let OUT = null;          // clubs/<slug>/data/results.js for the club being scraped
let homeMatch = /paddington/i; // regex marking the home club's rows in a standings table

const log = (...a) => console.log("[scrape]", ...a);
const isPsc = (name) => !!name && homeMatch.test(name);

// Load every clubs/<slug>/club.json (each carries branding + a `scrape` block).
async function loadClubs() {
  const entries = await readdir(CLUBS_DIR, { withFileTypes: true });
  const clubs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = resolve(CLUBS_DIR, e.name, "club.json");
    if (!existsSync(file)) continue;
    const club = JSON.parse(await readFile(file, "utf8"));
    club.slug = club.slug || e.name;
    if (club.scrape) clubs.push(club);
    else log(`skip ${e.name}: no "scrape" block in club.json`);
  }
  return clubs;
}

// Retry a navigation/scrape step a few times. The LTA SPA intermittently times
// out or renders late; a single transient failure on a data page used to silently
// drop (or thin out) a team. Backs off between attempts; rethrows the last error.
async function withRetry(label, fn, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; log(`  ${label} attempt ${i}/${attempts} failed: ${e.message}`); }
    if (i < attempts) await new Promise((r) => setTimeout(r, 900 * i));
  }
  throw lastErr;
}

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

// Collect from a club page one (draw, team) pair per PSC team, in document order.
// The club page lists each team's division (/draw/) link immediately followed by
// its roster (/team/) link, repeating the draw when the club has two teams in the
// same division — so we pair each team with the most recent preceding draw.
async function findTeamLinks(page, clubUrl) {
  return withRetry(`club page ${clubUrl}`, async () => {
    await page.goto(clubUrl, { waitUntil: "networkidle", timeout: 60000 });
    await acceptCookies(page);
    await page.goto(clubUrl, { waitUntil: "networkidle", timeout: 60000 });
    // Wait for the team/division links to actually render rather than a blind sleep.
    await page.waitForSelector('a[href*="/team/"], a[href*="/draw/"]', { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(600);
    if (DEBUG) await dumpDebug(page, "club");

    const links = await page.$$eval("a[href]", (as) =>
      as.map((a) => ({ href: a.href, text: a.textContent.replace(/\s+/g, " ").trim() }))
    );
    const pairs = [];
    const seen = new Set();
    let curDraw = null;
    for (const l of links) {
      if (/\/draw\//i.test(l.href)) curDraw = l;
      else if (/\/team\/\d+/i.test(l.href) && curDraw) {
        const key = curDraw.href + "|" + l.href;
        if (!seen.has(key)) { seen.add(key); pairs.push({ draw: curDraw, team: l }); }
      }
    }
    // Empty here means the page didn't render (PSC is always entered in a discovered
    // league) — throw so withRetry tries again instead of reporting a phantom 0 teams.
    if (!pairs.length) throw new Error("no team/draw links found (page likely not rendered)");
    log(`found ${pairs.length} team entries`);
    return pairs;
  });
}

// Parse one division/draw page into { division, standings[], matches[] }.
let drawDumpCount = 0;
async function scrapeDraw(page, link) {
  return withRetry(`draw ${link.href}`, () => scrapeDrawOnce(page, link));
}
async function scrapeDrawOnce(page, link) {
  await page.goto(link.href, { waitUntil: "networkidle", timeout: 60000 });
  await acceptCookies(page);
  // Wait for the standings table to render (a league draw has one; a knockout cup
  // legitimately has none, so this is a soft wait — empty standings is acceptable).
  await page.waitForSelector("table", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
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
  // Match the FULL club name — "Paddington" alone also hits "Paddington Recreation Ground".
  const readMatch = () => page.evaluate((clubName) => {
    const want = clubName.toLowerCase();
    const pick = [...document.querySelectorAll("[data-asg-href]")].find(
      (el) => /\/club\/\d+/.test(el.getAttribute("data-asg-href") || "") &&
        (el.getAttribute("data-asg-title") || "").toLowerCase().includes(want)
    );
    const m = pick && (pick.getAttribute("data-asg-href") || "").match(/\/club\/(\d+)/);
    return m ? m[1] : null;
  }, clubQuery);
  // Best-effort league name from the page, so explicit (e.g. seniors) leagues with no
  // configured name still get a sensible tab label.
  const readName = () => page.evaluate(() => {
    let t = (document.querySelector("h1, .header__title, .nav-list__title")?.textContent ||
             document.title || "").replace(/\s+/g, " ").trim();
    // Ignore the generic site title (the league name isn't rendered there) — caller
    // then falls back to a configured name or the id.
    if (/tennis for britain/i.test(t) || /^lta\b/i.test(t)) return "";
    return t.replace(/\s*[|–-]\s*(LTA|Tennis for Britain).*/i, "").trim();
  });

  // The autosuggest (#Query → /LeagueHome/DoSearch) is occasionally slow/empty, so
  // retry the search a few times before giving up — a transient miss here used to
  // drop the whole league.
  let leagueName = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(`${cfg.baseUrl}/league/${lg.id}`, { waitUntil: "networkidle", timeout: 60000 });
      await acceptCookies(page);
      await page.waitForTimeout(700);
      if (!leagueName) leagueName = (await readName().catch(() => null)) || null;
      const input = await page.$('#Query, input[name="Query"]');
      if (!input) { await page.waitForTimeout(600 * attempt); continue; }
      await input.click({ clickCount: 3 }).catch(() => {});
      await input.fill("").catch(() => {});
      await input.type(clubQuery, { delay: 50 });
      // Wait specifically for a club suggestion to appear.
      await page.waitForSelector('[data-asg-href*="/club/"]', { timeout: 9000 }).catch(() => {});
      await page.waitForTimeout(500);
      if (DEBUG && leagueDumpCount < 2) { leagueDumpCount++; await dumpDebug(page, "league-search"); }
      const clubId = await readMatch();
      if (clubId) return { clubId, leagueName };
    } catch (e) { log(`  probe attempt ${attempt} error:`, e.message); }
    if (attempt < 3) await page.waitForTimeout(900 * attempt);
  }
  return { clubId: null, leagueName };
}

// Discover every league a club is in, across one or more configured sources, then
// find the club's id within each. A source is either a county/association GROUP page
// to crawl (type:"group") or an explicit list of league GUIDs (type:"leagues") — the
// latter is how NPL competitions are wired in, since their npltennis.com links point
// at this same LTA platform. Returns [] if nothing is found (no stale fallback): a
// transient LTA hiccup then yields nothing → the previous good results.js is kept.
async function discoverSources(page) {
  const out = [];
  const seenLeague = new Set();
  const clubQuery = cfg.discovery?.clubSearch || cfg.clubName;

  const addLeague = async (lg) => {
    if (!lg.id || seenLeague.has(lg.id)) return;
    seenLeague.add(lg.id);
    try {
      const { clubId, leagueName } = await probeClub(page, lg, clubQuery);
      const name = lg.name || leagueName || `League ${lg.id.slice(0, 8)}`;
      if (clubId) { log(`  ✓ ${name} → club ${clubId}`); out.push({ leagueId: lg.id, leagueName: name, clubId }); }
      else log(`  · ${name} → club not found in search`);
    } catch (e) { log("  league probe failed:", lg.id, e.message); }
  };

  for (const src of (cfg.discovery?.sources || [])) {
    if (src.type === "group" && src.url) {
      for (const tgt of discoveryTargets()) {
        await page.goto(`${src.url}?LeagueFilterYear=${tgt.year}`, { waitUntil: "networkidle", timeout: 60000 });
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
        for (const lg of leagues) await addLeague(lg);
      }
    } else if (src.type === "leagues") {
      // Explicit league GUIDs (e.g. NPL), optionally with names: [{id,name}] or ids:[...]
      const list = src.leagues || (src.ids || []).map((id) => ({ id }));
      log(`discovery: ${list.length} explicit league(s)`);
      for (const lg of list) await addLeague(lg);
    } else {
      log("  unknown/empty source (skipped):", JSON.stringify(src));
    }
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

// Build one team card. teamName is this team's exact name (e.g. "Paddington
// Sports Club 2") so we pick the right row when the club has several teams in one
// division; pscCount lets us tag the card (1)/(2) to tell them apart.
function buildTeam(draw, teamName, label, pscCount) {
  const standings = (draw.standings || []).filter((r) => r.name);
  const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const me = standings.find((r) => norm(r.name) === norm(teamName)) || standings.find((r) => isPsc(r.name));
  const { name, division } = parseLabel(label || draw.teamLabel || draw.division);
  let cardName = name;
  if (pscCount > 1) {
    const num = (String(teamName).match(/(\d+)\s*$/) || [])[1];
    if (num) cardName = `${name} (${num})`;
  }
  return {
    name: cardName,
    division,
    pscName: me ? me.name : teamName,
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

// Build one knockout/cup entry from a draw that has no league table. Captures the
// club's last *played* match (opponent, score, win/loss) so a viewer can tell whether
// the club is still in (last match won, or none played yet) or knocked out (lost).
// `link` points at the bracket page. Matches are taken in draw (round) order, so the
// last one the club appears in is the furthest round it has reached.
function buildKnockout(draw, leagueName, pair) {
  const lbl = parseLabel(pair.draw.text || draw.teamLabel || "");
  const sub = [lbl.name, lbl.division].filter(Boolean).join(" ").trim();
  const name = (sub && !leagueName.toLowerCase().includes(lbl.name.toLowerCase()))
    ? `${leagueName} — ${sub}` : leagueName;
  const clubMatches = (draw.matches || []).filter((m) => isPsc(m.home) || isPsc(m.away));
  const played = clubMatches.filter((m) => m.hs != null && m.as != null);
  let last = null;
  if (played.length) {
    const m = played[played.length - 1];
    const home = isPsc(m.home);
    const sf = home ? m.hs : m.as, sa = home ? m.as : m.hs;
    last = { opponent: home ? m.away : m.home, scoreFor: sf, scoreAgainst: sa, won: sf > sa, date: m.date || "" };
  }
  // The club's next unplayed cup fixture (so upcoming-matches view doesn't miss a cup
  // round). Earliest by date; only when the opponent is known.
  const dnum = (s) => { const m = (s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? Date.UTC(+m[3], +m[2]-1, +m[1]) : null; };
  let next = null;
  const upcoming = clubMatches
    .filter((m) => (m.hs == null || m.as == null) && dnum(m.date) != null)
    .map((m) => ({ m, d: dnum(m.date) }))
    .sort((a, b) => a.d - b.d);
  for (const { m } of upcoming) {
    const home = isPsc(m.home);
    const opp = home ? m.away : m.home;
    if (opp && opp.trim()) { next = { opponent: opp, home, date: m.date }; break; }
  }
  return { name, link: draw.url, last, next, live: !last || last.won };
}

// Scrape a PSC team page for its squad and each player's per-team Win-Loss
// record (shown as "Win-Loss  4-4 (8)"). Sorted most wins first.
async function scrapeTeamPlayers(page, url) {
  return withRetry(`team players ${url}`, () => scrapeTeamPlayersOnce(page, url));
}
async function scrapeTeamPlayersOnce(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector(".media", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(400);
  const players = await page.evaluate(() => {
    const out = [], seen = {};
    for (const m of document.querySelectorAll(".media")) {
      const link = m.querySelector('a[href*="/player/"]');
      if (!link) continue;
      const nameEl = m.querySelector(".nav-link__value");
      const name = ((nameEl && nameEl.textContent) || "").replace(/\s+/g, " ").trim();
      if (!name || seen[name]) continue;
      let won = 0, lost = 0;
      for (const c of m.querySelectorAll(".clearfix")) {
        const lab = (c.querySelector(".pull-left") || {}).textContent || "";
        if (/win-?loss/i.test(lab)) {
          const v = ((c.querySelector(".pull-right") || {}).textContent || "").match(/(\d+)\s*-\s*(\d+)/);
          if (v) { won = +v[1]; lost = +v[2]; }
        }
      }
      seen[name] = 1;
      out.push({ name, won, lost, url: link.href });
    }
    return out;
  });
  players.sort((a, b) => b.won - a.won || a.lost - b.lost || a.name.localeCompare(b.name));
  return players;
}

// Club-wide players leaderboard, aggregated from the per-team squads we already
// scraped (reliable W-L for every roster player). Merge by name, score 3·W, link
// to the player page from the team where they played the most.
function buildLeaderboard(competitions) {
  const byName = new Map();
  for (const c of competitions) {
    for (const t of c.teams) {
      for (const p of (t.players || [])) {
        const k = p.name.toLowerCase();
        const cur = byName.get(k) || { name: p.name, won: 0, lost: 0, url: p.url || "", _best: -1 };
        cur.won += p.won; cur.lost += p.lost;
        const played = p.won + p.lost;
        if (played > cur._best) { cur._best = played; if (p.url) cur.url = p.url; }
        byName.set(k, cur);
      }
    }
  }
  const players = [...byName.values()]
    .map((p) => ({
      name: p.name, url: p.url,
      won: p.won, lost: p.lost,
      played: p.won + p.lost,
    }))
    .filter((p) => p.played > 0)
    .sort((a, b) =>
      b.won - a.won ||
      (b.won / (b.played || 1)) - (a.won / (a.played || 1)) ||
      a.lost - b.lost ||
      a.name.localeCompare(b.name));
  log(`leaderboard: ${players.length} players`);
  return players;
}

// Load the previously-published data (the committed results.js), if any.
async function loadPrevious() {
  try {
    if (!existsSync(OUT)) return null;
    const txt = await readFile(OUT, "utf8");
    return JSON.parse(txt.replace(/^\s*window\.__RESULTS__\s*=\s*/, "").replace(/;\s*$/, ""));
  } catch (e) { log("could not read previous results:", e.message); return null; }
}

// Scrape one club into clubs/<slug>/data/results.js. Sets the per-club module state
// the helper functions read, then runs discover → scrape → reconcile → write.
async function scrapeClub(page, club) {
  const s = club.scrape;
  cfg = { baseUrl: s.baseUrl, clubName: club.name, discovery: { year: s.year, clubSearch: s.clubSearch, sources: s.sources } };
  OUT = resolve(CLUBS_DIR, club.slug, "data", "results.js");
  homeMatch = new RegExp(club.matcher || escapeReg(club.name), "i");
  const warnings = []; // health notes that should turn the run "degraded" (→ CI alert)

  await maybeLogin(page);
  const sources = await discoverSources(page);
  // No early throw on empty discovery: a transient hiccup is handled by the retain/
  // reconcile step below (it re-adds the previous good competitions). We only fail at
  // the very end if there is genuinely nothing to show (and no history to fall back on).
  log(`scraping ${sources.length} competition(s)`);

    const competitions = [];
    const knockouts = []; // every cup/knockout entry, grouped into one tab at the end
    for (const src of sources) {
      const clubUrl = `${cfg.baseUrl}/league/${src.leagueId}/club/${src.clubId}`;
      let pairs = [];
      try { pairs = await findTeamLinks(page, clubUrl); }
      catch (e) { log("club page failed:", clubUrl, e.message); continue; }

      const teams = [];
      const drawCache = new Map(); // a division shared by several PSC teams is scraped once
      for (const pair of pairs) {
        try {
          let draw = drawCache.get(pair.draw.href);
          if (!draw) { draw = await scrapeDraw(page, pair.draw); drawCache.set(pair.draw.href, draw); }
          if (!draw.standings.length) {
            // No league table → a knockout/cup draw. Capture the club's last match.
            const ko = buildKnockout(draw, src.leagueName, pair);
            if (!knockouts.some((k) => k.link === ko.link)) {
              knockouts.push(ko);
              log(`  knockout: ${ko.name} — ${ko.last ? (ko.last.won ? "won " : "lost ") + ko.last.scoreFor + "-" + ko.last.scoreAgainst + " vs " + ko.last.opponent : "no matches yet"}`);
            }
            continue;
          }
          // Sanity: a draw whose rows mostly lack a name or numeric P/W/L is a bad read
          // (e.g. an LTA markup change) — skip it so the competition reverts to last-good.
          const saneRows = draw.standings.filter((r) => r.name && Number.isFinite(r.played) && Number.isFinite(r.won) && Number.isFinite(r.lost));
          if (saneRows.length < draw.standings.length * 0.5) {
            warnings.push(`suspect standings in "${src.leagueName}" — skipped`);
            log(`  ! suspect standings, skipping draw: ${pair.draw.href}`);
            continue;
          }
          const pscCount = draw.standings.filter((r) => isPsc(r.name)).length;
          const team = buildTeam(draw, pair.team.text, pair.draw.text, pscCount);
          try { team.players = await scrapeTeamPlayers(page, pair.team.href); }
          catch (e) { log("team players failed:", pair.team.href, e.message); team.players = []; }
          teams.push(team);
          log(`  ok: ${team.name} | ${team.division} (${team.standings.length} teams, ${team.matches.length} matches, ${team.players.length} players)`);
        } catch (e) { log("draw failed:", pair.draw.href, e.message); }
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
          lastSeen: TODAY,
          asOf: TODAY,
          stale: false,
          teams,
        });
      }
    }

    // Config-declared link sources. A knockout link (e.g. the NPL finals, on LTA's
    // legacy interface we don't scrape) joins the grouped Knockout tab as a link-only
    // entry; any other link becomes its own link-out tab.
    for (const ls of (s.sources || []).filter((x) => x.type === "link")) {
      if (ls.knockout) {
        if (!knockouts.some((k) => k.link === ls.url)) {
          knockouts.push({ name: ls.name || "Knockout", link: ls.url, last: null, live: null, linkOnly: true });
        }
      } else {
        const key = (ls.id || ls.name || ls.url || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12);
        competitions.push({
          id: "link-" + key,
          name: ls.name || "External competition",
          status: ls.status || leagueStatus(ls.name || ""),
          lastSeen: TODAY,
          asOf: TODAY,
          stale: false,
          teams: [],
          link: ls.url,
        });
      }
    }

    // Group every knockout/cup entry into a single tab. Sort: still in first, then
    // knocked out, then link-only; alphabetical within each group.
    if (knockouts.length) {
      const rank = (k) => (k.linkOnly ? 2 : (k.live ? 0 : 1));
      knockouts.sort((a, b) => rank(a) - rank(b) || (a.name || "").localeCompare(b.name || ""));
      competitions.push({
        id: "knockouts",
        name: "Knockout Competitions",
        status: "current",
        lastSeen: TODAY,
        asOf: TODAY,
        stale: false,
        teams: [],
        knockouts,
      });
      log(`knockouts: ${knockouts.length} (${knockouts.filter((k) => k.live).length} still in)`);
    }

    // --- Reconcile this run against the last good data so a transient hiccup can never
    // replace good data with worse. A competition is "degraded" vs its previous good
    // version if it lost teams, lost all the matches/players it used to have, or its
    // overall content dropped by >40%. Degraded → keep last-good, flagged `stale` with the
    // `asOf` date it was last fully scraped (so the page can show "as of …").
    const richness = (c) =>
      (c.teams || []).reduce((n, t) => n + (t.standings?.length || 0) + (t.matches?.length || 0), 0) +
      (c.knockouts?.length || 0);
    const sumLen = (c, f) => (c.teams || []).reduce((n, t) => n + (t[f]?.length || 0), 0);
    const prev = await loadPrevious();
    const prevById = new Map((prev?.competitions || []).filter((c) => c && c.id).map((c) => [c.id, c]));
    const asOfOf = (c) => c.asOf || c.lastSeen || (prev?.generatedAt || "").slice(0, 10) || TODAY;

    // Freshly-scraped totals (before any revert/retain) for the selector-drift canary.
    const scraped = { matches: 0, players: 0, standings: 0 };
    for (const c of competitions) for (const t of (c.teams || [])) {
      scraped.matches += (t.matches?.length || 0);
      scraped.players += (t.players?.length || 0);
      scraped.standings += (t.standings?.length || 0);
    }
    const prevMatches = [...prevById.values()].reduce((n, c) => n + sumLen(c, "matches"), 0);
    if (prevMatches >= 5 && scraped.matches === 0) {
      warnings.push("matches collapsed to 0 across all competitions (possible LTA markup change)");
      log("  ! canary: 0 matches scraped though the previous run had many");
    }

    // (a) Per-competition degraded check → keep last-good (flagged stale).
    for (let i = 0; i < competitions.length; i++) {
      const cur = competitions[i], old = prevById.get(cur.id);
      if (!old) continue;
      const degraded =
        (cur.teams.length < old.teams.length) ||
        (sumLen(old, "matches") > 0 && sumLen(cur, "matches") === 0) ||
        (sumLen(old, "players") > 0 && sumLen(cur, "players") === 0) ||
        (richness(old) > 0 && richness(cur) < richness(old) * 0.6);
      if (degraded) {
        log(`  degraded "${cur.name}" (now ${richness(cur)} vs ${richness(old)}) — keeping last-good (as of ${asOfOf(old)})`);
        warnings.push(`"${cur.name}" came back incomplete — kept last-good (as of ${asOfOf(old)})`);
        competitions[i] = { ...old, lastSeen: TODAY, stale: true, asOf: asOfOf(old) };
      }
    }
    // (b) Retain a competition absent from this run if seen recently (transient miss, or
    //     pre-retirement) — flagged stale. Seasonal roll-off ages out after RETAIN_DAYS.
    //     A pure link-only comp is not resurrected (superseded by the knockouts tab).
    const daysSince = (d) => d ? (Date.now() - Date.parse(d)) / 86400000 : 0;
    const haveIds = new Set(competitions.map((c) => c.id));
    for (const pc of prevById.values()) {
      if (haveIds.has(pc.id)) continue;
      if (pc.link && !(pc.teams?.length) && !(pc.knockouts?.length)) continue;
      const age = daysSince(pc.lastSeen);
      if (age <= RETAIN_DAYS) {
        log(`  retained (missing this run, last seen ${pc.lastSeen || "unknown"}): ${pc.name}`);
        competitions.push({ ...pc, stale: true, asOf: asOfOf(pc) });
      } else {
        log(`  retired (missing ${Math.round(age)}d, past ${RETAIN_DAYS}d window): ${pc.name}`);
      }
    }

    const totalTeams = competitions.reduce((n, c) => n + c.teams.length, 0);
    if (competitions.length === 0) {
      await dumpDebug(page, "no-comps");
      throw new Error("Nothing to publish (no competitions and no history) — keeping any existing results.js untouched.");
    }
    // (c) Backstop: refuse to publish a sweeping team drop across continuing leagues.
    let prevOverlap = 0, curOverlap = 0;
    for (const c of competitions) {
      const old = prevById.get(c.id);
      if (old) { curOverlap += c.teams.length; prevOverlap += (old.teams?.length || 0); }
    }
    if (prevOverlap > 0 && curOverlap < prevOverlap * 0.5) {
      await dumpDebug(page, "team-drop");
      throw new Error(`Continuing-league team count collapsed (${curOverlap} vs ${prevOverlap} previously) — keeping existing results.js untouched.`);
    }

    const players = buildLeaderboard(competitions);
    const staleCount = competitions.filter((c) => c.stale).length;
    const health = {
      ok: true,
      degraded: warnings.length > 0,   // reverts/canary/sanity alert; routine retains don't
      warnings,
      totals: { comps: competitions.length, teams: totalTeams, matches: scraped.matches, players: players.length, stale: staleCount },
      competitions: competitions.map((c) => ({ id: c.id, name: c.name, stale: !!c.stale, asOf: c.asOf || null })),
    };

    const groupSrc = (s.sources || []).find((x) => x.type === "group" && x.url);
    const out = {
      clubName: club.name,
      season: (s.year && s.year !== "auto") ? s.year : String(new Date().getFullYear()),
      sourceUrl: groupSrc ? groupSrc.url : s.baseUrl,
      generatedAt: new Date().toISOString(),
      sample: false,
      health,
      competitions,
      players,
    };
    // Written as a JS global (not bare JSON) so the page also works from file://
    await mkdir(dirname(OUT), { recursive: true });
    await writeFile(OUT, "window.__RESULTS__ = " + JSON.stringify(out, null, 2) + ";\n", "utf8");
    log(`wrote ${OUT} — ${totalTeams} teams across ${competitions.length} competitions${staleCount ? ` (${staleCount} stale)` : ""}`);
    return { slug: club.slug, ok: true, degraded: health.degraded, warnings };
}

// Loop every configured club. One club's failure keeps its existing data and does not
// abort the others; the whole run only fails if every club fails.
async function main() {
  const clubs = await loadClubs();
  if (!clubs.length) throw new Error(`No clubs found under ${CLUBS_DIR}`);
  log(`clubs: ${clubs.map((c) => c.slug).join(", ")}`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0 (compatible; tennis-results-bot/1.0)" });
  const clubHealth = [];
  let failures = 0;
  try {
    for (const club of clubs) {
      log(`\n===== ${club.name} (${club.slug}) =====`);
      try { clubHealth.push(await scrapeClub(page, club)); }
      catch (e) {
        failures++;
        log(`club ${club.slug} failed (keeping its existing data): ${e.message}`);
        clubHealth.push({ slug: club.slug, ok: false, degraded: true, warnings: [e.message] });
      }
    }
  } finally {
    await browser.close();
  }
  // Health summary for CI alerting — written even on total failure so the health gate
  // (a separate workflow job) sees it. Deploy of last-good data happens regardless.
  const anyProblem = clubHealth.some((h) => !h.ok || h.degraded);
  await writeFile(resolve(__dirname, "health.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), anyProblem, clubs: clubHealth }, null, 2) + "\n", "utf8");
  log(anyProblem
    ? `health: PROBLEMS — ${clubHealth.flatMap((h) => h.warnings || []).join("; ")}`
    : "health: all clubs OK");
  if (failures === clubs.length) throw new Error("All clubs failed to scrape.");
}

main().catch((e) => {
  console.error("[scrape] FAILED:", e.message);
  process.exit(1);
});
