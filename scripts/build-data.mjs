#!/usr/bin/env node
/**
 * Builds the data files the site reads:
 *   data/heroes.json   hero list (id, name, attribute, positions, portrait URL)
 *   data/b0.json       all ranks (sum of b1..b4)
 *   data/b1..b4.json   one file per rank bracket
 *   data/meta.json     sample sizes and update time
 *
 * Source: OpenDota's /publicMatches endpoint, which returns randomly sampled
 * public matches with both teams' hero lists and the lobby's average rank.
 * Every match adds 25 enemy pairs and 20 ally pairs to the tables.
 *
 * Usage:
 *   node scripts/build-data.mjs                         full build (needs network)
 *   node scripts/build-data.mjs --heroes-only           just refresh data/heroes.json
 *   node scripts/build-data.mjs --heroes-from file.json build heroes.json from a local
 *                                                       copy of OpenDota's constants
 *
 * Environment (all optional):
 *   OPENDOTA_API_KEY     raises the rate limit if you have a premium key
 *   PAGES_PER_BRACKET    pages of 100 matches to sample per bracket (default 250)
 *   MAX_AGE_DAYS         ignore matches older than this (default 14)
 *   KEEP_PREVIOUS        weight kept from the previous build, 0..1 (default 0.5)
 *   REQUEST_DELAY_MS     pause between API calls (default 1100, or 150 with a key)
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const API = "https://api.opendota.com/api";
const CDN = "https://cdn.cloudflare.steamstatic.com";

const env = process.env;
const KEY = env.OPENDOTA_API_KEY || "";
const PAGES = toInt(env.PAGES_PER_BRACKET, 250);
const MAX_AGE_DAYS = toInt(env.MAX_AGE_DAYS, 14);
const KEEP = clamp(toFloat(env.KEEP_PREVIOUS, 0.5), 0, 1);
const DELAY_MS = toInt(env.REQUEST_DELAY_MS, KEY ? 150 : 1100);

// Normal and ranked matchmaking, drafting modes only (no Turbo, Ability Draft, etc.)
const LOBBY_TYPES = new Set([0, 7]);
const GAME_MODES = new Set([1, 2, 3, 4, 5, 16, 22]);
const MIN_DURATION = 15 * 60; // drop early abandons

// avg_rank_tier: tens digit is the medal (1 Herald ... 8 Immortal)
const BRACKETS = [
  { file: "b1", key: "hg", label: "Herald–Guardian", min: 10, max: 29 },
  { file: "b2", key: "ca", label: "Crusader–Archon", min: 30, max: 49 },
  { file: "b3", key: "la", label: "Legend–Ancient", min: 50, max: 69 },
  { file: "b4", key: "di", label: "Divine–Immortal", min: 70, max: 85 },
];

const args = process.argv.slice(2);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main() {
  await mkdir(DATA, { recursive: true });

  const fromIdx = args.indexOf("--heroes-from");
  const constants =
    fromIdx >= 0
      ? JSON.parse(await readFile(path.resolve(args[fromIdx + 1]), "utf8"))
      : await api("/constants/heroes");

  const heroes = await buildHeroes(constants);
  await writeJson("heroes.json", heroes);
  console.log(`heroes.json: ${heroes.length} heroes`);
  if (fromIdx >= 0 || args.includes("--heroes-only")) return;

  const ids = heroes.map((h) => h.id).sort((a, b) => a - b);
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const cutoff = Math.floor(Date.now() / 1000) - MAX_AGE_DAYS * 86400;
  const results = [];

  for (const bracket of BRACKETS) {
    const fresh = emptyTables(n);
    const seen = new Set();
    let lessThan = null;
    let from = Infinity;
    let to = 0;

    for (let page = 0; page < PAGES; page++) {
      const q = new URLSearchParams({ min_rank: bracket.min, max_rank: bracket.max });
      if (lessThan) q.set("less_than_match_id", String(lessThan));
      const rows = await api(`/publicMatches?${q}`);
      if (!Array.isArray(rows) || rows.length === 0) break;

      let tooOld = 0;
      for (const m of rows) {
        lessThan = lessThan ? Math.min(lessThan, m.match_id) : m.match_id;
        if (seen.has(m.match_id)) continue;
        seen.add(m.match_id);
        if (m.start_time < cutoff) {
          tooOld++;
          continue;
        }
        if (!usable(m, index)) continue;
        addMatch(fresh, m, index, n);
        from = Math.min(from, m.start_time);
        to = Math.max(to, m.start_time);
      }
      if (tooOld === rows.length) break;
      if ((page + 1) % 25 === 0) {
        console.log(`${bracket.label}: ${page + 1} pages, ${fresh.matches} matches`);
      }
    }

    const prev = await readPrevious(`${bracket.file}.json`);
    const merged = mergeWithPrevious(fresh, prev, ids, KEEP);
    results.push({ bracket, tables: merged, fresh: fresh.matches, from, to });
    console.log(`${bracket.label}: ${fresh.matches} new matches, ${merged.matches} after merge`);
  }

  if (results.every((r) => r.fresh === 0)) {
    throw new Error("No matches came back from OpenDota. Leaving the old data in place.");
  }

  const updated = new Date().toISOString();
  const all = emptyTables(n);
  for (const r of results) {
    addTables(all, r.tables);
    await writeJson(`${r.bracket.file}.json`, serialize(r.tables, ids, r.bracket, updated));
  }
  const allBracket = { file: "b0", key: "all", label: "All ranks" };
  await writeJson("b0.json", serialize(all, ids, allBracket, updated));

  const froms = results.map((r) => r.from).filter(Number.isFinite);
  const tos = results.map((r) => r.to).filter(Boolean);
  await writeJson("meta.json", {
    updated,
    source: "OpenDota public match samples",
    sampleFrom: froms.length ? Math.min(...froms) : null,
    sampleTo: tos.length ? Math.max(...tos) : null,
    brackets: [
      { ...pick(allBracket), matches: all.matches },
      ...results.map((r) => ({ ...pick(r.bracket), matches: r.tables.matches })),
    ],
  });
  console.log("Done.");
}

/* ---------- heroes ---------- */

