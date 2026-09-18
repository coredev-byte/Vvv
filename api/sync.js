// api/sync.js
// Vercel Serverless Function (Node runtime). Runs server-side only —
// this is the ONE place real API keys are used. They must be set as
// Environment Variables in the Vercel project dashboard, never committed
// to the repo and never sent to the browser.
//
// Required env vars (set in Vercel → Project → Settings → Environment Variables):
//   RIOT_API_KEY            (required for any real Riot data)
//   RIOT_PLATFORM_SHARD     (e.g. "na", "eu", "ap", "kr", "latam", "br" — default "na")
//   ANTHROPIC_API_KEY       (optional — enables real AI analysis)
//   HENRIKDEV_ENABLED       ("true" to enable the optional unofficial fallback)
//   HENRIKDEV_API_KEY       (only if HENRIKDEV_ENABLED=true)

const ACCOUNT_ROUTING_BASE = "https://americas.api.riotgames.com"; // account-v1 uses continental routing
const AGENTS_FALLBACK = ["Jett", "Reyna", "Omen", "Killjoy", "Sova", "Sage", "Raze"];
const MAPS_FALLBACK = ["Ascent", "Bind", "Haven", "Icebox", "Lotus", "Pearl"];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { gameName, tagLine } = req.body || {};
  if (!gameName || !tagLine) {
    return res.status(400).json({ error: "gameName e tagLine são obrigatórios." });
  }

  const RIOT_API_KEY = process.env.RIOT_API_KEY || "";
  const SHARD = process.env.RIOT_PLATFORM_SHARD || "na";
  const SHARD_BASE = `https://${SHARD}.api.riotgames.com`;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
  const HENRIKDEV_ENABLED = process.env.HENRIKDEV_ENABLED === "true";
  const HENRIKDEV_API_KEY = process.env.HENRIKDEV_API_KEY || "";

  if (!RIOT_API_KEY) {
    return res.status(500).json({
      error: "RIOT_API_KEY não configurada no servidor. Adicione em Vercel → Settings → Environment Variables.",
      code: "MISSING_RIOT_KEY",
    });
  }

  // -------- 1. Identity: account-v1 (works with a personal key) --------
  let identity;
  try {
    const accRes = await fetch(
      `${ACCOUNT_ROUTING_BASE}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(
        gameName
      )}/${encodeURIComponent(tagLine)}`,
      { headers: { "X-Riot-Token": RIOT_API_KEY } }
    );
    if (accRes.status === 404) {
      return res.status(404).json({ error: `Jogador ${gameName}#${tagLine} não encontrado.` });
    }
    if (accRes.status === 403) {
      return res.status(403).json({
        error: "Riot recusou a chave (403). Verifique se RIOT_API_KEY está correta e ainda válida (chaves de desenvolvedor expiram em 24h).",
        code: "RIOT_KEY_INVALID",
      });
    }
    if (!accRes.ok) {
      return res.status(502).json({ error: `Falha ao consultar account-v1: ${accRes.status}` });
    }
    identity = await accRes.json(); // { puuid, gameName, tagLine }
  } catch (err) {
    return res.status(502).json({ error: `Erro de rede ao chamar a Riot: ${err.message}` });
  }

  // -------- 2. Content catalog: val-content-v1 (also works with a personal key) --------
  let agentsCatalog = AGENTS_FALLBACK.map((n) => ({ name: n }));
  let mapsCatalog = MAPS_FALLBACK.map((n) => ({ name: n }));
  let contentOk = false;
  try {
    const contentRes = await fetch(`${SHARD_BASE}/val/content/v1/contents?locale=pt-BR`, {
      headers: { "X-Riot-Token": RIOT_API_KEY },
    });
    if (contentRes.ok) {
      const content = await contentRes.json();
      agentsCatalog = (content.characters || []).map((c) => ({ name: c.name, id: c.id }));
      mapsCatalog = (content.maps || []).map((m) => ({ name: m.name, id: m.id }));
      contentOk = true;
    }
  } catch {
    // Non-fatal — we keep the fallback catalog and continue.
  }

  // -------- 3. Match history: val-match-v1 (needs production access) --------
  let matches = [];
  let matchDataStatus = "not_attempted";

  try {
    const listRes = await fetch(
      `${SHARD_BASE}/val/match/v1/matchlists/by-puuid/${identity.puuid}`,
      { headers: { "X-Riot-Token": RIOT_API_KEY } }
    );

    if (listRes.status === 403) {
      matchDataStatus = "riot_production_required";
    } else if (listRes.ok) {
      const listData = await listRes.json();
      const matchIds = (listData.history || []).slice(0, 10).map((h) => h.matchId); // capped for serverless timeout
      for (const matchId of matchIds) {
        const mRes = await fetch(`${SHARD_BASE}/val/match/v1/matches/${matchId}`, {
          headers: { "X-Riot-Token": RIOT_API_KEY },
        });
        if (!mRes.ok) continue;
        const raw = await mRes.json();
        const normalized = normalizeRiotMatch(raw, identity.puuid);
        if (normalized) matches.push(normalized);
      }
      matchDataStatus = matches.length > 0 ? "ok_riot" : "riot_empty_history";
    } else {
      matchDataStatus = "riot_error";
    }
  } catch {
    matchDataStatus = "riot_error";
  }

  // -------- 3b. Optional fallback: HenrikDev (unofficial) --------
  if (matchDataStatus === "riot_production_required" && HENRIKDEV_ENABLED && HENRIKDEV_API_KEY) {
    try {
      const region = process.env.RIOT_PLATFORM_SHARD || "na";
      const hRes = await fetch(
        `https://api.henrikdev.xyz/valorant/v4/matches/${region}/pc/${encodeURIComponent(
          gameName
        )}/${encodeURIComponent(tagLine)}?size=10`,
        { headers: { Authorization: HENRIKDEV_API_KEY } }
      );
      if (hRes.ok) {
        const hData = await hRes.json();
        matches = (hData.data || [])
          .map((m) => normalizeHenrikMatch(m, identity.puuid))
          .filter(Boolean);
        matchDataStatus = matches.length > 0 ? "ok_henrikdev" : "henrikdev_empty";
      }
    } catch {
      // keep matchDataStatus as riot_production_required if this also fails
    }
  }

  // -------- 4. Compute metrics (only from real matches — never fabricated) --------
  const overall = aggregate(matches);
  const byAgent = groupBy(matches, "agentName");
  const byMap = groupBy(matches, "mapName");
  const styleIndices = matches.length >= 5 ? computeStyle(matches, overall) : null;
  const playstyle = styleIndices ? classifyPlaystyle(styleIndices) : null;

  // -------- 5. AI analysis via real Claude call (only if we have real matches) --------
  let aiAnalysis = null;
  if (ANTHROPIC_API_KEY && matches.length > 0) {
    try {
      aiAnalysis = await callClaude(ANTHROPIC_API_KEY, {
        player: { gameName: identity.gameName, tagLine: identity.tagLine },
        matchesConsidered: matches.length,
        overall,
        agents: byAgent,
        maps: byMap,
        styleIndices,
        computedPlaystyle: playstyle,
      });
    } catch (err) {
      aiAnalysis = { error: `Claude indisponível: ${err.message}` };
    }
  }

  return res.status(200).json({
    identity: { gameName: identity.gameName, tagLine: identity.tagLine, puuid: identity.puuid },
    riotConnectionOk: true,
    contentCatalog: { source: contentOk ? "riot" : "fallback", agentsCount: agentsCatalog.length, mapsCount: mapsCatalog.length },
    matchDataStatus,
    matches,
    overall,
    byAgent,
    byMap,
    styleIndices,
    playstyle,
    aiAnalysis,
  });
}

