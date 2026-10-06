import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import { type Config, swaggerEnabled } from "./config.js";
import { MAX_EXTRACT_TRANSCRIPT_LENGTH, MAX_INGREDIENTS, MAX_SCAN_ITEMS, MAX_SUGGESTIONS, errorResponse } from "./schema.js";

/** One documented response per status; the codes match `src/errors.ts` and the table in the README. */
export const ERROR_RESPONSES = {
  400: errorResponse(
    "`invalid_request`: the body does not match the schema or is not valid JSON. The message names the offending fields, never their values.",
    { code: "invalid_request", message: "Invalid request. ingredients: Too small: expected array to have >=1 items" },
  ),
  401: errorResponse("`unauthorized`: the `X-Chef-App-Key` header is missing or wrong.", {
    code: "unauthorized",
    message: "Missing or invalid app key.",
  }),
  413: errorResponse("`payload_too_large`: the body is over 16 KB.", {
    code: "payload_too_large",
    message: "The request is too large.",
  }),
  422: errorResponse(
    "`recipe_refused` or `recipe_constraint_violation`: the model declined, or could not build a recipe from only the pantry ingredients even after a retry. Safe to retry.",
    {
      code: "recipe_constraint_violation",
      message: "Chef could not make a recipe from only your pantry ingredients. Please try again.",
    },
  ),
  429: errorResponse("`rate_limited`: too many requests from this client, or the model provider is busy.", {
    code: "rate_limited",
    message: "Too many requests. Please slow down.",
  }),
  500: errorResponse("`internal_error`: unexpected failure. Details are logged server-side, never returned.", {
    code: "internal_error",
    message: "Something went wrong. Please try again.",
  }),
  502: errorResponse("`upstream_error`: the model provider failed or returned something unusable.", {
    code: "upstream_error",
    message: "Chef is temporarily unavailable.",
  }),
  504: errorResponse("`upstream_timeout`: the request's time budget was exhausted.", {
    code: "upstream_timeout",
    message: "The request took too long.",
  }),
} as const;

/** Replaces Fastify's logo in Swagger UI's top bar: the Chef hat from the app icon, next to the name. */
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="104" height="40" viewBox="0 0 104 40">
  <rect width="40" height="40" rx="9" fill="#14522C"/>
  <g fill="#FFF4E6">
    <circle cx="14" cy="16" r="5.5"/><circle cx="20" cy="13" r="6.5"/><circle cx="26" cy="16" r="5.5"/>
    <rect x="12" y="16" width="16" height="7"/>
    <path d="M12 25h16v3a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 12 28z"/>
  </g>
  <text x="50" y="27" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="700" fill="#FFFFFF">Chef</text>
</svg>`;

export function scanOperationDescription(config: Config): string {
  return [
    "Reads a photo of a **grocery receipt or food packaging** and returns the food items it finds, ready to add to the pantry.",
    "",
    "How it behaves:",
    `- Send the photo as base64 (JPEG, PNG or WebP, up to about 1 MB; the app downscales it first) together with the user's local date. Up to ${MAX_SCAN_ITEMS} items come back.`,
    "- The media type must match the bytes of the image, or the call is rejected with `400`.",
    "- `expiresOn` is only filled when a best-before date is clearly printed on the package; otherwise use `shelfLifeDays` to estimate one.",
    "- Names are normalised to short common English names. Anything that is not food is ignored. Text inside the photo is never treated as instructions.",
    `- Rate limit: ${config.SCAN_RATE_LIMIT_MAX} scans per ${Math.round(config.RATE_LIMIT_WINDOW_MS / 1000)} s per client. This is the expensive call.`,
    "",
    "**Try it out calls a vision model and costs money.**",
  ].join("\n");
}

export function suggestOperationDescription(config: Config): string {
  return [
    "Completes the name of a food while the user types it in the add-ingredient field, and returns what the form needs to fill itself in: category, unit, where it is kept, a typical shelf life, an emoji and a storage tip. **Nothing about foods is stored in the app**: it all comes from this call.",
    "",
    "How it behaves:",
    `- Send what has been typed so far (a partial word is fine) with \`language\` and \`region\`. Up to ${MAX_SUGGESTIONS} foods come back, most likely first; an empty list means the text is not (the start of) a food or drink.`,
    "- Names and tips are written in `language`, the way it is spoken in `region`, with that country's everyday words for each food.",
    "- Answers are deterministic and cached for 24 hours per (text, language, region), so repeated typing is free.",
    "- What the user types is treated as data, never as instructions, and is never logged.",
    `- Rate limit: ${config.SUGGEST_RATE_LIMIT_MAX} requests per ${Math.round(config.RATE_LIMIT_WINDOW_MS / 1000)} s per client.`,
    "",
    "**Try it out calls a language model and costs money (unless the answer is cached).**",
  ].join("\n");
}

