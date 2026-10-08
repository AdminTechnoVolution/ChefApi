import type { FastifyBaseLogger } from "fastify";
import { ApiError } from "../errors.js";
import { normalizeExtracted } from "../extract/openRouterIngredientExtractor.js";
import { OpenRouterClient, parseJsonContent } from "../llm/openRouterClient.js";
import { sanitizeInline } from "../llm/prompt.js";
import { ASSISTANT_JSON_SCHEMA_NAME, buildAssistantJsonSchema } from "../llm/recipeJsonSchema.js";
import {
  AssistantPantryQuerySchema,
  MAX_ASSISTANT_DISH_LENGTH,
  MAX_ASSISTANT_NAME_LENGTH,
  MAX_ASSISTANT_REPLY_LENGTH,
  MAX_SCAN_ITEMS,
  type AssistantResult,
} from "../schema.js";
import { buildAssistantMessages } from "./assistantPrompt.js";
import type { AssistantInput, AssistantOutcome, AssistantUnderstander } from "./assistantUnderstander.js";

export interface OpenRouterAssistantOptions {
  apiKey: string;
  baseUrl: string;
  zdr: boolean;
  /** A text model with structured-output support (the same one as recipes, suggestions and dictation). */
  model: string;
  maxTokens: number;
  /** Per model call. */
  attemptTimeoutMs: number;
  /** Clock seam for tests. */
  now?: () => number;
}

/** Understands what a person asked the mascot, through OpenRouter, with a strict JSON schema. */
export class OpenRouterAssistantUnderstander implements AssistantUnderstander {
  private readonly client: OpenRouterClient;
  private readonly jsonSchema = buildAssistantJsonSchema();

  constructor(
    private readonly options: OpenRouterAssistantOptions,
    private readonly log?: FastifyBaseLogger,
  ) {
    this.client = new OpenRouterClient({ apiKey: options.apiKey, baseUrl: options.baseUrl, zdr: options.zdr }, log);
  }

  async understand(input: AssistantInput): Promise<AssistantOutcome> {
    const now = this.options.now ?? Date.now;
    const remaining = input.deadlineAt - now();
    if (remaining <= 0) throw new ApiError("upstream_timeout", "The request took too long.");

    const result = await this.client.chatJson({
      model: this.options.model,
      // Understanding wants determinism: the same words mean the same thing.
      temperature: 0,
      maxTokens: this.options.maxTokens,
      messages: buildAssistantMessages(input.transcript, input.today, input.language, input.region),
      schemaName: ASSISTANT_JSON_SCHEMA_NAME,
      schema: this.jsonSchema,
      healing: true,
      timeoutMs: Math.min(this.options.attemptTimeoutMs, remaining),
      signal: input.signal,
    });

    const parsed = parseJsonContent(result.content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError("upstream_error", "What you said could not be understood. Please try again.");
    }

    return {
      result: normalizeAssistant(parsed as Record<string, unknown>, input.today, this.log),
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }
}

const UNKNOWN = (reply: string): AssistantResult => ({ intent: "unknown", reply, ingredients: [], recipe: null });

/**
 * Turns what the model returned into the answer the app reads, and makes it consistent whatever the model got wrong: the intent
 * decides which part is kept and the other is emptied, an intent that ended up with nothing to act on becomes `unknown`, and every
 * text is cleaned and bounded. The reply may end up empty (the app then says its own, in the user's language).
 */
export function normalizeAssistant(raw: Record<string, unknown>, today: string, log?: FastifyBaseLogger): AssistantResult {
  const reply = cleanText(raw.reply, MAX_ASSISTANT_REPLY_LENGTH);

  if (raw.intent === "query_pantry") {
    const query = AssistantPantryQuerySchema.safeParse(raw.pantryQuery);
    if (!query.success) return UNKNOWN("");
    if (["exists", "quantity", "location"].includes(query.data.kind) && !query.data.ingredientNames.length) return UNKNOWN("");
    return { intent: "query_pantry", reply: "", ingredients: [], recipe: null, pantryQuery: query.data };
  }

  if (raw.intent === "add_ingredients") {
    const rawItems = Array.isArray(raw.ingredients) ? raw.ingredients : [];
    const ingredients = normalizeExtracted(rawItems, today, log);
    // Nothing usable came out: the reply (which promised food to check) would be a lie.
    return ingredients.length === 0 ? UNKNOWN("") : { intent: "add_ingredients", reply, ingredients, recipe: null };
  }

  if (raw.intent === "make_recipe") {
    const recipe = (raw.recipe ?? {}) as Record<string, unknown>;
    const dish = cleanText(recipe.dish, MAX_ASSISTANT_DISH_LENGTH) || null;
    const seen = new Set<string>();
    const ingredientNames: string[] = [];
    for (const name of Array.isArray(recipe.ingredientNames) ? recipe.ingredientNames : []) {
      const clean = cleanText(name, MAX_ASSISTANT_NAME_LENGTH);
      if (!clean || seen.has(clean.toLowerCase()) || ingredientNames.length >= MAX_SCAN_ITEMS) continue;
      seen.add(clean.toLowerCase());
      ingredientNames.push(clean);
    }
    // Asking to cook without naming a dish or a food means "with what I have", whatever flag the model set; naming either means it does not.
    const wholePantry = dish === null && ingredientNames.length === 0;
    return { intent: "make_recipe", reply, ingredients: [], recipe: { dish, ingredientNames, wholePantry } };
  }

  return UNKNOWN(reply);
}

/** One line, no stray spaces, at most [max] characters. Anything that is not text is nothing. */
function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? sanitizeInline(value, max).trim() : "";
}
