import type { FastifyBaseLogger } from "fastify";
import { ApiError } from "../errors.js";
import { findOverusedIngredients, findUnlistedIngredients } from "./ingredientMatcher.js";
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
 */
export class ConstrainedRecipeGenerator implements RecipeGenerator {
  constructor(
    private readonly model: RecipeModel,
    private readonly options: ConstrainedGeneratorOptions,
    private readonly log?: FastifyBaseLogger,
  ) {}

  async generate(input: GenerateRecipeInput): Promise<GenerationResult> {
    const now = this.options.now ?? Date.now;
    let feedback: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const remaining = input.deadlineAt - now();
      if (remaining <= 0) throw new ApiError("upstream_timeout", "The request took too long.");

      const response = await this.model.complete({
        system: buildSystemBlocks(input.clientSystemPrompt, input.language, input.region),
        userMessage: buildUserMessage(input.ingredients, new Date(now()), feedback),
        timeoutMs: Math.min(this.options.attemptTimeoutMs, remaining),
        signal: input.signal,
      });
      inputTokens += response.inputTokens;
      outputTokens += response.outputTokens;

      const unlisted = findUnlistedIngredients(
        response.recipe.ingredientsUsed.map((entry) => entry.name),
        input.ingredients,
      );
      const overused = findOverusedIngredients(response.recipe.ingredientsUsed, input.ingredients);
      if (unlisted.length === 0 && overused.length === 0) {
        return {
          recipe: response.recipe,
          attempts: attempt,
          provider: this.model.provider,
          model: response.model,
          usage: { inputTokens, outputTokens },
        };
      }

      this.log?.warn(
        { attempt, unlistedCount: unlisted.length, overusedCount: overused.length },
        "recipe broke the pantry-only rule",
      );
      const canRetry = attempt < MAX_ATTEMPTS && input.deadlineAt - now() >= MIN_RETRY_BUDGET_MS;
      if (!canRetry) {
        throw new ApiError(
          "recipe_constraint_violation",
          "Chef could not make a recipe from only your pantry ingredients. Please try again.",
        );
      }
      feedback = buildViolationFeedback(unlisted, overused);
    }

    // Unreachable: the loop either returns or throws.
    throw new ApiError("internal_error", "Unexpected generation state.");
  }
}
