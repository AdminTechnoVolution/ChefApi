import type { FastifyBaseLogger } from "fastify";
import { ApiError } from "../errors.js";
import { filterPantryForDiets, uniqueDiets } from "./diets.js";
import { findOverusedIngredients, findUnlistedIngredients, isEssential, matchPantryIngredient } from "./ingredientMatcher.js";
import { buildSystemBlocks, buildUserMessage, buildViolationFeedback } from "./prompt.js";
import type { GenerateRecipeInput, GenerationResult, RecipeGenerator } from "./recipeGenerator.js";
import type { RecipeModel } from "./recipeModel.js";

export interface ConstrainedGeneratorOptions {
  /** Per model call. */
  attemptTimeoutMs: number;
  /** Clock seam for tests. */
  now?: () => number;
}

const MAX_ATTEMPTS = 2;
/** A second attempt is only worth starting if a meaningful amount of the budget is left. */
const MIN_RETRY_BUDGET_MS = 20_000;

/**
 * Provider-independent policy around a [RecipeModel]: builds the prompt (server rules outrank the app's
 * text), enforces the product's core promise that a recipe uses only pantry ingredients, asks the model
 * once more when it breaks that promise, and never returns a non-compliant recipe.
 *
 * When the user asks for a dish the promise is the same one seen from the other side: what the recipe uses must be in the
 * pantry, and what the pantry lacks must be in `missingIngredients` (and only that: nothing the pantry already holds).
 * Dietary requirements shape the pantry before the model sees it: what an eating style rules out is not there to be used.
 */
export class ConstrainedRecipeGenerator implements RecipeGenerator {
  constructor(
    private readonly model: RecipeModel,
    private readonly options: ConstrainedGeneratorOptions,
    private readonly log?: FastifyBaseLogger,
  ) {}

  async generate(input: GenerateRecipeInput): Promise<GenerationResult> {
    const now = this.options.now ?? Date.now;
    const dish = input.dish?.trim() ? input.dish.trim() : undefined;
    const diets = uniqueDiets(input.diets ?? []);
    // The pantry the model works from: without what the requested eating style rules out.
    const pantry = filterPantryForDiets(input.ingredients, diets);
    if (pantry.length === 0 && !dish) {
      throw new ApiError("recipe_refused", "None of your ingredients fit the diet you chose.");
    }
    let feedback: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const remaining = input.deadlineAt - now();
      if (remaining <= 0) throw new ApiError("upstream_timeout", "The request took too long.");

      const response = await this.model.complete({
        system: buildSystemBlocks(input.clientSystemPrompt, input.language, input.region, { dish: dish !== undefined, diets, city: input.city }),
        userMessage: buildUserMessage(pantry, new Date(now()), feedback, dish),
        timeoutMs: Math.min(this.options.attemptTimeoutMs, remaining),
        signal: input.signal,
      });
      inputTokens += response.inputTokens;
      outputTokens += response.outputTokens;

      const unlisted = findUnlistedIngredients(
        response.recipe.ingredientsUsed.map((entry) => entry.name),
        pantry,
      );
      const overused = findOverusedIngredients(response.recipe.ingredientsUsed, pantry);
      const missing = response.recipe.missingIngredients.map((entry) => entry.name);
      // To buy what is already at home (or is free to use anyway) would send the user shopping for nothing.
      const heldAsMissing = dish ? missing.filter((name) => isEssential(name) || matchPantryIngredient(name, pantry)) : [];
      // Without a dish the recipe is the pantry alone: a shopping list, or no pantry at all in it, breaks that.
      const unexpectedMissing = dish ? [] : missing;
      const usesNothing = !dish && response.recipe.ingredientsUsed.length === 0;
      if (
        unlisted.length === 0 &&
        overused.length === 0 &&
        heldAsMissing.length === 0 &&
        unexpectedMissing.length === 0 &&
        !usesNothing
      ) {
        return {
          recipe: response.recipe,
          attempts: attempt,
          provider: this.model.provider,
          model: response.model,
          usage: { inputTokens, outputTokens },
        };
      }

      this.log?.warn(
        {
          attempt,
          unlistedCount: unlisted.length,
          overusedCount: overused.length,
          heldAsMissingCount: heldAsMissing.length,
          unexpectedMissingCount: unexpectedMissing.length,
        },
        "recipe broke the pantry-only rule",
      );
      const canRetry = attempt < MAX_ATTEMPTS && input.deadlineAt - now() >= MIN_RETRY_BUDGET_MS;
      if (!canRetry) {
        throw new ApiError(
          "recipe_constraint_violation",
          "Chef could not make a recipe from only your pantry ingredients. Please try again.",
        );
      }
      feedback = buildViolationFeedback(unlisted, overused, {
        dish: dish !== undefined,
        heldAsMissing,
        unexpectedMissing,
        usesNothing,
      });
    }

    // Unreachable: the loop either returns or throws.
    throw new ApiError("internal_error", "Unexpected generation state.");
  }
}