async function buildHeroes(constants) {
  const positions = JSON.parse(await readFile(path.join(DATA, "positions.json"), "utf8"));
  return Object.values(constants)
    .filter((h) => h && h.id && h.localized_name)
    .map((h) => {
      const slug = String(h.name).replace("npc_dota_hero_", "");
      return {
        id: h.id,
        slug,
        name: h.localized_name,
        attr: h.primary_attr,
        positions: positions[slug] || guessPositions(h.roles || []),
        img: `${CDN}/apps/dota2/images/dota_react/heroes/${slug}.png`,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function guessPositions(roles) {
  const has = (r) => roles.includes(r);
  const out = [];
  if (has("Carry")) out.push(1);
  if (has("Nuker") && has("Escape") && !has("Support")) out.push(2);
  if (has("Initiator") || has("Durable")) out.push(3);
  if (has("Support")) out.push(4, 5);
  return out.length ? [...new Set(out)] : [3];
}

/* ---------- match tables ---------- */

function emptyTables(n) {
  return {
    matches: 0,
    hg: new Float64Array(n), // games per hero
    hw: new Float64Array(n), // wins per hero
    vg: new Float64Array(n * n), // games of row hero against column hero
    vw: new Float64Array(n * n), // wins of row hero against column hero
    wg: new Float64Array(n * n), // games of row hero with column hero
    ww: new Float64Array(n * n), // wins of row hero with column hero
  };
}

function usable(m, index) {
  const r = m.radiant_team;
  const d = m.dire_team;
  return (
    LOBBY_TYPES.has(m.lobby_type) &&
    GAME_MODES.has(m.game_mode) &&
    m.duration >= MIN_DURATION &&
    typeof m.radiant_win === "boolean" &&
    Array.isArray(r) && Array.isArray(d) &&
    r.length === 5 && d.length === 5 &&
    [...r, ...d].every((id) => index.has(id))
  );
}

function addMatch(t, m, index, n) {
  const rad = m.radiant_team.map((id) => index.get(id));
  const dire = m.dire_team.map((id) => index.get(id));
  t.matches++;
  addSide(t, rad, dire, m.radiant_win, n);
  addSide(t, dire, rad, !m.radiant_win, n);
}

function addSide(t, team, enemies, won, n) {
  const w = won ? 1 : 0;
  for (const i of team) {
    t.hg[i] += 1;
    t.hw[i] += w;
    for (const j of enemies) {
      t.vg[i * n + j] += 1;
      t.vw[i * n + j] += w;
    }
    for (const j of team) {
      if (i === j) continue;
      t.wg[i * n + j] += 1;
      t.ww[i * n + j] += w;
    }
  }
}

function addTables(into, from) {
  into.matches += from.matches;
  for (const k of ["hg", "hw", "vg", "vw", "wg", "ww"]) {
    for (let i = 0; i < into[k].length; i++) into[k][i] += from[k][i];
  }
}

async function readPrevious(file) {
  const p = path.join(DATA, file);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

// Older samples fade out: each build keeps KEEP of the previous counts.
function mergeWithPrevious(fresh, prev, ids, keep) {
  const n = ids.length;
  const out = emptyTables(n);
  addTables(out, fresh);
  if (!prev || !keep || !Array.isArray(prev.ids)) return round(out);
  const m = prev.ids.length;
  const map = prev.ids.map((id) => ids.indexOf(id)); // old index -> new index
  out.matches += Math.round((prev.matches || 0) * keep);
  for (let a = 0; a < m; a++) {
    const i = map[a];
    if (i < 0) continue;
    out.hg[i] += (prev.hg[a] || 0) * keep;
    out.hw[i] += (prev.hw[a] || 0) * keep;
    for (let b = 0; b < m; b++) {
      const j = map[b];
      if (j < 0) continue;
      const k = a * m + b;
      out.vg[i * n + j] += (prev.vg[k] || 0) * keep;
      out.vw[i * n + j] += (prev.vw[k] || 0) * keep;
      out.wg[i * n + j] += (prev.wg[k] || 0) * keep;
      out.ww[i * n + j] += (prev.ww[k] || 0) * keep;
    }
  }
  return round(out);
}

function round(t) {
  for (const k of ["hg", "hw", "vg", "vw", "wg", "ww"]) {
    for (let i = 0; i < t[k].length; i++) t[k][i] = Math.round(t[k][i]);
  }
  return t;
}

function serialize(t, ids, bracket, updated) {
  return {
    v: 1,
    key: bracket.key,
    label: bracket.label,
    updated,
    matches: t.matches,
    ids,
    hg: Array.from(t.hg),
    hw: Array.from(t.hw),
    vg: Array.from(t.vg),
    vw: Array.from(t.vw),
    wg: Array.from(t.wg),
    ww: Array.from(t.ww),
  };
}

/* ---------- helpers ---------- */

async function api(route, attempt = 1) {
  await sleep(DELAY_MS);
  const url = new URL(API + route);
  if (KEY) url.searchParams.set("api_key", KEY);
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": "dota2-counter-picker (GitHub Actions)" } });
  } catch (err) {
    if (attempt >= 6) throw err;
    await sleep(2000 * attempt);
    return api(route, attempt + 1);
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`OpenDota answered ${res.status} for ${route}`);
    const wait = res.status === 429 ? 61000 : 3000 * attempt;
    console.log(`OpenDota answered ${res.status}, waiting ${Math.round(wait / 1000)}s`);
    await sleep(wait);
    return api(route, attempt + 1);
  }
  if (!res.ok) throw new Error(`OpenDota answered ${res.status} for ${route}`);
  return res.json();
}

async function writeJson(file, value) {
  await writeFile(path.join(DATA, file), JSON.stringify(value) + "\n");
}

function pick(b) {
  return { key: b.key, file: b.file, label: b.label };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toInt(v, d) {
  const x = parseInt(v, 10);
  return Number.isFinite(x) ? x : d;
}

function toFloat(v, d) {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : d;
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
