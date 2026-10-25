# Dota 2 Counter Picker

A single-page counter picker for Dota 2. Add the enemy draft (and your own picks, if you like) and it ranks every other hero by how well they do against that lineup.

It's a plain static site: HTML, CSS and one JavaScript file, no build step. GitHub Pages hosts it for free, and a GitHub Action refreshes the matchup data every week.

## What it does

- Two draft rows, your team and the enemy team. Click a team to choose where new picks go, then click heroes in the grid or type a name and press Enter. Short names work too (`am`, `qop`, `sf`, `kotl`, `wk`).
- **Best picks** and **Picks to avoid**, ranked by win rate against the enemy picks or by total counter advantage.
- Each suggestion shows its win rate against every enemy hero you've added, plus how well it pairs with your own picks.
- Filters for role (carry, mid, offlane, soft support, hard support) and rank bracket (Herald–Guardian up to Divine–Immortal).
- **My heroes**: mark the heroes you play and limit suggestions to them. Saved in your browser.
- **Copy draft link** shares the current draft, bracket and role as a URL.

## Where the numbers come from

`scripts/build-data.mjs` pulls randomly sampled public matches from OpenDota's free [`/publicMatches`](https://docs.opendota.com/) endpoint, separately for each rank bracket. Turbo, Ability Draft and matches shorter than 15 minutes are skipped. Every match adds 25 hero-vs-hero pairs and 20 hero-with-hero pairs to the tables in `data/`.

On the page, each pair's win rate is compared with what you'd expect from the two heroes' overall win rates, so a hero that's simply strong this patch doesn't top every list. Pairs with few games are pulled toward that expected value, which keeps rare matchups from producing wild numbers.

Each weekly build keeps half the weight of the previous one, so the data leans toward recent games and old patches fade out over a few weeks.

Until the first data build finishes, the page falls back to OpenDota's live pro-match matchups so it still works.

## Set up GitHub Pages

1. In the repo, open **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Open the **Actions** tab, pick **Build and deploy**, and click **Run workflow**. The first data build takes about 20 minutes because the free API allows 60 requests a minute.
3. The site goes live at `https://<your-username>.github.io/dota2-counter-picker/`.

After that it rebuilds the data every Monday and redeploys on every push.

## Options

Set these when running the workflow by hand, or as environment variables when running the script locally.

| Setting | Default | What it changes |
| --- | --- | --- |
| `PAGES_PER_BRACKET` | 250 | Pages of 100 matches sampled per bracket. More pages give steadier numbers and a longer build. |
| `MAX_AGE_DAYS` | 14 | Matches older than this are ignored. |
| `KEEP_PREVIOUS` | 0.5 | How much of the previous build to keep (0 starts fresh every time). |
| `OPENDOTA_API_KEY` | none | Add it as a repository secret if you have a premium key. Builds run much faster. |

Hero positions live in `data/positions.json`. Edit it if you disagree with a role, and new heroes get a guess from their in-game roles until you add them.

## Run it locally

```bash
python3 -m http.server 8000      # then open http://localhost:8000
node scripts/build-data.mjs      # rebuild data (Node 18+)
```

## Credits

Match data from [OpenDota](https://www.opendota.com/). Hero portraits are loaded from Valve's CDN. Dota 2 is a trademark of Valve Corporation; this is a fan project and isn't affiliated with Valve.
