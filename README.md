# headless-duckapi

**An OpenAI-compatible API on DuckDuckGo's free duck.ai models.
Streaming answers · GPT / Claude / Mistral · image generation · photo vision · no API keys**

headless-duckapi turns [duck.ai](https://duck.ai) (the chat DuckDuckGo ships for free — no API key, no account) into a standard `POST /v1/chat/completions` endpoint. It includes a **pure-JavaScript implementation of the duck.ai protocol** — including the antibot challenge solver that runs the obfuscated JS in a hand-built browser mock. Zero npm dependencies, no browser, nothing to pay for.

## What you get

| | |
|---|---|
| 💬 **Streaming chat** | SSE chunks in the OpenAI format (`stream: true`), plus non-stream mode |
| 🤖 **Models** | GPT-5.4 mini, GPT-6 Luna, Claude Haiku 4.5, Mistral Small, GPT-OSS 120B, Gemma 4… — the list is fetched live from duck.ai with a static fallback |
| 🎨 **`image: true`** | duck.ai's GenerateImage tool — the response carries `message.images: ["data:image/…;base64,…"]` (known to work with the GPT models) |
| 📸 **Photo vision** | `image_url` parts (data: or http(s) URLs; JPEG is re-encoded to PNG in pure JS — duck.ai rejects JPEG parts) |
| 🌐 **Web search** | `web_search: true` — duck.ai's WebSearch tool |
| 🧠 **Reasoning effort** | `reasoning_effort: "none" / "low" / "medium"` (validated per model) |
| 🦆 **Antibot-hardened** | Challenge tokens and frontend versions are cached in process memory to stay far away from duck.ai's 418/429 |

## Quick start (native)

Node.js **≥ 22.5** (24 recommended):

```bash
git clone https://github.com/<your-username>/headless-duckapi.git && cd headless-duckapi
npm install          # installs zero dependencies — keeps the lockfile in sync
node api.js          # or: PORT=8080 API_KEY=secret node api.js
node api.js models   # print the live model list and exit
```

## Quick start (Faable)

The repo ships a [faable.json](faable.json) (start command `node api.js`), so it is deploy-ready as-is — it builds with Faable's free Node.js buildpack:

```bash
npm i -g @faable/faable && faable login && faable deploy
faable deploy secrets set API_KEY=your-secret
```

Faable notes:

- set `STRICT_MODELS=1` as an environment variable to keep model ids aligned with the live upstream list (see [Model resolution](#model-resolution));
- use `stream: true` — Faable's limit is 60 s of time-to-first-byte; a stream's headers go out before the model is called, while a non-stream answer that takes longer 504s;
- on the Free plan the app sleeps after 30 min idle, so the first request after a sleep re-solves the duck.ai challenge (a second or two of extra latency);
- Free includes 10 GB of egress per month — image-generation answers are base64 data URLs (a few MB each).

## Endpoints

`baseURL = http://localhost:8080/v1`

| Endpoint | Description |
|---|---|
| `GET /v1/models` | Live model list from duck.ai (static fallback if duck.ai is unreachable) |
| `POST /v1/chat/completions` | Chat completion, `stream: true/false` — SSE chunks in the OpenAI format |
| `GET /health` | Liveness probe |

Try it:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.4-mini","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

### Model resolution

By default the API is lenient about model ids, so OpenAI clients keep working:

- stale model ids (`gpt-4o-mini`, `claude-3-haiku`, …) resolve to the closest current duck.ai model — `GET /v1/models` is the source of truth;
- when duck.ai rejects a model with `ERR_MODEL_RESTRICTED` / `ERR_MODEL_UNAVAILABLE` (its list advertises flagships the free tier can't use), the same request is retried on the next model of the same family, in preferred order.

Set **`STRICT_MODELS=1`** (environment or `.env`) to align the API with the upstream exactly:

- only an exact model id from the live duck.ai list resolves (case-insensitive); anything else → `404 model_not_found` with the available list;
- a restricted/unavailable model errors out instead of silently switching to another model of the same family.

Recommended for public deployments.

### OpenAI client compatibility

- `content` may be a string or an array of parts: `{type:"text"}` and `{type:"image_url"}` (data: or http(s) URLs; JPEG is re-encoded to PNG in pure JS — duck.ai rejects JPEG parts);
- `role: "developer"` maps to `system`;
- `temperature`, `max_tokens` and friends are accepted and ignored — duck.ai has no such knobs;
- any `apiKey` is accepted unless `API_KEY` is set.

Extensions beyond the OpenAI schema, all optional:

| Field | Meaning |
|---|---|
| `reasoning_effort: "none" / "low" / "medium"` | duck.ai reasoning effort (validated against the model, so you get a 400 instead of a duck.ai 400) |
| `web_search: true` | duck.ai WebSearch tool |
| `image: true` | duck.ai GenerateImage tool — the response carries `message.images: ["data:image/…;base64,…"]` |

Set `API_KEY` (in `.env` or the environment) to require `Authorization: Bearer <API_KEY>`; leave it empty only on a trusted network.

## How the duck.ai protocol works

The fun part — [lib/duckai.js](lib/duckai.js), dependency-free JavaScript that reimplements duck.ai's client:

1. `GET /duckchat/v1/status` returns `x-vqd-hash-1`: a base64-encoded **JS challenge**.
2. The challenge is obfuscated JavaScript that fingerprints the browser (DOM parsing, `NodeList`, `window` semantics, timing). It is solved inside a **hand-built browser mock** (`buildBrowserMock`): an HTML5 fragment parser, real tree-walking `querySelector`, a `NodeList` class, `[object Window]` via `Symbol.toStringTag` — verified against four captured challenge flavors. The solved proof is SHA-256-hashed client-side and merged into the expected metadata shape.
3. `GET https://duck.ai/` gives the frontend version (`x-fe-version`), also cached.
4. `POST /duckchat/v1/chat` with the solved token streams the answer as SSE. Tools (web search, image generation) ride on the same stream.

Solved tokens and frontend versions are held in process memory (nothing is persisted), so restarts re-solve the challenge once — that keeps the server clear of 418s/429s. Protocol originally ported from [aurora-develop/Duck2api](https://github.com/aurora-develop/Duck2api) (Go), then hardened and extended.

## Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| `429` from this API | duck.ai is rate-limiting this IP. Wait a moment and retry; the token is refreshed automatically. |
| `502 duck.ai upstream error` | duck.ai rejected the request (see the message). Restricted models only happen without `STRICT_MODELS` on flagships the free tier can't use. |
| `404 model not found` (with `STRICT_MODELS=1`) | The id is not in the live duck.ai list — `GET /v1/models` is the source of truth. |
| `headless-duckapi needs SQLite…` | You are running an older build; this API needs no SQLite at all. Upgrade. |

## Credits & license

- Protocol basis: [aurora-develop/Duck2api](https://github.com/aurora-develop/Duck2api)
- Pure-JS challenge solver, streaming, image generation, OpenAI-compatible layer
- MIT — see [LICENSE](LICENSE)