// ---------------- helpers ----------------

function normalizeRiotMatch(raw, puuid) {
  const me = raw?.players?.find((p) => p.puuid === puuid);
  if (!me) return null;
  const myTeam = raw?.teams?.find((t) => t.teamId === me.teamId);
  const roundsWon = myTeam?.roundsWon ?? 0;
  const roundsPlayed = raw?.roundResults?.length ?? myTeam?.numPoints ?? 0;
  const roundsLost = Math.max(0, roundsPlayed - roundsWon);
  const stats = me.stats || {};
  const shots = (stats.headshots || 0) + (stats.bodyshots || 0) + (stats.legshots || 0);
  return {
    source: "riot",
    mapName: raw.matchInfo?.mapId ?? "unknown",
    agentName: me.characterId ?? "unknown",
    playedAt: new Date(raw.matchInfo?.gameStartMillis ?? Date.now()).toISOString(),
    won: myTeam?.won ?? false,
    kills: stats.kills ?? 0,
    deaths: stats.deaths ?? 0,
    assists: stats.assists ?? 0,
    acs: roundsPlayed > 0 ? Math.round((stats.score ?? 0) / roundsPlayed) : 0,
    adr: 0,
    hs: shots > 0 ? Math.round((stats.headshots / shots) * 1000) / 10 : 0,
    firstKills: 0,
    firstDeaths: 0,
  };
}

function normalizeHenrikMatch(m, puuid) {
  const me = m.players?.all_players?.find((p) => p.puuid === puuid);
  if (!me) return null;
  const teamKey = me.team?.toLowerCase();
  const team = m.teams?.[teamKey] || {};
  const rounds = m.metadata?.rounds_played || 1;
  return {
    source: "tracker",
    mapName: m.metadata?.map ?? "unknown",
    agentName: me.character ?? "unknown",
    playedAt: new Date((m.metadata?.game_start ?? 0) * 1000).toISOString(),
    won: !!team.has_won,
    kills: me.stats?.kills ?? 0,
    deaths: me.stats?.deaths ?? 0,
    assists: me.stats?.assists ?? 0,
    acs: me.stats?.score ? Math.round(me.stats.score / rounds) : 0,
    adr: me.damage_made ? Math.round(me.damage_made / rounds) : 0,
    hs: me.stats?.headshots
      ? Math.round((me.stats.headshots / (me.stats.headshots + me.stats.bodyshots + me.stats.legshots || 1)) * 1000) / 10
      : 0,
    firstKills: me.first_kills ?? 0,
    firstDeaths: me.first_deaths ?? 0,
  };
}

