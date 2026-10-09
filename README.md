# Chef proxy

A thin backend between the Chef Android app and the LLM. The app never holds an LLM API key: it sends
the pantry here, the proxy validates it, asks the model (through **OpenRouter** by default) for a recipe whose
shape is **enforced by a strict JSON schema**, double-checks the recipe really uses only pantry ingredients
(and no more of them than the user has), and returns minified JSON. A second endpoint reads receipt and packaging
photos with a vision model for the app's "Instant Scan", a third lists the food shown in a short video of the kitchen, a fourth completes the name of a food while the user types it, and a fifth turns what the user dictated into a list of items.
The app holds **no data about foods or recipes**: names, emoji, shelf lives, storage tips and recipes all come from here.

It also owns **who is using the AI and what they may use**: people sign in with Google, buy **Chef Junior** or **Chef Master** as Google Play
subscriptions, and each plan decides which calls they may make and how much AI they get a month (see [Accounts, plans and billing](#accounts-plans-and-billing)).

- **Stack:** Node ≥ 22 · TypeScript · Fastify 5 · Zod · OpenRouter over plain `fetch` · MongoDB (database `chef`) · Redis (sessions)
- **AI endpoints:** `POST /v1/recipes/generate`, `POST /v1/ingredients/scan`, `POST /v1/ingredients/scan-video`, `POST /v1/ingredients/suggest`, `POST /v1/ingredients/extract`, `POST /v1/assistant/understand` (+ `GET /healthz`)
- **Account endpoints:** `POST /v1/auth/google`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `DELETE /v1/account`, `GET /v1/entitlements/me`, `POST /v1/entitlements/verify-purchase`, and Google's `POST /webhooks/google-play/rtdn`

## Quick start

```bash
cd ChefApi
npm ci

# Create a .env with at least OPENROUTER_API_KEY (or export it in your shell); `npm run dev` loads .env.
# Every variable is documented in "Configuration" below and has a default, so nothing else is needed to try it.
npm run dev
```

```bash
npm run typecheck && npm test   # 813 tests, no network, database or API key needed
npm run build && npm start      # compiled server (node dist/server.js)
```

Tests use in-memory stores. The same tests also run against a real MongoDB and Redis when you point them at disposable ones:
`MONGODB_URI_TEST=mongodb://localhost:27017 REDIS_URL_TEST=redis://localhost:6379 npm test` (841 tests: the stores' shared behaviour tests run against the real thing too; they use their own database name and key prefix and
clean up only what they created).

Try it (the fixtures in `test/fixtures` are the example payloads the tests use). These calls use the original shared-key mode (`AUTH_MODE=app-key`, the
default); with accounts on, send `Authorization: Bearer <access token>` instead of `x-chef-app-key` (see [Local development with accounts](#local-development-with-accounts)):

```bash
curl -s -X POST localhost:8080/v1/recipes/generate \
  -H 'content-type: application/json' -H 'x-chef-app-key: dev-local-key' \
  -d @test/fixtures/recipe-request.example.json

curl -s -X POST localhost:8080/v1/ingredients/scan \
  -H 'content-type: application/json' -H 'x-chef-app-key: dev-local-key' \
  -d @test/fixtures/scan-request.example.json   # a fake photo: valid for the contract, not for a real model

curl -s -X POST localhost:8080/v1/ingredients/scan-video \
  -H 'content-type: application/json' -H 'x-chef-app-key: dev-local-key' \
  -d @test/fixtures/scan-video-request.example.json   # two fake frames: valid for the contract, not for a real model

curl -s -X POST localhost:8080/v1/ingredients/suggest \
  -H 'content-type: application/json' -H 'x-chef-app-key: dev-local-key' \
  -d @test/fixtures/suggest-request.example.json

curl -s -X POST localhost:8080/v1/ingredients/extract \
  -H 'content-type: application/json' -H 'x-chef-app-key: dev-local-key' \
  -d @test/fixtures/extract-request.example.json
```

### Pointing the Android app at it

| Where the app runs | `CHEF_API_BASE_URL` in `ChefAndroid/local.properties` |
|---|---|
| Emulator | `http://10.0.2.2:8080/` (the debug build's default) |
| Physical device over USB | `http://localhost:8080/` after `adb reverse tcp:8080 tcp:8080` |
| Release | the proxy's public `https://…` URL, in `release.properties` (release builds refuse to build without it) |

The app no longer sends a shared key: it signs in and sends its own token. The API must run with `AUTH_MODE=jwt` for it (the original `app-key` mode
is for the tests and for trying the calls above).

## API contract

Both endpoints need the header `X-Chef-App-Key: <shared key>`.

### `POST /v1/recipes/generate`

```jsonc
{
  "systemPrompt": "…",            // from the app's PromptBuilder; max 4000 chars; treated as untrusted guidance
  "language": "es",               // optional: en | es | pt | it | fr | de (default en). The recipe is written in it.
  "region": "CO",                 // optional: where the user lives (ISO 3166-1 alpha-2, or a UN M.49 region such as 419). The recipe fits that country.
  "dish": "Mushroom risotto",     // optional, up to 80 chars: a dish the user wants. The recipe is for it and `missingIngredients` says what is left to buy.
  "diets": ["VEGAN", "GLUTEN_FREE"],  // optional: requirements the recipe must respect, all at once. See "Dishes and diets" below.
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
 "missingIngredients":[                   // what is left to buy for a requested `dish`; always [] without one
   {"name":"Fresh spinach","amount":"100 g"}
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

#### Dishes and diets

**A dish.** Without `dish` the recipe is made from the pantry alone, as always. With it, the recipe is *for that dish*: `ingredientsUsed` still holds
only pantry ingredients (and salt, pepper, water, cooking oil, in amounts the pantry holds: when it holds less than the dish normally needs the
recipe is made for fewer servings), and everything else the dish needs goes in `missingIngredients`, named in the user's language with an amount. That
is the answer to "can I make it with what I have?": an empty list means yes, anything in it is the shopping list. A dish is never refused for lacking
ingredients. The rules are checked after the model answers, and on a violation it is asked once more: something that is in the pantry (or is free, like salt) must not be
listed as missing, and what the pantry lacks must not be listed as used. Without a `dish`, a non-empty `missingIngredients`, or a recipe that uses nothing from the pantry, is a violation too.
The dish is treated as data (one line, length-capped, never obeyed as an instruction) and is **not logged**.

**Diets.** `diets` is any combination of `VEGETARIAN`, `VEGAN`, `PESCATARIAN` (eating styles: the app lets the user pick one), `GLUTEN_FREE`, `DAIRY_FREE`,
`EGG_FREE`, `NUT_FREE`, `LOW_CARB`, `KETO`, `HALAL` and `KOSHER`. Each becomes an absolute rule in the server's prompt (`src/llm/diets.ts` says what each means),
above the dish, the expiry priority and the app's text; a dish that would break one is made in the closest version that respects it, and the description says so.
For the three eating styles there is also a **hard backstop**: pantry items whose `category` the style rules out (meat and seafood for vegetarian and vegan,
dairy as well for vegan, meat for pescatarian) are removed before the model sees the pantry, so it cannot use them, and a recipe that does is rejected like any other
use of an ingredient that is not in the pantry. A category cannot settle gluten, nuts or the rest, so those rely on the model: treat them as a best effort, not a guarantee for an allergy.
If the pantry is left with nothing and no `dish` was asked for, the call ends with `422 recipe_refused` without calling the model.

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

### `POST /v1/ingredients/scan-video`

Lists the food a person shows in a **video of their kitchen of up to 20 seconds** (fridge, freezer, shelves, counter). **The video itself is
never uploaded**: the app samples up to 16 frames from it on the phone (about one every 1.25 s), shrinks each to about 260 KB, and sends only those.

```jsonc
{
  "frames": ["/9j/4AAQ…", "/9j/4AAQ…"],  // 1 to 16 frames, in order, base64 of JPEG, PNG or WebP, no "data:" prefix; ~260 KB each
  "today": "2026-10-05",                   // the user's local date, YYYY-MM-DD
  "language": "es",                        // optional: en | es | pt | it | fr | de (default en). Item names come back in it.
  "region": "CO"                           // optional: where the user lives. Item names use that country's everyday words.
}
```

`200`: the same shape as a photo scan, `{"ingredients":[{"name":"Huevos","emoji":"🥚","quantity":6,"unit":"UNITS","category":"DAIRY","storage":"FRIDGE","expiresOn":null,"shelfLifeDays":21}]}`,
with at most **25** items (empty when the video shows no food). The frames come from one video, so an item that appears in several of them is listed once;
`quantity` is a count when the pieces can be counted (six eggs), the printed amount when a package shows one, and 1 otherwise; `storage` follows where the
item is shown (inside the fridge, in a cupboard, on the counter). Each frame's type is read from its bytes (a GIF, an MP4 or plain text is `400`, naming
the frame), and the answer is cleaned item by item exactly like a photo scan. The body limit for this route is about 5.6 MB (everything else stays at 16 KB).
It has its own per-client counter with the same limit as the photo scan (`SCAN_RATE_LIMIT_MAX`). Frames are never stored and never logged; logs carry
frame counts, sizes, item counts and token usage only.

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

### `POST /v1/assistant/understand`

The mascot: the user speaks to the floating chef, the phone's speech recognizer writes it down, and this works out **what they want done** in one model
call. **No audio ever reaches this API, and the pantry is never sent.** Requires **Chef Master** (the `assistant` feature) and spends one unit a call.

The request is the same as the dictation one (`transcript`, `today`, `language`, `region`). `200` always has the same four fields:

```jsonc
{
  "intent": "add_ingredients",   // add_ingredients | make_recipe | unknown
  "reply": "¡Listo! Revisa estos 2 ingredientes antes de guardarlos.",   // one short sentence for the mascot, in `language`; may be ""
  "ingredients": [ /* the dictation entries (with `heard`): only for add_ingredients, otherwise [] */ ],
  "recipe": { "dish": null, "ingredientNames": ["Pollo", "Arroz"], "wholePantry": false }   // only for make_recipe, otherwise null
}
```

`make_recipe` says the `dish` asked for (or null), the foods to cook **with** (`ingredientNames`) and `wholePantry` when the user named neither ("what can I
cook?"). Matching those names against what is in the pantry happens on the phone. The answer is made consistent whatever the model returned: the intent decides
which part is kept and the other emptied; an `add_ingredients` that ended up with nothing usable becomes `unknown` with an empty reply (the app says its own);
`wholePantry` follows from the dish and the names, not from the model's flag; names are cleaned, deduplicated and capped; texts are one line and bounded.
The reply never claims the work is done: the app asks the user before anything is saved. The model schema is flat on purpose (unions are poorly supported by
structured-output decoders). Temperature 0, the dictation limits and timeout (`EXTRACT_RATE_LIMIT_MAX`, `OPENROUTER_EXTRACT_TIMEOUT_MS`), and what the user said is never logged.

### Errors

Every non-2xx response has the same envelope: `{"error":{"code":"…","message":"…"}}`, plus `details` (a flat object of strings, numbers and booleans) on the few errors that carry facts the app needs.

| HTTP | `error.code` | Meaning | What the app shows |
|---|---|---|---|
| 400 | `invalid_request` | Schema violation, malformed JSON, or an image that is not the declared type (values are never echoed back) | generic error |
| 401 | `unauthorized` | No session, an expired or revoked access token, or (shared-key mode) a wrong `X-Chef-App-Key` | the app renews the session; if it cannot, "sign in again" |
| 403 | `plan_required` | The user's plan does not include this. `details`: `feature`, `plan`, `requiredPlan` | opens the plans, saying which plan has it |
| 403 | `ai_quota_exceeded` | The plan includes it but this month's allowance is used up. `details`: `feature`, `plan`, `used`, `limit`, `resetsAtMillis` | opens the plans with "used 5 of 5, starts over on …" |
| 409 | `conflict` | A purchase token that already belongs to another account | "that subscription belongs to another account" |
| 413 | `payload_too_large` | Body over the route's limit (16 KB; about 1.6 MB for a photo scan, 5.6 MB for a video scan) | generic error |
| 422 | `recipe_refused` / `recipe_constraint_violation` | The model declined, could not stay within the pantry after a retry, or none of the pantry fits the requested diet | "couldn't come up with a recipe, try again" |
| 429 | `rate_limited` | Per-client throttle, or the upstream is busy | "too many requests" |
| 502 | `upstream_error` | The LLM call failed or returned something unusable | "kitchen is having trouble" |
| 504 | `upstream_timeout` | Time budget exhausted | "taking too long" |
| 500 | `internal_error` | Bug (details are logged, never returned) | generic error |

The schemas live in `src/schema.ts` (single source of truth); the OpenAPI document is generated from them, so the docs
cannot drift from what the API validates. The example payloads in `test/fixtures` are loaded by these tests.
See [API docs (Swagger)](#api-docs-swagger).

## How a request is handled

1. **Throttle** (per client IP) → **authenticate** (the access token, or in shared-key mode a constant-time key compare) → **gate** (with accounts: the plan must include the feature and the month must have room) → **validate** (Zod). Throttling runs *before* authentication so guessing is rate-limited too.
2. **Generate.** The model is called through OpenRouter with `response_format: json_schema` (`strict: true`) set to the recipe schema, and the result is re-validated strictly with Zod. See [LLM provider](#llm-provider).
3. **Prompt hygiene.** The server's own rules are the first system block. The app's `systemPrompt` is appended as clearly delimited, *lower-priority* guidance, and the pantry is re-rendered from the validated list (single-line, length-capped names), so a modified client cannot use this proxy as a free general-purpose LLM or smuggle instructions in through an ingredient name.
4. **Ingredients-only check.** Every `ingredientsUsed` entry must be a pantry ingredient (tolerating case, accents, plurals, "whole milk" for "milk") or salt/pepper/water/cooking oil, which are accepted in each of the six languages (`src/llm/essentials.ts`; "sal y pimienta" and "Salz und Pfeffer" are judged part by part). On a violation the model is asked once more, naming the offenders; if it still fails, the request ends with `422 recipe_constraint_violation`. A non-compliant recipe is never returned.
5. **Deadline.** The whole request has a 75 s budget (`REQUEST_DEADLINE_MS`), below the app's 90 s call timeout. A retry only starts if ≥ 20 s remain. Upstream work is cancelled if the client disconnects.
6. **Charge.** The month's allowance is only spent **after** the call answered `200`, so a failed call never costs the user anything.

A scan takes the same first steps (throttle with its own limit → authenticate → validate), then checks the image's magic bytes against the
declared `mimeType`, sends the photo to the vision model with the same strict-schema call and **without** response healing, and normalizes the answer.
A video scan is the same pipeline with several images in one call: it reads each frame's type from its bytes, sends all the frames in order with a prompt that
says they come from one video (so repeats are merged), and normalizes the answer with a limit of 25 items instead of 20.

## Accounts, plans and billing

With `AUTH_MODE=jwt` nothing is anonymous: every call carries a signed-in user's token, and the user's **plan** decides what they may do.

| | No plan | **Chef Junior** (`chef_junior_monthly`) | **Chef Master** (`chef_master_monthly`) |
|---|---|---|---|
| Recipes (ingredients, a dish, diets) | within the free allowance | yes | yes |
| Name suggestions while typing | yes (signed in, costs nothing) | yes | yes |
| Photo and voice | within the free allowance | **yes** | yes |
| Kitchen video | within the free allowance | no | **yes** |
| The mascot (talk to the floating chef) | within the free allowance | no | **yes** |
| Sharing with one person at home | no | no | **yes** (not built yet: the cloud comes next) |
| Monthly AI allowance | 5 | 150 | 400 |

One table, `FEATURES_BY_PLAN` in `src/billing/plans.ts`, drives the route gates, what `GET /v1/entitlements/me` tells the app (which then shows or hides its padlocks) and the tests;
`test/fixtures/plans.example.json` pins it for the app. Free accounts share five monthly uses across recipes, photo, voice, video and mascot: each successful AI request costs one use. A mascot request followed by recipe generation consists of two requests. Paid plans use **units**: a recipe costs 1, a voice note 1, a photo 2, a video 5, a sentence to the mascot 1 (suggestions cost 0).
The allowances are `AI_FREE_MONTHLY_UNITS`, `AI_JUNIOR_MONTHLY_UNITS` and `AI_MASTER_MONTHLY_UNITS`; adjust them once you see the real OpenRouter cost. The month is the calendar month in UTC.

**Mascot preference.** `GET /v1/account/mascot` and `PUT /v1/account/mascot` use the signed-in account's bearer token and return `{ "mascotEnabled": true }` (or `false`). PUT accepts that same boolean object and stores `mascotEnabled` in MongoDB's `users` document. Older accounts default to false. The user choice survives expired subscriptions; it does not grant access to AI. Android reads it on sign-in/startup, caches it separately per account and retries offline changes. It starts the mascot while the app is visible when the saved choice, feature access and overlay permission allow it, including after a renewal. Losing access or permission stops the service without changing the saved choice.

**Signing in.** The app gets a Google ID token (Credential Manager) and trades it at `POST /v1/auth/google` for an **access token** (a JWT, 15 minutes by default) and a **refresh token**
(opaque, 60 days). Only accounts whose Google client id is in `GOOGLE_CLIENT_ID` are accepted. `POST /v1/auth/refresh` trades a refresh token for a new pair; **a refresh token works once**.
`POST /v1/auth/logout` ends this phone's session (its other phones stay signed in). `DELETE /v1/account` erases the user and their data (Google Play requires deleting an account to be possible inside the app).

**Sessions live in Redis** (`REDIS_URL`), so a logout or a deleted account takes effect at once on every instance, with no time window:
- refresh tokens are stored **hashed**, single use (`GETDEL`), and presenting one that was already used (a stolen copy) **revokes every session of that user**;
- an access token carries an id (`jti`) and the user's `epoch`; logging out denies that id, and deleting the account (or detecting a leak) bumps the epoch, which kills all that user's access tokens immediately.

**Subscriptions.** The app buys with Google Play Billing, then calls `POST /v1/entitlements/verify-purchase` with the purchase token. The server asks Google (`purchases.subscriptionsv2.get`, with a
service account) and **never believes the app**: the purchase is bound to the account through the `obfuscatedAccountId` it was bought with (`billingAccountId` in `/v1/entitlements/me`), so one
token cannot serve two accounts (`409 conflict`). Active, in grace period and cancelled-but-not-yet-expired subscriptions all count as the plan; the app then acknowledges the purchase to Google.
Renewals, cancellations, refunds and holds reach the server through **real-time developer notifications**: Google Pub/Sub pushes to `POST /webhooks/google-play/rtdn` with an OIDC token that is verified
(`GOOGLE_PUBSUB_PUSH_AUDIENCE`, `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL`), and each message is processed once (de-duplicated by `messageId`). In production the webhook is not served unless that is configured.

**Data.** MongoDB database `chef` (`MONGODB_DB`), collections `users`, `entitlements`, `ai_usage` and `rtdn_messages` (indexes are created on start; the Pub/Sub ids expire by themselves).
Without `MONGODB_URI` or `REDIS_URL` a local run keeps everything in memory; production refuses to start without them.

### Local development with accounts

```bash
# .env — a local run with accounts, no Google and no Play needed
AUTH_MODE=jwt
JWT_SECRET=any-string-of-at-least-32-characters-for-local-use
DEV_GOOGLE_AUTH=1          # accepts the "ID token" dev:someone@example.com
DEV_UNLOCK_PLAN=MASTER     # optional: everybody has this plan (JUNIOR or MASTER)
MONGODB_URI=mongodb://localhost:27017   # optional: omit it to keep accounts in memory
REDIS_URL=redis://localhost:6379        # optional: same
```

```bash
curl -s -X POST localhost:8080/v1/auth/google -H 'content-type: application/json' \
  -d '{"idToken":"dev:ana@example.com"}'          # → accessToken, refreshToken, user
curl -s localhost:8080/v1/entitlements/me -H "authorization: Bearer $ACCESS_TOKEN"
```

`DEV_GOOGLE_AUTH` and `DEV_UNLOCK_PLAN` are refused in production. The Android debug build can sign in this way with `DEV_SIGN_IN_EMAIL` in its `local.properties`.

**Rolling out:** switching a deployed API from `app-key` to `jwt` stops the old app versions (they send the shared key, which is no longer accepted). Publish the app that signs in first, then change the mode.

## API docs (Swagger)

| URL | What |
|---|---|
| `/docs` | Swagger UI: schemas, a realistic example for the request and for every response, and **Try it out** |
| `/docs-json`, `/openapi.json` | The OpenAPI 3.0 document (same URLs as AntySpendApi) |

Controlled by `ENABLE_SWAGGER`: leave it unset for **on outside production and off in production**, or set `1`/`0` to force
it either way. `ENABLE_SWAGGER=false` (or `0`) disables the UI, documents and static assets in every `NODE_ENV`. When off, the routes return the normal `404` envelope and the swagger plugins are not even loaded.
**If `/docs` returns `{"error":{"code":"not_found",...}}`, check `NODE_ENV`:** `NODE_ENV=production` in your `.env` turns the docs
off unless you also set `ENABLE_SWAGGER=1`. The server logs which case applies at startup (`API docs are on` / `API docs are off ...`). The docs
need no key and are not rate limited (so loading the UI cannot trip the limit); your calls from **Try it out** are.

To call the API from the UI click **Authorize** and paste an access token (from `POST /v1/auth/google`), or in the shared-key mode the server's `CHEF_APP_KEY`; it is remembered in
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
per-call timeout and its own token cap, and goes through the same ZDR routing and error mapping as recipes. The **kitchen video** scan uses the
same model and settings: it sends the sampled frames as images in one request, so the upload is about 1 MB instead of the tens of MB a 10-second video takes, and no video has to be transcoded here.

Provider errors map to Chef's envelope: `429` → `429 rate_limited`; `408`/`504`/timeouts → `504 upstream_timeout`;
`401` (our key is wrong), `402` (out of credits), `400/403/404` (schema or routing rejected) and `5xx` → `502 upstream_error`
(shown to users as a generic outage). Operator-actionable ones are logged at `error` level with the provider's message
(truncated); the API key and pantry contents are never logged. Errors OpenRouter embeds inside an HTTP 200 are handled too.

Any OpenRouter model with structured-output support works, Claude included: set `OPENROUTER_MODEL` (for example
`anthropic/claude-sonnet-5.5`). Check the model's `supported_parameters` on `https://openrouter.ai/api/v1/models`
for `structured_outputs`, and keep the ZDR note above in mind.

## Configuration

All via environment variables, validated at startup (`src/config.ts`); this table is the full list (a `.env.example` that predates accounts may be missing the account variables: this table wins).
The server refuses to start (exit code 1, readable message) on an invalid value, on a missing `OPENROUTER_API_KEY`,
and in production on a non-https OpenRouter URL, on a missing account setting (below), or, in the shared-key mode only, on a default/short `CHEF_APP_KEY`.

**What production needs in `.env` / the App Service settings** (`AUTH_MODE=jwt`):
`NODE_ENV=production`, `OPENROUTER_API_KEY`, `AUTH_MODE=jwt`, `JWT_SECRET`, `GOOGLE_CLIENT_ID`, `MONGODB_URI`, `REDIS_URL`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64` (or `…_JSON`),
`TRUST_PROXY=1` behind a proxy, and for real-time notifications `RTDN_ENABLED=1`, `GOOGLE_PUBSUB_PUSH_AUDIENCE`, `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL`. Everything else has a default.

| Variable | Default | Notes |
|---|---|---|
| `AUTH_MODE` | `app-key` | `jwt` turns accounts, plans and quotas on (production). `app-key` is the original shared-key mode, with none of that. |
| `CHEF_APP_KEY` | `dev-local-key` | Only for `AUTH_MODE=app-key`. In production that mode needs a non-default key of ≥ 24 chars. |
| `JWT_SECRET` | – | Signs access tokens. ≥ 32 characters (required with `jwt`). |
| `JWT_ACCESS_TTL_SECONDS` / `REFRESH_TTL_DAYS` | `900` / `60` | Lifetime of an access token / of a refresh token. |
| `GOOGLE_CLIENT_ID` | – | The OAuth **web** client id the app's Google sign-in uses (comma-separate several). Required with `jwt` (or `DEV_GOOGLE_AUTH`). |
| `MONGODB_URI` / `MONGODB_DB` | – / `chef` | Accounts, entitlements, usage. Required in production with `jwt`. |
| `REDIS_URL` / `REDIS_KEY_PREFIX` | – / `chef` | Sessions (`redis://` or `rediss://`). Required in production with `jwt`. Every key starts with the prefix. |
| `GOOGLE_PLAY_PACKAGE_NAME` | `com.ichef.app` | The app's package, for verifying purchases. |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` / `…_JSON_BASE64` | – | The Play service account (a file path, or Base64 of the JSON). Without it purchases cannot be verified. |
| `RTDN_ENABLED` / `GOOGLE_PUBSUB_PUSH_AUDIENCE` / `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL` | off | Real-time notifications from Play via Pub/Sub push. |
| `AI_FREE_MONTHLY_UNITS` / `AI_JUNIOR_MONTHLY_UNITS` / `AI_MASTER_MONTHLY_UNITS` | `5` / `150` / `400` | The month's AI allowance per plan, in units (recipe 1, voice 1, photo 2, video 5). |
| `DEV_UNLOCK_PLAN` / `DEV_GOOGLE_AUTH` | – | Local development only; refused in production. |
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
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `20` / `60000` | Per client IP, in memory (per process; it does not sync across instances). A guard against floods; what limits a *user's* spending is the monthly allowance above. |
| `SCAN_RATE_LIMIT_MAX` | `6` | Photo scans per window per client, and, counted apart, video scans: the expensive calls, so tighter than the rest. |
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
- **Startup failures say what to check.** If MongoDB or Redis cannot be reached the API stops at once (it does not hang) and the log says which server it tried (host only: the user and
  password are never written), the driver's reason, and what to check, e.g. `Could not connect to MongoDB (cluster0.xxx.mongodb.net, database "chef"): Server selection timed out after 10000 ms.
  No server answered. …`. The usual causes: a database that does not accept connections from the host (MongoDB Atlas → Network Access must list the app's outbound IPs), a `MONGODB_URI` left pointing at
  `localhost`, a password with unencoded special characters, or a hosted Redis that needs `rediss://`. Once running, Redis is retried for ever, so a restart of it is survived.
- **Graceful shutdown:** `SIGTERM`/`SIGINT` finish in-flight requests before exiting.
- Hosting and deployment configuration are intentionally not covered here.

## Security notes

- The original shared `CHEF_APP_KEY` shipped inside the APK, so anyone who unpacked it could use the AI for free. With accounts that is gone: every call needs a signed-in user,
  and a plan or the small free allowance pays for it. The key mode remains only for tests and local tries, and the app no longer carries a key.
- Secrets (`JWT_SECRET`, the Play service account, the Mongo and Redis URLs) belong in the host's settings, never in the repository. Refresh tokens are stored hashed; Google ID tokens are verified against Google's keys and audience.
- Play Integrity / App Check could be added later as another `ClientVerifier` (`src/auth/clientVerifier.ts`) if abuse of sign-up ever matters.
- Set a spend limit/alert on the OpenRouter key you give this service (OpenRouter supports per-key credit limits).
- Dependencies are pinned by `package-lock.json`; run `npm audit` and keep the SDK current.


## Recipe cooking safety

The server's shared recipe rules require measured amounts in each step, consistent totals when ingredients are split,
moderate oil and salt, and an explicit measured amount of oil to retain before sauteing after frying.
Relevant precautions belong before the risky action in the step description, including conditional thawing/drying before
frying raw meat and checking poultry at 74 °C / 165 °F with a food thermometer. Both pantry recipes and requested dishes
use these rules; client guidance cannot override them. No response fields change.

References: [USDA chicken handling](https://www.fsis.usda.gov/food-safety/safe-food-handling-and-preparation/poultry/chicken-farm-table),
[USFA cooking fire safety](https://www.usfa.fema.gov/prevention/home-fires/prevent-fires/cooking/).
These are model instructions, not a deterministic food-safety validator. Prompt/schema tests verify the request contract;
they do not certify the safety of generated recipes.
