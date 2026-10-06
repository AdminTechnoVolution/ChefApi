# Chef proxy

A thin backend between the Chef Android app and the LLM. The app never holds an LLM API key: it sends
the pantry here, the proxy validates it, asks the model (through **OpenRouter** by default) for a recipe whose
shape is **enforced by a strict JSON schema**, double-checks the recipe really uses only pantry ingredients
(and no more of them than the user has), and returns minified JSON. A second endpoint reads receipt and packaging
photos with a vision model for the app's "Instant Scan", a third completes the name of a food while the user types it, and a fourth turns what the user dictated into a list of items.
The app holds **no data about foods or recipes**: names, emoji, shelf lives, storage tips and recipes all come from here.

- **Stack:** Node ≥ 22 · TypeScript · Fastify 5 · Zod · OpenRouter over plain `fetch`
- **Endpoints:** `POST /v1/recipes/generate`, `POST /v1/ingredients/scan`, `POST /v1/ingredients/suggest`, `POST /v1/ingredients/extract` (+ `GET /healthz`)

## Quick start

```bash
cd backend
npm ci
cp .env.example .env            # then edit; see below

# Needs OPENROUTER_API_KEY in .env (or exported in your shell); `npm run dev` loads .env
npm run dev
```

```bash
npm run typecheck && npm test   # 443 tests, no network or API key needed
npm run build && npm start      # compiled server (node dist/server.js)
```

Try it (the fixtures in `test/fixtures` are the example payloads the tests use):

```bash
curl -s -X POST localhost:8080/v1/recipes/generate \
  -H 'content-type: application/json' -H 'x-chef-app-key: dev-local-key' \
  -d @test/fixtures/recipe-request.example.json

curl -s -X POST localhost:8080/v1/ingredients/scan \
  -H 'content-type: application/json' -H 'x-chef-app-key: dev-local-key' \
  -d @test/fixtures/scan-request.example.json   # a fake photo: valid for the contract, not for a real model

curl -s -X POST localhost:8080/v1/ingredients/suggest \
  -H 'content-type: application/json' -H 'x-chef-app-key: dev-local-key' \
  -d @test/fixtures/suggest-request.example.json

curl -s -X POST localhost:8080/v1/ingredients/extract \
  -H 'content-type: application/json' -H 'x-chef-app-key: dev-local-key' \
  -d @test/fixtures/extract-request.example.json
```

### Pointing the Android app at it

