// Build the deployable site from the shared app shell + each club's folder.
// -----------------------------------------------------------------------------
// For every clubs/<slug>/ (that has a club.json) this produces _site/<slug>/ with:
//   index.html           — a copy of the shared shell (app/index.html)
//   club.js              — window.__CLUB__ = <branding> (club.json minus the scrape block)
//   data/results.js      — that club's scraped data
//   assets/*             — that club's logo + icons
//   manifest.webmanifest — generated from the club's name/colours/icons
// Plus _site/index.html, a redirect to the default club so the existing root URL works.
//
// Pure file assembly (no network), so it runs anywhere Node is available.
// -----------------------------------------------------------------------------

import { readFile, writeFile, mkdir, readdir, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const APP = resolve(ROOT, "app", "index.html");
const CLUBS = resolve(ROOT, "clubs");
const SITE = resolve(ROOT, "_site");
const DEFAULT_SLUG = "psc"; // root redirects here when present

const log = (...a) => console.log("[build]", ...a);

function manifestFor(club) {
  const navy = (club.colors && club.colors.navy) || "#222e62";
  return {
    name: `${club.name} Teams`,
    short_name: `${club.shortName || club.name}`,
    start_url: ".",
    scope: ".",
    display: "standalone",
    background_color: navy,
    theme_color: navy,
    icons: [
      { src: "assets/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  };
}

async function buildClub(slug, shell) {
  const dir = resolve(CLUBS, slug);
  const cfgFile = resolve(dir, "club.json");
  if (!existsSync(cfgFile)) return null;
  const club = JSON.parse(await readFile(cfgFile, "utf8"));
  club.slug = club.slug || slug;

  const out = resolve(SITE, club.slug);
  await mkdir(out, { recursive: true });

  // Shared shell, verbatim.
  await writeFile(resolve(out, "index.html"), shell, "utf8");

  // Branding only (drop the scraper block — it has no place on the public page).
  const { scrape, ...branding } = club;
  await writeFile(resolve(out, "club.js"), "window.__CLUB__ = " + JSON.stringify(branding, null, 2) + ";\n", "utf8");

  // Data (may be absent before the first scrape — warn but keep going). Validate it
  // parses and has at least one competition before publishing, so a corrupt/truncated
  // write can't ship a broken page (the page falls back to its "not published" notice).
  const data = resolve(dir, "data", "results.js");
  if (existsSync(data)) {
    let valid = false;
    try {
      const obj = JSON.parse((await readFile(data, "utf8")).replace(/^\s*window\.__RESULTS__\s*=\s*/, "").replace(/;\s*$/, ""));
      valid = obj && Array.isArray(obj.competitions) && obj.competitions.length > 0;
    } catch { valid = false; }
    if (valid) await cp(data, resolve(out, "data", "results.js"));
    else log(`! ${slug}: data/results.js is invalid or empty — skipping it (page shows the 'not published' notice)`);
  } else {
    log(`! ${slug}: no data/results.js yet (page will show a load error until first scrape)`);
  }

  // Assets (logo + icons).
  const assets = resolve(dir, "assets");
  if (existsSync(assets)) await cp(assets, resolve(out, "assets"), { recursive: true });

  // Manifest.
  await writeFile(resolve(out, "manifest.webmanifest"), JSON.stringify(manifestFor(club), null, 2) + "\n", "utf8");

  log(`built /${club.slug}/  (${club.name})`);
  return club.slug;
}

async function main() {
  if (!existsSync(APP)) throw new Error(`Missing app shell: ${APP}`);
  // Cache-bust the per-club scripts on every build so browsers can't serve a stale
  // club.js / results.js against a freshly-fetched page.
  const version = Date.now().toString(36);
  const shell = (await readFile(APP, "utf8"))
    .replace('src="club.js"', `src="club.js?v=${version}"`)
    .replace('src="data/results.js"', `src="data/results.js?v=${version}"`);
  log(`build version ${version}`);

  await rm(SITE, { recursive: true, force: true });
  await mkdir(SITE, { recursive: true });

  const entries = await readdir(CLUBS, { withFileTypes: true });
  const slugs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const built = await buildClub(e.name, shell);
    if (built) slugs.push(built);
  }
  if (!slugs.length) throw new Error(`No clubs built from ${CLUBS}`);

  // Root redirect to the default club (keeps the existing pclutton.github.io/psc-lta/ URL).
  const target = slugs.includes(DEFAULT_SLUG) ? DEFAULT_SLUG : slugs[0];
  const redirect = `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=./${target}/">
<title>Tennis Team Results</title>
<link rel="canonical" href="./${target}/">
<p>Redirecting to <a href="./${target}/">the results page</a>…</p>
`;
  await writeFile(resolve(SITE, "index.html"), redirect, "utf8");

  log(`done — ${slugs.length} club(s): ${slugs.join(", ")}; root → /${target}/`);
}

main().catch((e) => { console.error("[build] FAILED:", e.message); process.exit(1); });
