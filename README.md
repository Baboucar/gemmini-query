# GemMini Query

Natural-language → Postgres SQL → Supabase → JSON/CSV

Live demo: <https://gemmini-query.netlify.app/>

---

## How it works

| Step | Service | File |
|------|---------|------|
| 1. NL prompt → SQL | Google Gemini 1.5 Flash (fallback to 1.5-Flash-8B) | [`src/worker.js`](./src/worker.js) |
| 2. Execute SQL     | Supabase Edge Function (`/functions/v1/sql`) | same |
| 3. Return rows     | Cloudflare Worker responds with `{ sql, rows }` | same |
| 4. Display UI      | Vite + Solarite (reactive) + **Eternium** CSS | [`src/main.js`](./src/main.js) |

---

## Local dev

```bash
# UI
npm install
npm run dev          # http://localhost:5173

# Worker (needs wrangler)
cp wrangler.toml.example wrangler.toml     # fill in your env vars
wrangler dev src/worker.js                 # http://localhost:8787