| Where the app runs | `chef.api.baseUrl` in the repo-root `local.properties` |
|---|---|
| Emulator | `http://10.0.2.2:8080/` (the debug build's default) |
| Physical device over USB | `http://localhost:8080/` after `adb reverse tcp:8080 tcp:8080` |
| Release | the proxy's public `https://…` URL (required: release builds refuse to build without it) |

`chef.api.appKey` in `local.properties` must equal `CHEF_APP_KEY` here (debug default: `dev-local-key`).

## API contract

Both endpoints need the header `X-Chef-App-Key: <shared key>`.

### `POST /v1/recipes/generate`

```jsonc
{
  "systemPrompt": "…",            // from the app's PromptBuilder; max 4000 chars; treated as untrusted guidance
  "language": "es",               // optional: en | es | pt | it | fr | de (default en). The recipe is written in it.
  "region": "CO",                 // optional: where the user lives (ISO 3166-1 alpha-2, or a UN M.49 region such as 419). The recipe fits that country.
  "ingredients": [                // 1–50 items
    {
      "name": "Milk",             // 1–60 chars
      "quantity": 1,              // > 0, ≤ 100000
      "unit": "LITERS",           // GRAMS | KILOGRAMS | MILLILITERS | LITERS | UNITS
      "category": "DAIRY",        // DAIRY | MEAT_POULTRY | VEGETABLES | FRUITS | PANTRY_STAPLES | BAKERY | SEAFOOD | OTHER
      "expirationTimestamp": 1790000000000   // epoch milliseconds
    }
  ]
}
```

`200` returns **minified** JSON (required fields must be present; this is what the app's DTO deserializes strictly):

```jsonc
{"title":"…","description":"…","prepTimeMinutes":5,"cookTimeMinutes":10,
 "difficulty":"EASY",                     // EASY | MEDIUM | HARD
 "servings":2,"emoji":"🍳",                // one emoji that pictures the dish ("" when none fits)
 "highlight":"High Protein",              // highlight is optional (null when nothing fits)
 "ingredientsUsed":[                      // each must be a pantry ingredient or salt/pepper/water/cooking oil
   {"name":"Eggs","amount":"4 units","quantity":4,"unit":"UNITS"},
   {"name":"Cooking oil","amount":"1 tbsp","quantity":null,"unit":null}   // essentials carry no quantity
 ],
 "instructions":[{"title":"Prep","description":"…","durationMinutes":3,"tip":null}],
 "nutritionalSummary":{"calories":320,"proteinGrams":21.5,"carbsGrams":8,"fatGrams":22}}   // per serving
```

`language` decides the language of everything the user reads: title, description, highlight, step titles and descriptions, tips, and the wording
of each ingredient's `amount`. Keys and enum values (`difficulty`, `unit`) never change, and pantry ingredient names are copied exactly as sent, whatever
language they are in. An unsupported value is a `400`; omitting it means English, so older app versions keep working.

`region` makes the recipe regional: a dish typical of that country, written in the local variety of the language, with local ingredient words, measures
(metric or cups and spoons) and temperature scale in the steps. It must be an upper-case code (`CO`, `419`), otherwise `400`; a code that is not a place
(`ZZ`, `EU`) is accepted and ignored. Omitting it means no regional tailoring. It never adds an ingredient that is not in the pantry, and the `amount`
of a pantry ingredient stays in the pantry's unit. The country name comes from the runtime's CLDR data (`Intl.DisplayNames`), so there is no table to maintain.
The code goes to the model inside the prompt and is neither stored nor logged.

`quantity`/`unit` on an ingredient let the app take the amount out of the pantry when the user marks it used; the proxy
rejects (and re-asks for) a recipe that uses more of something than the pantry holds, comparing across compatible
units (500 g vs 0.6 kg).

### `POST /v1/ingredients/scan`

```jsonc
{
  "image": "/9j/4AAQ…",           // base64 of a JPEG, PNG or WebP, no "data:" prefix; up to ~1 MB decoded
  "mimeType": "image/jpeg",       // must match the actual bytes (checked by magic number), or 400
  "today": "2026-10-05",          // the user's local date, YYYY-MM-DD
  "language": "es",               // optional: en | es | pt | it | fr | de (default en). Item names come back in it.
  "region": "MX"                  // optional: where the user lives. Item names use that country's everyday words.
}
```

`200`: `{"ingredients":[{"name":"Whole Milk","emoji":"🥛","quantity":1,"unit":"LITERS","category":"DAIRY","storage":"FRIDGE","expiresOn":"2026-10-12","shelfLifeDays":7}]}`
with at most 20 items (empty when the photo shows no food). `storage` is `FRIDGE | FREEZER | PANTRY`. `expiresOn` is a date
that is printed on the package, clearly legible and not in the past, otherwise `null`; `shelfLifeDays` is the typical shelf life
the app uses when there is no printed date. Items are cleaned item by item (bad entries dropped, numbers clamped, duplicates merged),
so one odd line never costs the rest. The body limit for this route is about 1.6 MB (everything else stays at 16 KB) and its
rate limit is tighter (`SCAN_RATE_LIMIT_MAX`). Item names are written in `language` and with the everyday words of `region` (names printed in another language are translated). The photo is never stored and never logged; logs carry sizes and counts only.

### `POST /v1/ingredients/suggest`

The Smart Suggester behind the app's name field: the user's partial text in, a few foods out.

```jsonc
{
  "query": "avo",                 // 1–60 chars: what has been typed so far (a partial word is fine). Data, never instructions.
  "language": "es",               // optional: en | es | pt | it | fr | de (default en). Names and tips come back in it.
  "region": "CO"                  // optional: where the user lives. Names use that country's everyday words.
}
```

`200`: `{"suggestions":[{"name":"Aguacate","emoji":"🥑","category":"FRUITS","unit":"UNITS","storage":"FRIDGE","shelfLifeDays":4,"tip":"…"}]}`
with at most 5 entries, most likely first, and an empty list when the text is not (and could not become) a food. `emoji` is one emoji
(or `""`: anything else the model writes there is cut down to its first emoji); `shelfLifeDays` is the typical shelf life in the stated
`storage` (1–3650), which the app turns into the suggested expiry date; `tip` is one practical storage tip, at most 200 characters.
Entries are cleaned one by one (bad ones dropped, numbers clamped, duplicates merged), so one odd suggestion never costs the rest.
Answers are cached in memory for 24 h per text, language and country (up to 2000 entries; only successes), so typing the same food
again costs no model call. The route has its own rate limit (`SUGGEST_RATE_LIMIT_MAX`) and a short model timeout
(`OPENROUTER_SUGGEST_TIMEOUT_MS`) because a person is waiting on a text field. Typed text is never logged: logs carry counts and latency.

### `POST /v1/ingredients/extract`

The voice entry: the phone's speech recognizer writes down what the user said, and this turns the words into pantry items, one per food, each
with its own details, for the user to check and save. **No audio ever reaches this API.**

```jsonc
{
  "transcript": "tengo tres tomates, un litro de leche que vence el viernes y medio kilo de arroz",   // 1–1500 chars; data, never instructions
  "today": "2026-10-05",          // the user's local date, YYYY-MM-DD: "on Friday" is worked out from it (the weekday is given to the model)
  "language": "es",               // optional: en | es | pt | it | fr | de (default en). Names come back in it.
  "region": "CO"                  // optional: where the user lives. Names use that country's everyday words.
}
```

`200`: `{"ingredients":[{"name":"Leche","emoji":"🥛","quantity":1,"unit":"LITERS","category":"DAIRY","storage":"FRIDGE","expiresOn":"2026-10-09","shelfLifeDays":7,"heard":"un litro de leche que vence el viernes"}]}`
with at most 20 entries, in the order they were said, and an empty list when no food was named. It is the scan shape plus `heard`, the words that
described the item (up to 120 characters), which the app shows back so the user can check what was understood. Spoken numbers and fractions become
numbers ("half a dozen" is 6 UNITS, "a quarter of a kilo" is 250 GRAMS) and a self-correction wins ("no, make it four"). `expiresOn` is only filled
with a date the user said that is today or later; otherwise `shelfLifeDays` gives the typical shelf life. Obvious recognition mistakes are fixed when the
context makes the food clear, and nothing that was not named is added. Entries are cleaned one by one (bad ones dropped, numbers clamped, dates checked,
duplicates merged), so one odd entry never costs the rest. Temperature 0, so the same words give the same list. The route keeps the small body limit,
has its own rate limit (`EXTRACT_RATE_LIMIT_MAX`) and a model timeout (`OPENROUTER_EXTRACT_TIMEOUT_MS`). What the user said is never logged: logs carry
the length of the text, the number of items, latency and token counts.

### Errors

Every non-2xx response has the same envelope: `{"error":{"code":"…","message":"…"}}`.

| HTTP | `error.code` | Meaning | What the app shows |
|---|---|---|---|
| 400 | `invalid_request` | Schema violation, malformed JSON, or an image that is not the declared type (values are never echoed back) | generic error |
| 401 | `unauthorized` | Missing/wrong `X-Chef-App-Key` | "update the app" |
| 413 | `payload_too_large` | Body over the route's limit (16 KB; about 1.6 MB for a scan) | generic error |
| 422 | `recipe_refused` / `recipe_constraint_violation` | The model declined, or could not stay within the pantry after a retry | "couldn't come up with a recipe, try again" |
| 429 | `rate_limited` | Per-client throttle, or the upstream is busy | "too many requests" |
| 502 | `upstream_error` | The LLM call failed or returned something unusable | "kitchen is having trouble" |
| 504 | `upstream_timeout` | Time budget exhausted | "taking too long" |
| 500 | `internal_error` | Bug (details are logged, never returned) | generic error |

The schemas live in `src/schema.ts` (single source of truth); the OpenAPI document is generated from them, so the docs
cannot drift from what the API validates. The example payloads in `test/fixtures` are loaded by these tests.
See [API docs (Swagger)](#api-docs-swagger).

## How a request is handled

1. **Throttle** (per client IP) → **authenticate** (constant-time key compare) → **validate** (Zod). Throttling runs *before* authentication so key-guessing is rate-limited too.
2. **Generate.** The model is called through OpenRouter with `response_format: json_schema` (`strict: true`) set to the recipe schema, and the result is re-validated strictly with Zod. See [LLM provider](#llm-provider).
3. **Prompt hygiene.** The server's own rules are the first system block. The app's `systemPrompt` is appended as clearly delimited, *lower-priority* guidance, and the pantry is re-rendered from the validated list (single-line, length-capped names), so a modified client cannot use this proxy as a free general-purpose LLM or smuggle instructions in through an ingredient name.
4. **Ingredients-only check.** Every `ingredientsUsed` entry must be a pantry ingredient (tolerating case, accents, plurals, "whole milk" for "milk") or salt/pepper/water/cooking oil, which are accepted in each of the six languages (`src/llm/essentials.ts`; "sal y pimienta" and "Salz und Pfeffer" are judged part by part). On a violation the model is asked once more, naming the offenders; if it still fails, the request ends with `422 recipe_constraint_violation`. A non-compliant recipe is never returned.
5. **Deadline.** The whole request has a 75 s budget (`REQUEST_DEADLINE_MS`), below the app's 90 s call timeout. A retry only starts if ≥ 20 s remain. Upstream work is cancelled if the client disconnects.

A scan takes the same first steps (throttle with its own limit → authenticate → validate), then checks the image's magic bytes against the
declared `mimeType`, sends the photo to the vision model with the same strict-schema call and **without** response healing, and normalizes the answer.

## API docs (Swagger)

| URL | What |
|---|---|
| `/docs` | Swagger UI: schemas, a realistic example for the request and for every response, and **Try it out** |
| `/docs-json`, `/openapi.json` | The OpenAPI 3.0 document (same URLs as AntySpendApi) |

Controlled by `ENABLE_SWAGGER`: leave it unset for **on outside production and off in production**, or set `1`/`0` to force
it either way. When off, the routes return the normal `404` envelope and the swagger plugins are not even loaded.
**If `/docs` returns `{"error":{"code":"not_found",...}}`, check `NODE_ENV`:** `NODE_ENV=production` in your `.env` turns the docs
off unless you also set `ENABLE_SWAGGER=1`. The server logs which case applies at startup (`API docs are on` / `API docs are off ...`). The docs
need no key and are not rate limited (so loading the UI cannot trip the limit); your calls from **Try it out** are.

To call the API from the UI click **Authorize** and paste the shared key (the server's `CHEF_APP_KEY`); it is remembered in
the browser tab. **Try it out calls the real LLM and costs money.**

## LLM provider

Recipes come from **OpenRouter**, called the same way AntySpendApi calls it
(`POST /chat/completions`, strict `json_schema`, `provider.require_parameters`, `data_collection: deny`, `zdr`,
`response-healing`), implemented with plain `fetch` instead of axios/Nest.

| What | Value | Why |
|---|---|---|
| Default model | `google/gemini-2.5-flash-lite` | Same default as AntySpendApi: cheap and fast. OpenRouter lists it with `structured_outputs` support. If recipe quality disappoints, try `google/gemini-2.5-flash` (set `OPENROUTER_MODEL`). |
| `temperature` | `0.7` (AntySpendApi uses `0`) | Extraction wants determinism; here "get another recipe" must not return the same recipe again. |
| `max_tokens` | `3000` | A recipe is ~700 tokens; the rest is headroom for models that reason first. You pay only for tokens used. A truncated answer is reported, never parsed. |
| `zdr` + `data_collection: deny` | on | Only Zero-Data-Retention endpoints that honour every parameter. If you switch to a model with no ZDR endpoint OpenRouter answers `404`; set `OPENROUTER_ZDR=0` or pick another model. The error is logged with the provider's message. |
| Schema | derived from the Zod schema, sanitized | No `$schema` and no numeric bounds (Zod adds ±2⁵³ to every `.int()`), closed objects, every property required: AntySpendApi found Gemini rejects over-constrained schemas. The strict Zod schema is applied to the result anyway. |

**Instant Scan** uses a second model, `OPENROUTER_VISION_MODEL` (default `google/gemini-2.5-flash`, the model AntySpendApi uses for
receipts; it must accept images and structured outputs). It runs at `temperature` 0 (extraction wants determinism), with a 30 s
per-call timeout and its own token cap, and goes through the same ZDR routing and error mapping as recipes.

Provider errors map to Chef's envelope: `429` → `429 rate_limited`; `408`/`504`/timeouts → `504 upstream_timeout`;
`401` (our key is wrong), `402` (out of credits), `400/403/404` (schema or routing rejected) and `5xx` → `502 upstream_error`
(shown to users as a generic outage). Operator-actionable ones are logged at `error` level with the provider's message
(truncated); the API key and pantry contents are never logged. Errors OpenRouter embeds inside an HTTP 200 are handled too.

Any OpenRouter model with structured-output support works, Claude included: set `OPENROUTER_MODEL` (for example
`anthropic/claude-sonnet-5.5`). Check the model's `supported_parameters` on `https://openrouter.ai/api/v1/models`
for `structured_outputs`, and keep the ZDR note above in mind.

## Configuration

All via environment variables, validated at startup (`src/config.ts`); see `.env.example` for the full list.
The server refuses to start (exit code 1, readable message) on an invalid value, on a missing `OPENROUTER_API_KEY`,
and in production on a default/short `CHEF_APP_KEY` or a non-https OpenRouter URL.

| Variable | Default | Notes |
|---|---|---|
| `CHEF_APP_KEY` | `dev-local-key` | In production: non-default, ≥ 24 chars. Must equal the app's `chef.api.appKey`. |
| `OPENROUTER_API_KEY` | – | Required. Never logged. |
| `OPENROUTER_MODEL` | `google/gemini-2.5-flash-lite` | Any OpenRouter model id that supports structured outputs. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | https required in production. |
| `OPENROUTER_MAX_TOKENS` | `3000` | 300–16000. |
| `OPENROUTER_VISION_MODEL` | `google/gemini-2.5-flash` | Model for photo scans: needs image input and structured outputs. |
| `OPENROUTER_VISION_MAX_TOKENS` / `OPENROUTER_VISION_TIMEOUT_MS` | `2000` / `30000` | Per scan call (timeout 5000–80000). |
| `OPENROUTER_SUGGEST_MAX_TOKENS` / `OPENROUTER_SUGGEST_TIMEOUT_MS` | `900` / `10000` | Per suggestion call (uses `OPENROUTER_MODEL`; timeout 2000–30000). |
| `OPENROUTER_EXTRACT_MAX_TOKENS` / `OPENROUTER_EXTRACT_TIMEOUT_MS` | `2000` / `20000` | Per dictation call (uses `OPENROUTER_MODEL`; timeout 5000–60000). |
| `OPENROUTER_TEMPERATURE` | `0.7` | 0–2. Recipes only; scans, suggestions and dictation always use 0. |
| `OPENROUTER_ZDR` | `1` | Zero-Data-Retention routing. |
| `TRUST_PROXY` | `0` | Set `1` behind any reverse proxy, otherwise all users share one rate-limit bucket. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `20` / `60000` | Per client IP, in memory (per process; it does not sync across instances). |
| `SCAN_RATE_LIMIT_MAX` | `6` | Scans per window per client: the expensive call, so tighter than the rest. |
| `EXTRACT_RATE_LIMIT_MAX` | `10` | Dictations per window per client: one model call each, nothing to cache. |
| `SUGGEST_RATE_LIMIT_MAX` | `40` | Suggestions per window per client: they fire as the user types (after a pause) and are cached, so this is generous. |
| `REQUEST_DEADLINE_MS` / `UPSTREAM_TIMEOUT_MS` | `75000` / `40000` | Whole request / each model call. The deadline must stay below the app's 90 s call timeout. |
| `ENABLE_SWAGGER` | unset | See [API docs](#api-docs-swagger): unset = on outside production, off in production. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |

## Operational notes

- **Health:** `GET /healthz` returns `200 {"status":"ok"}`, unauthenticated and not rate limited.
- **Logs:** structured JSON on stdout (request id, status, latency, provider, model, token usage). Startup failures are printed to stderr as `Chef proxy failed to start: …`.
- **Behind a proxy:** set `TRUST_PROXY=1`. Some proxies append the client's *source port* to `X-Forwarded-For`
  (`203.0.113.7:51234`); the rate limiter strips it (`src/clientIp.ts`). Without that, every new connection would get a fresh
  key and the per-client limit would never trigger.
- **Graceful shutdown:** `SIGTERM`/`SIGINT` finish in-flight requests before exiting.
- Hosting and deployment configuration are intentionally not covered here.

## Security notes

- The shared `CHEF_APP_KEY` ships inside the APK, so anyone who unpacks it can extract it. It is a speed bump against
  casual abuse, **not real authentication**. Rate limits cap the damage, but before a public release replace it with
  Firebase App Check (Play Integrity): implement the existing `ClientVerifier` interface (`src/auth/clientVerifier.ts`),
  no route changes needed, and use the verified token's subject as the rate-limit key.
- Set a spend limit/alert on the OpenRouter key you give this service (OpenRouter supports per-key credit limits).
- Dependencies are pinned by `package-lock.json`; run `npm audit` and keep the SDK current.
