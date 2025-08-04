// src/worker.js — GemMini SQL proxy (Gemini → Supabase)
// ---------------------------------------------------------------------------
// • Tries **gemini‑1.5‑flash** first, then falls back to **gemini‑1.5‑flash‑8b**
//   when the free‑tier quota is hit.
// • Expands fuzzy dates, makes country checks case‑insensitive, and automatically
//   appends `LIMIT 200` unless the user explicitly wants “all rows” or supplies
//   their own LIMIT.
// • Rejects non‑SELECT SQL and overly‑long prompts (> 160 chars) to stretch your
//   quota dollars.
// • Returns JSON { sql, rows } with permissive CORS so the Netlify front‑end
//   works without extra config.
// ---------------------------------------------------------------------------

export default {
  async fetch (req, env) {
    /* ── CORS helpers ─────────────────────────────────────────────── */
    const CORS = {
      'Access-Control-Allow-Origin' : '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey'
    };

    if (req.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST')
      return new Response('POST only', { status: 405, headers: CORS });

    /* ── read JSON body ──────────────────────────────────────────── */
    let prompt = '';
    try {
      ({ prompt } = await req.json());
      prompt = prompt?.trim();
    } catch {
      return new Response('Bad JSON body', { status: 400, headers: CORS });
    }
    if (!prompt)
      return new Response('Missing prompt', { status: 400, headers: CORS });

    // protect the wallet: bail if prompt too long (unless user overrides)
    if (prompt.length > 160 && !/all\s+rows|limit\s+\d+/i.test(prompt))
      return new Response('Prompt too long (> 160 chars)', { status: 400, headers: CORS });

    /* ── 1 · Gemini → SQL (with 8‑B fallback) ───────────────────── */
    let sql;
    try {
      sql = await callGemini(prompt, env);
    } catch (err) {
      return new Response(err.message, { status: 502, headers: CORS });
    }

    if (!sql.toLowerCase().startsWith('select'))
      return new Response('Only SELECT queries allowed', { status: 400, headers: CORS });

    /* ── 2 · execute via Supabase Edge Function ─────────────────── */
    const dbRes = await fetch(env.SUPABASE_FN, {
      method : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey'      : env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`
      },
      body   : JSON.stringify({ query: sql })
    });

    const dbJson = await dbRes.json();
    if (!dbRes.ok)
      return new Response(JSON.stringify(dbJson), {
        status : dbRes.status,
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });

    /* ── 3 · success ─────────────────────────────────────────────── */
    return new Response(JSON.stringify({ sql, rows: dbJson }), {
      status : 200,
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }
};

/* ───────────────────────────── helpers ───────────────────────────── */

async function callGemini (userPrompt, env) {
  const MODELS = ['gemini-1.5-flash', 'gemini-1.5-flash-8b'];

  for (const model of MODELS) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${env.GEMINI_KEY}`,
      {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(userPrompt) }] }],
          generationConfig: { temperature: 0 }
        })
      }
    ).then(r => r.json());

    if (res.error) {
      // quota → try next model
      if (res.error.code === 429) continue;
      // hard error
      throw new Error('Gemini API error: ' + (res.error.message || 'unknown'));
    }

    /* ── harvest SQL ───────────────────────────────────────────── */
    let raw = (res.candidates?.[0]?.content?.parts?.[0]?.text || '').replace(/```/g, '').trim();

    // take first SELECT … ;
    const m = raw.match(/select[\s\S]*?(?=;|$)/i);
    if (!m) throw new Error('Gemini returned no SQL');
    let sql = m[0].trim();

    // auto‑LIMIT if needed
    if (!/\blimit\b/i.test(sql) && !/all\s+rows/i.test(userPrompt))
      sql += ' LIMIT 200';

    return sql;
  }

  throw new Error('Model quota exhausted – please retry later');
}

function buildPrompt (req) {
  return `You are an expert Postgres SQL generator.
Schema: shipments(id BIGINT, supplier TEXT, country TEXT, quantity INT, dispatched_at DATE, image_url TEXT).
Today is 2025‑08‑03.
• Convert fuzzy/relative dates ("Feb 1", "last week", "between Feb 1 and Mar 15") to explicit dates (YYYY‑MM‑DD).
• Country filters must be case‑insensitive: LOWER(country) = LOWER('us') or country ILIKE '%fr%'. Treat "US", "USA", "United States" as equal.
• Unless the user explicitly requests ALL rows or gives a LIMIT, append LIMIT 200.
• Return exactly ONE plain SELECT statement – no comments, no back‑ticks, no explanation.

User request: ${req}`;
}
