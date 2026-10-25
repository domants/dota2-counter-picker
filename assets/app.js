/* Dota 2 Counter Picker
 * Reads data/heroes.json and data/b*.json (built by scripts/build-data.mjs).
 * If the bracket tables aren't there yet, falls back to OpenDota's live
 * pro-match matchups so the page still works on a fresh deploy.
 */
(() => {
  "use strict";

  const ROLES = { 1: "Carry", 2: "Mid", 3: "Offlane", 4: "Soft support", 5: "Hard support" };
  const ATTRS = [
    ["str", "Strength"],
    ["agi", "Agility"],
    ["int", "Intelligence"],
    ["all", "Universal"],
  ];
  const BRACKETS = [
    { key: "all", file: "b0", label: "All ranks" },
    { key: "hg", file: "b1", label: "Herald–Guardian" },
    { key: "ca", file: "b2", label: "Crusader–Archon" },
    { key: "la", file: "b3", label: "Legend–Ancient" },
    { key: "di", file: "b4", label: "Divine–Immortal" },
  ];
  const ALIASES = { bb: 99, bs: 4, es: 7, ls: 54, tb: 109, wr: 21, furion: 53, clock: 51, rattletrap: 51, zeus: 22, sk: 16, ogre: 84, sniper: 35 };
  const OPENDOTA = "https://api.opendota.com/api";
  const K_BASE = 50; // prior weight for a hero's overall win rate
  const K_PAIR = 40; // prior weight for an enemy pair; small samples lean on the expected value
  const K_SYN = 80; // ally pairs are noisier, so they need more games to move
  const LOW_GAMES = 15;
  const PAGE = window.matchMedia("(min-width: 1024px)").matches ? 20 : 8;
  const MINE_KEY = "cp.myHeroes";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    heroes: [],
    byId: new Map(),
    ally: [],
    enemy: [],
    active: "enemy",
    tab: "best",
    role: null,
    poolRole: null,
    onlyMine: false,
    mine: new Set(),
    editMine: false,
    bracket: "all",
    meta: null,
    provider: null,
    shown: PAGE,
    query: "",
  };

  const cache = { tables: new Map(), live: null };

  /* ---------- startup ---------- */

  init().catch((err) => {
    console.error(err);
    showNotice("Couldn't load the hero list. Reload the page to try again.");
  });

  async function init() {
    state.mine = new Set(readMine());
    readUrl();
    buildStaticControls();
    bindEvents();

    const [heroes, meta] = await Promise.all([getJson("data/heroes.json"), getJson("data/meta.json").catch(() => null)]);
    state.heroes = heroes.map((h) => ({ ...h, initials: initialsOf(h.name), lower: h.name.toLowerCase() }));
    state.byId = new Map(state.heroes.map((h) => [h.id, h]));
    state.meta = meta;
    state.ally = state.ally.filter((id) => state.byId.has(id)).slice(0, 5);
    state.enemy = state.enemy.filter((id) => state.byId.has(id) && !state.ally.includes(id)).slice(0, 5);
    fillBracketSelect();
    renderGrid();
    renderBoard();
    await loadProvider();
    renderResults();
  }

  async function loadProvider() {
    const b = BRACKETS.find((x) => x.key === state.bracket) || BRACKETS[0];
    try {
      if (!cache.tables.has(b.key)) {
        $("#list").setAttribute("aria-busy", "true");
        cache.tables.set(b.key, tableProvider(await getJson(`data/${b.file}.json`)));
      }
      state.provider = cache.tables.get(b.key);
    } catch {
      cache.live = cache.live || liveProvider();
      state.provider = cache.live;
    } finally {
      $("#list").removeAttribute("aria-busy");
    }
  }

  /* ---------- data providers ---------- */

  // Precomputed tables: flat n*n arrays indexed [row * n + col].
  function tableProvider(raw) {
    const n = raw.ids.length;
    const idx = new Map(raw.ids.map((id, i) => [id, i]));
    const pair = (g, w, c, o) => {
      const i = idx.get(c);
      const j = idx.get(o);
      if (i == null || j == null) return { g: 0, w: 0 };
      const k = i * n + j;
      return { g: g[k], w: w[k] };
    };
    return {
      kind: "tables",
      label: raw.label,
      matches: raw.matches,
      updated: raw.updated,
      ready: async () => {},
      base(id) {
        const i = idx.get(id);
        return i == null ? { g: 0, w: 0 } : { g: raw.hg[i], w: raw.hw[i] };
      },
      vs: (c, e) => pair(raw.vg, raw.vw, c, e),
      with: (c, a) => pair(raw.wg, raw.ww, c, a),
    };
  }

  // Live fallback: OpenDota's per-hero matchups (pro matches, last 12 months).
  function liveProvider() {
    const matchups = new Map();
    let stats = null;
    let failed = false;
    return {
      kind: "live",
      label: "Pro matches",
      get failed() {
        return failed;
      },
      async ready(enemyIds) {
        try {
          if (!stats) {
            const rows = await getJson(`${OPENDOTA}/heroStats`);
            stats = new Map(rows.map((r) => [r.id, r]));
          }
          const missing = enemyIds.filter((id) => !matchups.has(id));
          await Promise.all(
            missing.map(async (id) => {
              const rows = await getJson(`${OPENDOTA}/heroes/${id}/matchups`);
              matchups.set(id, new Map(rows.map((r) => [r.hero_id, r])));
            })
          );
          failed = false;
        } catch (err) {
          console.warn(err);
          failed = true;
        }
      },
      base(id) {
        const s = stats && stats.get(id);
        return s && s.pub_pick ? { g: s.pub_pick, w: s.pub_win } : { g: 0, w: 0 };
      },
      vs(c, e) {
        const row = matchups.get(e) && matchups.get(e).get(c);
        // The endpoint reports the enemy hero's wins, so flip them.
        return row ? { g: row.games_played, w: row.games_played - row.wins } : { g: 0, w: 0 };
      },
      with: () => null,
    };
  }

  /* ---------- scoring ---------- */

  const rate = (w, g, prior, k) => (w + prior * k) / (g + k);
  const odds = (p) => p / (1 - p);
  const fromOdds = (o) => o / (1 + o);

  function baseRate(p, id) {
    const b = p.base(id);
    return rate(b.w, b.g, 0.5, K_BASE);
  }

  function score(heroId) {
    const p = state.provider;
    const pc = baseRate(p, heroId);
    const vs = state.enemy.map((e) => {
      const { g, w } = p.vs(heroId, e);
      const expected = fromOdds(odds(pc) / odds(baseRate(p, e)));
      const s = rate(w, g, expected, K_PAIR);
      return { id: e, games: g, rate: s, raw: g ? w / g : null, adv: s - expected };
    });
    const withs = state.ally
      .map((a) => {
        const r = p.with(heroId, a);
        if (!r) return null;
        const expected = fromOdds(odds(pc) * odds(baseRate(p, a)));
        const s = rate(r.w, r.g, expected, K_SYN);
        return { id: a, games: r.g, rate: s, raw: r.g ? r.w / r.g : null, adv: s - expected };
      })
      .filter(Boolean);

    const mean = (xs, f) => (xs.length ? xs.reduce((t, x) => t + f(x), 0) / xs.length : 0);
    const sum = (xs, f) => xs.reduce((t, x) => t + f(x), 0);
    const winVs = vs.length ? mean(vs, (x) => x.rate) : null;
    const withRate = withs.length ? mean(withs, (x) => x.rate) : null;
    const advantage = sum(vs, (x) => x.adv);
    const synergy = sum(withs, (x) => x.adv);
    const headline = winVs ?? withRate ?? pc;
    // Rank by expected win rate; ally synergy nudges it up or down.
    const key = headline + (winVs != null && withs.length ? mean(withs, (x) => x.adv) : 0);
    const low = vs.some((x) => x.games < LOW_GAMES) || (!vs.length && withs.some((x) => x.games < LOW_GAMES));
    return { id: heroId, pc, vs, withs, winVs, withRate, headline, advantage, synergy, key, low };
  }

  /* ---------- rendering: board ---------- */

  function renderBoard() {
    for (const team of ["ally", "enemy"]) {
      const ids = state[team];
      const ol = $(`[data-slots="${team}"]`);
      ol.innerHTML = "";
      for (let i = 0; i < 5; i++) {
        const li = document.createElement("li");
        const id = ids[i];
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "slot";
        if (id) {
          const h = state.byId.get(id);
          btn.classList.add("slot-filled");
          btn.dataset.remove = String(id);
          btn.setAttribute("aria-label", `Remove ${h.name}`);
          btn.title = `Remove ${h.name}`;
          btn.append(portrait(h, "slot-img"));
          const x = document.createElement("span");
          x.className = "slot-x";
          x.setAttribute("aria-hidden", "true");
          x.textContent = "×";
          btn.append(x);
        } else {
          btn.dataset.setActive = team;
          btn.setAttribute("aria-label", `Add to ${team === "ally" ? "your team" : "enemy team"}`);
          btn.innerHTML = '<span class="slot-plus" aria-hidden="true">+</span>';
        }
        li.append(btn);
        ol.append(li);
      }
      $(`[data-count="${team}"]`).textContent = `${ids.length}/5`;
      const activeHere = state.active === team;
      $(`#team-${team}`).toggleAttribute("data-active", activeHere);
      $(`[data-set-active="${team}"].team-head`).setAttribute("aria-pressed", String(activeHere));
      $(`[data-hint="${team}"]`).textContent = activeHere ? "Adding here" : "Add here";
    }
    const target = state.active === "ally" ? "your team" : "enemy team";
    const narrow = window.matchMedia("(max-width: 520px)").matches;
    $("#search").placeholder = narrow ? `Add to ${target}` : `Add a hero to ${target}`;
    syncGridMarks();
    writeUrl();
  }

  /* ---------- rendering: hero grid ---------- */

  function renderGrid() {
    const grid = $("#grid");
    grid.innerHTML = "";
    for (const [attr, label] of ATTRS) {
      const heroes = state.heroes.filter((h) => h.attr === attr);
      if (!heroes.length) continue;
      const sec = document.createElement("section");
      sec.className = "attr";
      sec.dataset.attr = attr;
      sec.innerHTML = `<h2 class="attr-name"><span class="attr-dot" aria-hidden="true"></span>${label}</h2>`;
      const ul = document.createElement("ul");
      ul.className = "tiles";
      for (const h of heroes) {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "tile";
        b.dataset.hero = String(h.id);
        b.append(portrait(h, "tile-img"));
        const name = document.createElement("span");
        name.className = "tile-name";
        name.textContent = h.name;
        b.append(name);
        const star = document.createElement("span");
        star.className = "tile-star";
        star.setAttribute("aria-hidden", "true");
        star.textContent = "★";
        b.append(star);
        li.append(b);
        ul.append(li);
      }
      sec.append(ul);
      grid.append(sec);
    }
    filterGrid();
    syncGridMarks();
  }

  function filterGrid() {
    const q = state.query.trim().toLowerCase();
    const ranked = q ? search(q) : [];
    const matches = q ? new Set(ranked.map((h) => h.id)) : null;
    const visible = new Set();
    for (const tile of $$(".tile")) {
      const h = state.byId.get(Number(tile.dataset.hero));
      let show = true;
      if (state.poolRole === "mine") show = state.mine.has(h.id) || state.editMine;
      else if (state.poolRole) show = h.positions.includes(state.poolRole);
      if (matches) show = show && matches.has(h.id);
      tile.parentElement.hidden = !show;
      if (show) visible.add(h.id);
    }
    for (const sec of $$(".attr")) {
      sec.hidden = !$$(".tiles > li", sec).some((li) => !li.hidden);
    }

    // Highlight the best match so Enter in the hero search knows what to add.
    const best = ranked.find((h) => visible.has(h.id) && (state.editMine || !isPicked(h.id)));
    state.bestMatch = best ? best.id : null;
    for (const tile of $$(".tile.is-best")) tile.classList.remove("is-best");
    if (best) $(`.tile[data-hero="${best.id}"]`).classList.add("is-best");

    const empty = $("#pool-empty");
    empty.hidden = !q || visible.size > 0;
    if (!empty.hidden) {
      empty.textContent = state.poolRole
        ? `No heroes match "${state.query.trim()}" with this filter. Try All heroes.`
        : `No heroes match "${state.query.trim()}".`;
    }
  }

  function syncGridMarks() {
    for (const tile of $$(".tile")) {
      const id = Number(tile.dataset.hero);
      const h = state.byId.get(id);
      const team = state.ally.includes(id) ? "ally" : state.enemy.includes(id) ? "enemy" : "";
      if (team) tile.dataset.picked = team;
      else delete tile.dataset.picked;
      tile.classList.toggle("is-mine", state.mine.has(id));
      if (state.editMine) {
        tile.setAttribute("aria-pressed", String(state.mine.has(id)));
        tile.setAttribute("aria-label", `${h.name}, ${state.mine.has(id) ? "in" : "not in"} my heroes`);
      } else {
        tile.removeAttribute("aria-pressed");
        tile.setAttribute(
          "aria-label",
          team ? `${h.name}, on ${team === "ally" ? "your team" : "enemy team"}. Remove` : `Add ${h.name}`
        );
      }
    }
    $("#edit-mine").textContent = state.mine.size ? `Edit my heroes (${state.mine.size})` : "Edit my heroes";
  }

  /* ---------- rendering: results ---------- */

  async function renderResults() {
    const list = $("#list");
    const p = state.provider;
    if (!p) return;
    const noDraft = !state.enemy.length && !state.ally.length;
    renderSource();

    if (noDraft) {
      list.innerHTML = "";
      showNotice("Add at least one enemy hero to see who wins the most against them.");
      $("#more").hidden = true;
      return;
    }

    if (p.kind === "live") {
      list.setAttribute("aria-busy", "true");
      await p.ready(state.enemy);
      list.removeAttribute("aria-busy");
      if (p.failed) {
        list.innerHTML = "";
        showNotice("Matchup data isn't available right now. The data build may still be running, and OpenDota's live API didn't answer. Try again in a few minutes.");
        return;
      }
      if (!state.enemy.length) {
        list.innerHTML = "";
        showNotice("Ally synergy needs the full data build. Add an enemy hero to see counters.");
        return;
      }
    }

    const taken = new Set([...state.ally, ...state.enemy]);
    let pool = state.heroes.filter((h) => !taken.has(h.id));
    if (state.role) pool = pool.filter((h) => h.positions.includes(state.role));
    if (state.onlyMine) {
      if (!state.mine.size) {
        list.innerHTML = "";
        showNotice("You haven't picked your heroes yet. Use Edit my heroes in the hero list to choose them.");
        $("#more").hidden = true;
        return;
      }
      pool = pool.filter((h) => state.mine.has(h.id));
    }

    const scored = pool.map((h) => score(h.id));
    scored.sort((a, b) => (state.tab === "best" ? b.key - a.key : a.key - b.key));

    if (!scored.length) {
      list.innerHTML = "";
      showNotice("No heroes match these filters. Try another role or turn off Only my heroes.");
      $("#more").hidden = true;
      return;
    }

    hideNotice();
    if (p.kind === "live") {
      showNotice("Showing OpenDota pro-match data while the first data build runs. Rank brackets and ally synergy turn on once it finishes.", true);
    }

    const top = scored.slice(0, state.shown);
    list.dataset.tab = state.tab;
    list.innerHTML = "";
    top.forEach((s, i) => list.append(resultRow(s, i + 1)));
    $("#more").hidden = scored.length <= state.shown;

    const first = top[0];
    const firstName = state.byId.get(first.id).name;
    announce(
      state.tab === "best"
        ? `Best picks updated. ${firstName} is first with ${pct(first.headline)} ${headlineLabel(first)}.`
        : `Picks to avoid updated. ${firstName} is first with ${pct(first.headline)} ${headlineLabel(first)}.`
    );
  }

  function headlineLabel(s) {
    if (s.winVs != null) return "win rate vs them";
    if (s.withRate != null) return "win rate with your team";
    return "overall win rate";
  }

  function resultRow(s, rank) {
    const h = state.byId.get(s.id);
    const li = document.createElement("li");
    li.className = "row";
    if (s.low) li.classList.add("row-low");

    const rankEl = document.createElement("span");
    rankEl.className = "row-rank";
    rankEl.textContent = String(rank);

    const who = document.createElement("div");
    who.className = "row-who";
    const name = document.createElement("span");
    name.className = "row-name";
    name.textContent = h.name;
    const sub = document.createElement("span");
    sub.className = "row-sub";
    sub.append(`${pct(s.pc)} overall`);
    const extra = document.createElement("span");
    extra.className = "wide-only";
    extra.textContent = " win rate";
    sub.append(extra);
    if (s.low) sub.append(", few games");
    who.append(name, sub);

    // Second number: advantage against the enemy picks, or synergy when only allies are set.
    const edge = s.vs.length ? s.advantage : s.synergy;
    const edgeLabel = s.vs.length ? "advantage" : "synergy";
    const stats = document.createElement("div");
    stats.className = "row-stats";
    stats.append(stat(pct(s.headline), headlineLabel(s), "stat-main"), stat(signed(edge), edgeLabel, edge >= 0 ? "pos" : "neg"));

    const pairs = document.createElement("div");
    pairs.className = "row-pairs";
    if (s.vs.length) pairs.append(pairGroup("vs", s.vs));
    if (s.withs.length) pairs.append(pairGroup("with", s.withs));

    li.append(rankEl, portrait(h, "row-img"), who, stats, pairs);
    return li;
  }

  function stat(value, label, cls) {
    const el = document.createElement("div");
    el.className = `stat ${cls}`;
    const num = document.createElement("span");
    num.className = "stat-num";
    num.textContent = value;
    const lab = document.createElement("span");
    lab.className = "stat-label";
    lab.textContent = label;
    el.append(num, lab);
    return el;
  }

  function pairGroup(kind, items) {
    const group = document.createElement("div");
    group.className = `pair-group pair-group-${kind}`;
    const label = document.createElement("span");
    label.className = "pairs-label";
    label.setAttribute("aria-hidden", "true");
    label.textContent = kind;
    const ul = document.createElement("ul");
    ul.className = "pairs";
    ul.setAttribute("aria-label", kind === "vs" ? "Against each enemy hero" : "With each of your heroes");
    for (const x of items) ul.append(pairChip(x, kind));
    group.append(label, ul);
    return group;
  }

  function pairChip(x, kind) {
    const h = state.byId.get(x.id);
    const li = document.createElement("li");
    li.className = `pair pair-${kind} ${x.adv >= 0 ? "pos" : "neg"}`;
    const raw = x.raw == null ? "no games yet" : `${pct(x.raw)} win rate over ${x.games.toLocaleString()} games`;
    const relation = kind === "vs" ? "Against" : "With";
    const delta = `${Math.abs(x.adv * 100).toFixed(1)} points ${x.adv >= 0 ? "better" : "worse"} than expected`;
    li.title = `${relation} ${h.name}: ${raw}, ${delta}.`;
    li.append(portrait(h, "pair-img"));
    const t = document.createElement("span");
    t.className = "pair-num";
    t.setAttribute("aria-hidden", "true");
    t.textContent = signed(x.adv);
    li.append(t);
    const sr = document.createElement("span");
    sr.className = "sr-only";
    sr.textContent = `${relation} ${h.name}: ${raw}, ${delta}.`;
    li.append(sr);
    return li;
  }

  function renderSource() {
    const el = $("#source");
    const p = state.provider;
    if (!p) return (el.textContent = "");
    if (p.kind === "live") {
      el.textContent = "Data: OpenDota pro matches from the last 12 months, loaded live.";
      return;
    }
    const meta = state.meta;
    let range = "";
    if (meta && meta.sampleFrom && meta.sampleTo) {
      const a = shortDate(meta.sampleFrom * 1000);
      const b = shortDate(meta.sampleTo * 1000);
      range = a === b ? `, newest from ${a}` : `, newest from ${a} to ${b}`;
    }
    el.textContent = `Advantage is how many points better or worse a hero does against these picks than its usual win rate predicts. Based on ${p.matches.toLocaleString()} public matches (${p.label})${range}. Updated ${shortDate(p.updated)}.`;
  }

  /* ---------- controls ---------- */

  function buildStaticControls() {
    const roleChips = $("#role-chips");
    for (const [n, label] of Object.entries(ROLES)) {
      roleChips.append(chip(label, { role: n }, state.role === Number(n)));
    }
    const poolChips = $("#pool-chips");
    poolChips.append(chip("All heroes", { pool: "" }, !state.poolRole));
    for (const [n, label] of Object.entries(ROLES)) poolChips.append(chip(label, { pool: n }, false));
    poolChips.append(chip("My heroes", { pool: "mine" }, false));
    setTab(state.tab, false);
  }

  function chip(label, data, pressed) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = label;
    Object.assign(b.dataset, data);
    b.setAttribute("aria-pressed", String(pressed));
    return b;
  }

  function fillBracketSelect() {
    const sel = $("#bracket");
    sel.innerHTML = "";
    for (const b of BRACKETS) {
      const o = document.createElement("option");
      o.value = b.key;
      const m = state.meta && state.meta.brackets && state.meta.brackets.find((x) => x.key === b.key);
      o.textContent = b.label;
      if (m && m.matches) o.title = `${m.matches.toLocaleString()} matches`;
      sel.append(o);
    }
    sel.value = state.bracket;
    sel.disabled = !state.meta;
    sel.title = state.meta ? "" : "Rank brackets turn on after the first data build";
  }

  function setTab(tab, rerender = true) {
    state.tab = tab;
    for (const t of $$(".tab")) t.setAttribute("aria-pressed", String(t.dataset.tab === tab));
    state.shown = PAGE;
    if (rerender) {
      writeUrl();
      renderResults();
    }
  }

  function bindEvents() {
    document.addEventListener("click", (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      if (t.dataset.remove) return removeHero(Number(t.dataset.remove));
      if (t.dataset.setActive) return setActive(t.dataset.setActive);
      if (t.dataset.hero) return onTile(Number(t.dataset.hero));
      if (t.dataset.tab) return setTab(t.dataset.tab);
      if (t.dataset.role) {
        const n = Number(t.dataset.role);
        state.role = state.role === n ? null : n;
        for (const c of $$("#role-chips .chip")) c.setAttribute("aria-pressed", String(Number(c.dataset.role) === state.role));
        state.shown = PAGE;
        writeUrl();
        return renderResults();
      }
      if ("pool" in t.dataset) {
        const v = t.dataset.pool;
        state.poolRole = v === "mine" ? "mine" : v ? Number(v) : null;
        for (const c of $$("#pool-chips .chip")) c.setAttribute("aria-pressed", String(c === t));
        return filterGrid();
      }
      if (t.dataset.suggest) {
        addHero(Number(t.dataset.suggest));
        clearSearch();
        $("#search").focus();
      }
    });

    $("#more").addEventListener("click", () => {
      state.shown += PAGE * 2;
      renderResults();
    });

    $("#only-mine").addEventListener("change", (e) => {
      state.onlyMine = e.target.checked;
      state.shown = PAGE;
      renderResults();
    });

    $("#edit-mine").addEventListener("click", () => setEditMine(!state.editMine));
    $("#edit-done").addEventListener("click", () => setEditMine(false));

    $("#bracket").addEventListener("change", async (e) => {
      state.bracket = e.target.value;
      state.shown = PAGE;
      writeUrl();
      await loadProvider();
      renderResults();
    });

    $("#share").addEventListener("click", async () => {
      writeUrl();
      try {
        await navigator.clipboard.writeText(location.href);
        toast("Draft link copied");
      } catch {
        prompt("Copy this link:", location.href);
      }
    });

    $("#clear").addEventListener("click", () => {
      state.ally = [];
      state.enemy = [];
      state.active = "enemy";
      state.shown = PAGE;
      renderBoard();
      renderResults();
    });

    const input = $("#search");
    input.addEventListener("input", () => {
      setQuery(input.value);
      renderSuggest();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        // Add the highlighted tile; if a role filter hides every match, fall back to the best match overall.
        const q = input.value.trim().toLowerCase();
        const fallback = !state.editMine && search(q).find((h) => !isPicked(h.id));
        const id = state.bestMatch ?? (fallback ? fallback.id : null);
        if (id) {
          onTile(id);
          clearSearch();
        }
      } else if (e.key === "Escape") {
        clearSearch();
      } else if (e.key === "ArrowDown") {
        const first = $("#suggest button");
        if (first && first.offsetParent) {
          e.preventDefault();
          first.focus();
        }
      }
    });
    $("#suggest").addEventListener("keydown", (e) => {
      const items = $$("#suggest button");
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" && i < items.length - 1) {
        e.preventDefault();
        items[i + 1].focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        (i > 0 ? items[i - 1] : input).focus();
      } else if (e.key === "Escape") {
        clearSearch();
        input.focus();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) {
        e.preventDefault();
        input.focus();
      }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".finder")) $("#suggest").hidden = true;
    });

    window.addEventListener("popstate", () => {
      readUrl();
      renderBoard();
      renderResults();
    });
  }

  function setEditMine(on) {
    state.editMine = on;
    $("#edit-mine").setAttribute("aria-pressed", String(on));
    $("#edit-banner").hidden = !on;
    document.body.classList.toggle("editing-mine", on);
    filterGrid();
    syncGridMarks();
    if (!on && state.onlyMine) renderResults();
  }

  function onTile(id) {
    if (state.editMine) {
      if (state.mine.has(id)) state.mine.delete(id);
      else state.mine.add(id);
      saveMine();
      syncGridMarks();
      return;
    }
    if (isPicked(id)) removeHero(id);
    else addHero(id);
    // After picking from a filtered list, reset it for the next search.
    if (state.query) {
      clearSearch();
      if (!window.matchMedia("(hover: none)").matches) $("#search").focus();
    }
  }

  function setActive(team) {
    state.active = team;
    renderBoard();
  }

  function addHero(id) {
    if (isPicked(id)) return;
    const team = state.active;
    if (state[team].length >= 5) {
      const other = team === "ally" ? "enemy" : "ally";
      toast(`${team === "ally" ? "Your team" : "Enemy team"} is full. Remove a hero or switch teams.`);
      if (state[other].length < 5) setActive(other);
      return;
    }
    state[team].push(id);
    state.shown = PAGE;
    renderBoard();
    renderResults();
  }

  function removeHero(id) {
    state.ally = state.ally.filter((x) => x !== id);
    state.enemy = state.enemy.filter((x) => x !== id);
    state.shown = PAGE;
    renderBoard();
    renderResults();
  }

  const isPicked = (id) => state.ally.includes(id) || state.enemy.includes(id);

  /* ---------- search ---------- */

  function search(q) {
    if (!q) return [];
    const scoredHeroes = [];
    for (const h of state.heroes) {
      let s = 0;
      if (ALIASES[q] === h.id) s = 100;
      else if (h.initials === q) s = 90;
      else if (h.lower.startsWith(q)) s = 80;
      else if (h.lower.split(/[\s-]+/).some((w) => w.startsWith(q))) s = 60;
      else if (h.lower.replace(/[^a-z]/g, "").includes(q.replace(/[^a-z]/g, ""))) s = 40;
      if (s) scoredHeroes.push([s, h]);
    }
    return scoredHeroes.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name)).map((x) => x[1]);
  }

  function renderSuggest() {
    const ul = $("#suggest");
    const q = state.query.trim().toLowerCase();
    const hits = search(q).filter((h) => !isPicked(h.id)).slice(0, 6);
    ul.innerHTML = "";
    ul.hidden = !hits.length;
    for (const h of hits) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "suggest-item";
      b.dataset.suggest = String(h.id);
      b.append(portrait(h, "suggest-img"));
      const s = document.createElement("span");
      s.textContent = h.name;
      b.append(s);
      li.append(b);
      ul.append(li);
    }
  }

  function setQuery(value) {
    state.query = value;
    filterGrid();
    if (value.trim()) revealGrid();
  }

  // On wide screens the filtered hero list is the search result, so keep it in view.
  function revealGrid() {
    if (!window.matchMedia("(min-width: 1024px)").matches) return;
    const finderBottom = $(".finder").getBoundingClientRect().bottom;
    const poolTop = $(".pool").getBoundingClientRect().top;
    if (poolTop < finderBottom) window.scrollBy({ top: poolTop - finderBottom - 8 });
  }

  function clearSearch() {
    $("#search").value = "";
    state.query = "";
    $("#suggest").hidden = true;
    filterGrid();
  }

  function initialsOf(name) {
    return name
      .toLowerCase()
      .split(/[\s-]+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join("");
  }

  /* ---------- URL and storage ---------- */

  function readUrl() {
    const q = new URLSearchParams(location.search);
    const ids = (k) =>
      (q.get(k) || "")
        .split(",")
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
    state.enemy = [...new Set(ids("e"))];
    state.ally = [...new Set(ids("a"))].filter((id) => !state.enemy.includes(id));
    const b = q.get("b");
    state.bracket = BRACKETS.some((x) => x.key === b) ? b : "all";
    const r = Number(q.get("r"));
    state.role = ROLES[r] ? r : null;
    state.tab = q.get("t") === "avoid" ? "avoid" : "best";
    if (state.byId.size) {
      state.ally = state.ally.filter((id) => state.byId.has(id));
      state.enemy = state.enemy.filter((id) => state.byId.has(id));
    }
  }

  function writeUrl() {
    const q = new URLSearchParams();
    if (state.enemy.length) q.set("e", state.enemy.join(","));
    if (state.ally.length) q.set("a", state.ally.join(","));
    if (state.bracket !== "all") q.set("b", state.bracket);
    if (state.role) q.set("r", String(state.role));
    if (state.tab === "avoid") q.set("t", "avoid");
    const s = q.toString().replace(/%2C/g, ",");
    const url = `${location.pathname}${s ? `?${s}` : ""}`;
    if (url !== `${location.pathname}${location.search}`) history.replaceState(null, "", url);
  }

  function readMine() {
    try {
      return JSON.parse(localStorage.getItem(MINE_KEY) || "[]").filter(Number.isInteger);
    } catch {
      return [];
    }
  }

  function saveMine() {
    try {
      localStorage.setItem(MINE_KEY, JSON.stringify([...state.mine]));
    } catch {
      /* private mode: keep it for this visit only */
    }
  }

  /* ---------- small helpers ---------- */

  function portrait(h, cls) {
    const wrap = document.createElement("span");
    wrap.className = `pic ${cls}`;
    wrap.dataset.initials = h.initials.slice(0, 3).toUpperCase();
    const img = document.createElement("img");
    img.src = h.img;
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("load", () => img.classList.add("ok"), { once: true });
    img.addEventListener("error", () => img.remove(), { once: true });
    wrap.append(img);
    return wrap;
  }

  async function getJson(url) {
    const res = await fetch(url, { cache: url.startsWith("http") ? "default" : "no-cache" });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }

  function showNotice(text, soft = false) {
    const n = $("#notice");
    n.textContent = text;
    n.classList.toggle("notice-soft", soft);
    n.hidden = false;
    if (!soft) announce(text);
  }

  // One stable status region, so screen readers hear a short summary
  // instead of the whole result list on every change.
  function announce(text) {
    const el = $("#result-status");
    if (el.textContent !== text) el.textContent = text;
  }

  function hideNotice() {
    $("#notice").hidden = true;
  }

  let toastTimer;
  function toast(text) {
    const t = $("#toast");
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  const pct = (x) => `${Math.round(x * 100)}%`;
  const signed = (x) => {
    const v = (x * 100).toFixed(1);
    return x >= 0 ? `+${v}` : `−${v.replace("-", "")}`;
  };
  const shortDate = (d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
})();
