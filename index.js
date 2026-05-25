const express = require("express");
const cors    = require("cors");
const { META, ANIME } = require("@consumet/extensions");

const app = express();
app.use(cors());
app.use(express.json());

const ANIMEX_BASE = "https://pp.animex.one/rest/api";
const ANIMEX_GQL  = "https://graphql.animex.one/graphql";
const ANILIST_GQL = "https://graphql.anilist.co";

// ── Slug cache (in-memory) ─────────────────────────────────────────────────
const slugCache = new Map();

function getCachedSlug(anilistId) {
  return slugCache.get(String(anilistId)) ?? null;
}
function setCachedSlug(anilistId, slug) {
  slugCache.set(String(anilistId), slug);
  console.log(`[cache] saved ${anilistId} → ${slug}`);
}

// ── AniList GraphQL ────────────────────────────────────────────────────────
async function fetchAnilistInfo(anilistId) {
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        title { romaji english native }
        description
        status
        episodes
        duration
        genres
        averageScore
        coverImage { large extraLarge }
        bannerImage
        season
        seasonYear
        studios(isMain: true) { nodes { name } }
        nextAiringEpisode { episode airingAt }
      }
    }
  `;
  const res = await fetch(ANILIST_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { id: parseInt(anilistId) } }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data.Media;
}

// ── Resolve slug via animex.one GraphQL ───────────────────────────────────
async function resolveSlugViaGraphQL(media) {
  const titles = [
    media.title?.english,
    media.title?.romaji,
    media.title?.english?.split(/[:\-]/)[0].trim(),
    media.title?.romaji?.split(/[:\-]/)[0].trim(),
  ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);

  const query = `
    query CatalogAnime($filter: AnimeCatalogFilterInput, $sort: [AnimeSortInput!], $limit: Int, $offset: Int) {
      catalogAnime(filter: $filter, sort: $sort, limit: $limit, offset: $offset) {
        items {
          id
          anilistId
          titleRomaji
          titleEnglish
        }
      }
    }
  `;

  for (const title of titles) {
    try {
      console.log(`[graphql] searching: "${title}"`);
      const res = await fetch(ANIMEX_GQL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          variables: {
            filter: { query: title },
            sort:   [{ field: "POPULARITY", direction: "DESC" }],
            limit:  10,
            offset: 0,
          },
        }),
        signal: AbortSignal.timeout(8000),
      });

      const json = await res.json();
      const items = json?.data?.catalogAnime?.items ?? [];

      const exact = items.find(item => item.anilistId === media.id);
      if (exact) {
        console.log(`[graphql] ✓ anilistId ${media.id} → ${exact.id}`);
        return exact.id;
      }

      if (items.length === 1) {
        console.log(`[graphql] ✓ single result → ${items[0].id}`);
        return items[0].id;
      }
    } catch (err) {
      console.warn(`[graphql] "${title}" failed: ${err.message}`);
    }
  }

  return null;
}

// ── animex.one episode list ────────────────────────────────────────────────
async function fetchAnimexEpisodes(slug) {
  const res = await fetch(`${ANIMEX_BASE}/episodes?id=${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`animex episodes HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error("animex returned non-array");
  return json;
}

// ── Consumet providers (video sources only) ───────────────────────────────
function getProviders() {
  const list = [];
  const tryAdd = (name, factory) => {
    try { list.push({ name, instance: factory() }); }
    catch (e) { console.warn(`Skipping "${name}": ${e.message}`); }
  };
  if (ANIME.Aniwatch)       tryAdd("aniwatch",  () => new META.Anilist(new ANIME.Aniwatch()));
  else if (ANIME.Zoro)      tryAdd("zoro",      () => new META.Anilist(new ANIME.Zoro()));
  tryAdd("gogoanime", () => new META.Anilist(new ANIME.Gogoanime()));
  tryAdd("animefox",  () => new META.Anilist(new ANIME.AnimeFox()));
  tryAdd("default",   () => new META.Anilist());
  return list;
}

async function withFallback(fn) {
  const errors = [];
  for (const p of getProviders()) {
    try {
      const result = await fn(p.instance);
      if (result) return { result, provider: p.name };
    } catch (err) { errors.push(`${p.name}: ${err.message}`); }
  }
  throw new Error(`All providers failed:\n${errors.join("\n")}`);
}

// ── GET /anime/:id ─────────────────────────────────────────────────────────
app.get("/anime/:id", async (req, res) => {
  try {
    const anilistId = req.params.id;

    if (req.query.slug) setCachedSlug(anilistId, req.query.slug);

    const media = await fetchAnilistInfo(anilistId);

    let slug = getCachedSlug(anilistId);

    if (!slug) {
      slug = await resolveSlugViaGraphQL(media);
      if (slug) setCachedSlug(anilistId, slug);
    }

    if (!slug) {
      return res.status(404).json({
        ok:    false,
        error: "Could not resolve animex slug. Provide it once to cache it.",
        fix:   `GET /anime/${anilistId}?slug=YOUR-SLUG`,
        media,
      });
    }

    const episodes = await fetchAnimexEpisodes(slug);
    res.json({ ok: true, slug, media, episodes });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /episodes/:slug ────────────────────────────────────────────────────
app.get("/episodes/:slug(*)", async (req, res) => {
  try {
    res.json(await fetchAnimexEpisodes(req.params.slug));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /search?q= ────────────────────────────────────────────────────────
app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ ok: false, error: "Missing ?q=" });

  try {
    const gqlRes = await fetch(ANIMEX_GQL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `
          query CatalogAnime($filter: AnimeCatalogFilterInput, $sort: [AnimeSortInput!], $limit: Int, $offset: Int) {
            catalogAnime(filter: $filter, sort: $sort, limit: $limit, offset: $offset) {
              items {
                id anilistId malId titleRomaji titleEnglish coverImage bannerImage
                description status format averageScore popularity episodeCount
                seasonYear season genres
              }
              totalCount
            }
          }
        `,
        variables: {
          filter: { query: q },
          sort:   [{ field: "POPULARITY", direction: "DESC" }],
          limit:  parseInt(req.query.limit) || 20,
          offset: parseInt(req.query.offset) || 0,
        },
      }),
    });
    const json = await gqlRes.json();
    res.json(json?.data?.catalogAnime ?? { items: [], totalCount: 0 });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /cache ─────────────────────────────────────────────────────────────
app.get("/cache", (req, res) => res.json(Object.fromEntries(slugCache)));

// ── POST /cache — bulk seed ────────────────────────────────────────────────
app.post("/cache", (req, res) => {
  for (const [k, v] of Object.entries(req.body)) slugCache.set(k, v);
  res.json({ ok: true, cache: Object.fromEntries(slugCache) });
});

// ── GET /sources/:anilistId/:epNum ─────────────────────────────────────────
app.get("/sources/:anilistId/:epNum", async (req, res) => {
  const { anilistId, epNum } = req.params;
  const ep = parseInt(epNum, 10);
  try {
    const { result: info } = await withFallback(p => p.fetchAnimeInfo(anilistId));
    if (!info?.episodes?.length)
      return res.status(404).json({ ok: false, error: "No episodes found" });

    const episode =
      info.episodes.find(e => e.number === ep) || info.episodes[ep - 1];
    if (!episode)
      return res.status(404).json({ ok: false, error: `Episode ${ep} not found` });

    let raw;
    const srcErrors = [];
    for (const p of getProviders()) {
      try {
        raw = await p.instance.fetchEpisodeSources(episode.id);
        if (raw?.sources?.length) break;
      } catch (err) { srcErrors.push(`${p.name}: ${err.message}`); }
    }

    if (!raw?.sources?.length)
      return res.status(404).json({
        ok: false, error: `No sources for episode ${ep}`, details: srcErrors,
      });

    res.json({
      sources:  raw.sources.map(s => ({ url: s.url, quality: s.quality || "default" })),
      tracks:   raw.subtitles ?? raw.tracks ?? null,
      audio:    raw.audio ?? null,
      chapters: raw.intro
        ? [{ title: "Intro", start: raw.intro.start, end: raw.intro.end }]
        : [],
      headers:  raw.headers ?? null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /sources/direct/:episodeId ─────────────────────────────────────────
app.get("/sources/direct/:episodeId(*)", async (req, res) => {
  try {
    const { result: raw } = await withFallback(p =>
      p.fetchEpisodeSources(req.params.episodeId)
    );
    res.json({
      sources:  (raw.sources || []).map(s => ({ url: s.url, quality: s.quality || "default" })),
      tracks:   raw.subtitles ?? raw.tracks ?? null,
      audio:    raw.audio ?? null,
      chapters: raw.intro
        ? [{ title: "Intro", start: raw.intro.start, end: raw.intro.end }]
        : [],
      headers:  raw.headers ?? null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nAnime server → http://localhost:${PORT}`);
  console.log(`  Anime + episodes   GET /anime/174576`);
  console.log(`  Manual slug        GET /anime/174576?slug=wistoria-wand-and-sword-y5byh`);
  console.log(`  Search             GET /search?q=wistoria`);
  console.log(`  Episode list       GET /episodes/wistoria-wand-and-sword-y5byh`);
  console.log(`  Video sources      GET /sources/174576/1`);
  console.log(`  Direct sources     GET /sources/direct/<episodeId>`);
  console.log(`  View slug cache    GET /cache`);
  console.log(`  Bulk seed cache    POST /cache  { "174576": "slug-here" }\n`);
});