export function extractOperationDescription(config: Config): string {
  return [
    `Turns what the user **said out loud** about the food they have into a list of pantry items, each with its own details, ready for the user to check and save. The phone's speech recognizer produces the text; **no audio ever reaches this API**.`,
    "",
    "How it behaves:",
    `- Send the transcript (up to ${MAX_EXTRACT_TRANSCRIPT_LENGTH} characters), the user's local date, \`language\` and \`region\`. Up to ${MAX_SCAN_ITEMS} items come back, in the order they were said.`,
    "- Each item has a name (in `language`, with `region`'s everyday words), an emoji, quantity and unit (spoken numbers and fractions are converted), category, where it is kept, an `expiresOn` date only when the user said one (\"on Friday\", \"tomorrow\") and a `shelfLifeDays` estimate otherwise.",
    "- `heard` repeats the words that described the item, so the user can check what was understood. Recognition mistakes are corrected when the context makes the food clear.",
    "- Anything that is not food is ignored and nothing the user did not name is added; an empty list means no food was named. The transcript is treated as data, never as instructions, and is never logged.",
    `- Rate limit: ${config.EXTRACT_RATE_LIMIT_MAX} requests per ${Math.round(config.RATE_LIMIT_WINDOW_MS / 1000)} s per client.`,
    "",
    "**Try it out calls a language model and costs money.**",
  ].join("\n");
}

export function apiDescription(): string {
  return [
    "Turns a pantry into a recipe that uses **only** the pantry's ingredients (plus salt, pepper, water and cooking oil).",
    "",
    "The Chef Android app calls this API instead of an LLM directly, so no model key ever ships in the app.",
    "",
    "### Authentication",
    "Every `/v1` call needs the `X-Chef-App-Key` header with the shared key (the server's `CHEF_APP_KEY`).",
    "Use the **Authorize** button; the key is remembered in this browser tab.",
    "",
    "### Errors",
    "Every non-2xx response has the same shape: `{ \"error\": { \"code\": \"...\", \"message\": \"...\" } }`.",
  ].join("\n");
}

export function generateOperationDescription(config: Config): string {
  const perMinute = Math.round((config.RATE_LIMIT_MAX / config.RATE_LIMIT_WINDOW_MS) * 60_000 * 10) / 10;
  return [
    "Sends the pantry to the LLM and returns one recipe as **minified JSON**. Every field is required.",
    "",
    "How it behaves:",
    `- Send 1 to ${MAX_INGREDIENTS} ingredients. Do not send expired ones.`,
    "- The server's own rules outrank `systemPrompt`; the app's text is only extra guidance.",
    "- Every entry of `ingredientsUsed` is checked against the request. If the model used something that is not in the pantry it is asked once more; if it still does, the call ends with `422` and no recipe is returned.",
    `- A call can take up to ${Math.round(config.REQUEST_DEADLINE_MS / 1000)} s (LLM latency). It is cut off with \`504\` after that.`,
    `- Rate limit: ${config.RATE_LIMIT_MAX} requests per ${Math.round(config.RATE_LIMIT_WINDOW_MS / 1000)} s per client (about ${perMinute}/min).`,
    "",
    "**Try it out calls the real LLM and costs money.**",
  ].join("\n");
}

/**
 * Registers Swagger UI at /docs and the OpenAPI document at /docs-json and /openapi.json (the same URLs
 * AntySpendApi uses). No-op when docs are disabled, so production does not even load the plugins.
 *
 * Must run BEFORE the rate-limit plugin is registered: routes added earlier are not throttled, which keeps the
 * UI's static assets from tripping the limit on a normal page load.
 */
export async function registerDocs(app: FastifyInstance, config: Config): Promise<void> {
  if (!swaggerEnabled(config)) {
    // A bare 404 on /docs gives no hint why, so say it once at startup.
    app.log.info(
      config.ENABLE_SWAGGER === false
        ? "API docs are off (ENABLE_SWAGGER is disabled)."
        : `API docs are off by default when NODE_ENV=${config.NODE_ENV}. Set ENABLE_SWAGGER=1 to serve them at /docs.`,
    );
    return;
  }

  await app.register(swagger, {
    openapi: {
      info: { title: "Chef API", description: apiDescription(), version: "1.0.0" },
      tags: [
        { name: "recipes", description: "AI recipe generation." },
        { name: "ingredients", description: "Reading ingredients from photos and from what the user says, and completing names as they type." },
        { name: "meta", description: "Operational endpoints." },
      ],
      components: {
        securitySchemes: {
          appKey: {
            type: "apiKey",
            in: "header",
            name: "X-Chef-App-Key",
            description: "Shared app key (the server's `CHEF_APP_KEY`).",
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    theme: { title: "Chef API" },
    logo: { type: "image/svg+xml", content: LOGO_SVG },
    uiConfig: {
      persistAuthorization: true,
      docExpansion: "list",
      deepLinking: true,
      tryItOutEnabled: true,
    },
  });

  const hidden = { schema: { hide: true } } as const;
  app.get("/docs-json", hidden, async () => app.swagger());
  app.get("/openapi.json", hidden, async () => app.swagger());

  app.log.info("API docs are on: Swagger UI at /docs, OpenAPI document at /docs-json and /openapi.json.");
}