function avg(arr) { return arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null; }

function aggregate(matches) {
  if (matches.length === 0) {
    return { n: 0, kd: null, acs: null, adr: null, hs: null, winRate: null, kills: null, deaths: null, assists: null, firstKills: null, firstDeaths: null };
  }
  const kills = matches.reduce((s, m) => s + m.kills, 0);
  const deaths = matches.reduce((s, m) => s + m.deaths, 0);
  const assists = matches.reduce((s, m) => s + m.assists, 0);
  const wins = matches.filter((m) => m.won).length;
  return {
    n: matches.length,
    kd: deaths > 0 ? Math.round((kills / deaths) * 100) / 100 : kills,
    acs: avg(matches.map((m) => m.acs)),
    adr: avg(matches.map((m) => m.adr)),
    hs: avg(matches.map((m) => m.hs)),
    kills, deaths, assists,
    firstKills: matches.reduce((s, m) => s + m.firstKills, 0),
    firstDeaths: matches.reduce((s, m) => s + m.firstDeaths, 0),
    winRate: Math.round((wins / matches.length) * 1000) / 10,
  };
}

function groupBy(matches, key) {
  const groups = {};
  matches.forEach((m) => { (groups[m[key]] = groups[m[key]] || []).push(m); });
  return Object.entries(groups).map(([name, ms]) => ({ name, ...aggregate(ms) })).sort((a, b) => b.n - a.n);
}

function clamp(n) { return Math.max(0, Math.min(100, Math.round(n))); }

function computeStyle(matches, overall) {
  const fe = overall.firstKills + overall.firstDeaths;
  const entry = fe > 0 ? clamp((overall.firstKills / fe) * 100) : 50;
  const aggression = clamp((overall.acs / 300) * 100);
  const aim = clamp((overall.hs / 35) * 100);
  const survival = clamp((overall.kd / 1.5) * 100);
  const utility = overall.kills > 0 ? clamp((overall.assists / overall.kills) * 100) : 50;
  const acsVals = matches.map((m) => m.acs);
  const mean = acsVals.reduce((a, b) => a + b, 0) / acsVals.length;
  const variance = acsVals.reduce((s, v) => s + (v - mean) ** 2, 0) / acsVals.length;
  const consistency = mean > 0 ? clamp(100 - (Math.sqrt(variance) / mean) * 100) : 50;
  return { entry, aggression, aim, survival, utility, clutch: 50, trading: 50, consistency, teamImpact: clamp(aggression * 0.5 + utility * 0.5) };
}

function classifyPlaystyle(idx) {
  const candidates = [
    { label: "AGGRESSIVE ENTRY", score: idx.entry * 0.6 + idx.aggression * 0.4, rationale: "Alta taxa de entry kills combinada com um ACS elevado nos confrontos iniciais." },
    { label: "DUELIST CARRY", score: idx.aim * 0.5 + idx.aggression * 0.3 + idx.clutch * 0.2, rationale: "Mira consistente e impacto elevado no início das partidas." },
    { label: "TACTICAL CONTROLLER", score: idx.utility * 0.6 + idx.consistency * 0.4, rationale: "Uso elevado de utilidade combinado com desempenho estável." },
    { label: "CONSISTENT FLEX", score: idx.consistency * 0.7 + (100 - Math.abs(idx.entry - 50)) * 0.3, rationale: "Baixa variação de desempenho entre partidas." },
    { label: "UTILITY SPECIALIST", score: idx.utility * 0.7 + idx.trading * 0.3, rationale: "Forte contribuição em assistências." },
  ];
  return candidates.sort((a, b) => b.score - a.score)[0];
}

async function callClaude(apiKey, payload) {
  const system = `Você é um analista de dados de VALORANT. Receba SOMENTE métricas já calculadas.
NUNCA invente números. Se a amostra for pequena (menos de 5 partidas), diga isso.
Responda APENAS com JSON válido, sem markdown, no formato:
{"player_summary":string,"playstyle":{"label":string,"rationale":string},"strengths":string[],"weaknesses":string[],"recent_trends":string,"confidence":"low"|"medium"|"high","data_limitations":string[]}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 800,
      system,
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${res.status} ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const textBlock = data.content?.find((b) => b.type === "text");
  if (!textBlock) throw new Error("Resposta sem texto.");
  const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}
