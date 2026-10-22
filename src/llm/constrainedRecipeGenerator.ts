import type { FastifyBaseLogger } from "fastify";
import { ApiError } from "../errors.js";
import { allergenMatches, canonicalAllergens, type AllergenId } from "../allergens/catalog.js";
import { filterPantryForDiets, uniqueDiets } from "./diets.js";
import { findOverusedIngredients, findUnlistedIngredients, isEssential, matchPantryIngredient, trimToPantry } from "./ingredientMatcher.js";
import { buildRepeatFeedback, buildSystemBlocks, buildUserMessage, buildViolationFeedback, type VarietyHints } from "./prompt.js";
import type { Recipe } from "../schema.js";
import type { GenerateRecipeInput, GenerationResult, RecipeGenerator } from "./recipeGenerator.js";
import type { RecipeModel } from "./recipeModel.js";
import { findRepeatedRecipe, shuffledCookingStyles, tidyRecentRecipes } from "./variety.js";

export interface ConstrainedGeneratorOptions {
  /** Per model call. */
  attemptTimeoutMs: number;
  /** Clock seam for tests. */
  now?: () => number;
  /** Shuffles the cooking styles; [0, 1) like Math.random. Seam for tests. */
  random?: () => number;
}

const MAX_ATTEMPTS = 2;
/** A second attempt is only worth starting if a meaningful amount of the budget is left. */
const MIN_RETRY_BUDGET_MS = 20_000;

/** Check all recipe prose, including optional tips and amounts, without retaining or logging matches. */
function violatesAllergies(recipe: Recipe, allergens: readonly AllergenId[]): boolean {
  if (allergens.length === 0) return false;
  const text = [
    recipe.title, recipe.description, recipe.highlight ?? "",
    ...recipe.ingredientsUsed.flatMap((entry) => [entry.name, entry.amount]),
    ...recipe.missingIngredients.flatMap((entry) => [entry.name, entry.amount]),
    ...recipe.instructions.flatMap((step) => [step.title, step.description, step.tip ?? ""]),
  ];
  return text.some((value) => allergenMatches(value, allergens).length > 0);
}

/**
 * Provider-independent policy around a [RecipeModel]: builds the prompt (server rules outrank the app's
 * text), enforces the product's core promise that a recipe uses only pantry ingredients, asks the model
 * once more when it breaks that promise, and never returns a non-compliant recipe.
 *
 * When the user asks for a dish the promise is the same one seen from the other side: what the recipe uses must be in the
 * pantry, and what the pantry lacks must be in `missingIngredients` (and only that: nothing the pantry already holds).
 * Dietary requirements shape the pantry before the model sees it: what an eating style rules out is not there to be used.
 *
 * A pantry recipe is also meant to be a different dish each time: the model gets the cooking styles in a fresh random order and
 * the user's latest recipes to stay away from, and a recipe that repeats one of them is asked for again while there is a try left
 * (on the last try it is kept: a repeat is better than no recipe).
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
    const allergens = canonicalAllergens(input.allergens ?? []);
    // Both selected-ingredient and requested-dish flows use only this filtered pantry.
    const pantry = filterPantryForDiets(input.ingredients, diets)
      .filter((ingredient) => allergenMatches(ingredient.name, allergens).length === 0);
    if (pantry.length === 0 && !dish) {
      throw new ApiError("recipe_refused", allergens.length > 0
        ? "None of your ingredients fit your food preferences."
        : "None of your ingredients fit the diet you chose.");
    }
    // A dish is what the user asked for, however often: variety is for recipes made from the pantry.
    const variety: VarietyHints | undefined = dish
      ? undefined
      : { styles: shuffledCookingStyles(this.options.random), recent: tidyRecentRecipes(input.recentRecipes) };
    let feedback: string | undefined;
    // A good recipe that only repeated a recent one: what the user gets if the try for something else goes wrong.
    let repeatToKeep: { recipe: Recipe; model?: string } | undefined;
    let inputTokens = 0;
    let outputTokens = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const remaining = input.deadlineAt - now();
      if (remaining <= 0) throw new ApiError("upstream_timeout", "The request took too long.");

      const response = await this.model.complete({
        system: buildSystemBlocks(input.clientSystemPrompt, input.language, input.region, { dish: dish !== undefined, diets, allergens, city: input.city }),
        userMessage: buildUserMessage(pantry, new Date(now()), feedback, dish, variety),
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
      const repeated = variety ? findRepeatedRecipe(response.recipe.title, variety.recent) : undefined;
      const canRetry = attempt < MAX_ATTEMPTS && input.deadlineAt - now() >= MIN_RETRY_BUDGET_MS;
      const allergyViolation = violatesAllergies(response.recipe, allergens);
      const compliant =
        !allergyViolation && unlisted.length === 0 && overused.length === 0 && heldAsMissing.length === 0 && unexpectedMissing.length === 0 && !usesNothing;
      if (compliant && (repeated === undefined || !canRetry)) {
        if (repeated !== undefined) this.log?.warn({ attempt }, "recipe repeats a recent one; no try left, kept");
        return {
          recipe: response.recipe,
          attempts: attempt,
          provider: this.model.provider,
          model: response.model,
          usage: { inputTokens, outputTokens },
        };
      }

      if (compliant) {
        // Only a repeat, and there is time to ask for something else.
        this.log?.warn({ attempt }, "recipe repeats a recent one");
        feedback = buildRepeatFeedback(response.recipe.title, repeated!);
        repeatToKeep = { recipe: response.recipe, model: response.model };
        continue;
      }

      this.log?.warn(
        {
          attempt,
          unlistedCount: unlisted.length,
          overusedCount: overused.length,
          heldAsMissingCount: heldAsMissing.length,
          unexpectedMissingCount: unexpectedMissing.length,
          repeated: repeated !== undefined,
          allergyViolation,
        },
        "recipe broke a generation constraint",
      );
      // A pantry recipe whose only fault is a little too much of something is not thrown away at the end: it takes what there is
      // instead. A dish keeps its rule (what it needs beyond the pantry is to buy, so the model is asked again, not corrected here).
      const onlyTooMuch =
        !allergyViolation && !dish && overused.length > 0 && unlisted.length === 0 && heldAsMissing.length === 0 && unexpectedMissing.length === 0 && !usesNothing;
      const trim = !canRetry && onlyTooMuch ? trimToPantry(response.recipe.ingredientsUsed, pantry) : undefined;
      if (trim) {
        this.log?.warn({ attempt, trimmedCount: trim.trimmed.length }, "recipe trimmed to what the pantry holds");
        return {
          recipe: { ...response.recipe, ingredientsUsed: trim.ingredients },
          attempts: attempt,
          provider: this.model.provider,
          model: response.model,
          usage: { inputTokens, outputTokens },
        };
      }
      if (!canRetry && allergyViolation) {
        throw new ApiError("recipe_refused", "Chef could not make a recipe that respects your food allergies. Please try again.");
      }
      if (!canRetry && repeatToKeep) {
        this.log?.warn({ attempt }, "the different recipe broke the rules; the repeated one is kept");
        return {
          recipe: repeatToKeep.recipe,
          attempts: attempt,
          provider: this.model.provider,
          model: repeatToKeep.model,
          usage: { inputTokens, outputTokens },
        };
      }
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
        allergyViolation,
      });
      if (repeated !== undefined) feedback += ` ${buildRepeatFeedback(response.recipe.title, repeated)}`;
    }

    // Unreachable: the loop either returns or throws.
    throw new ApiError("internal_error", "Unexpected generation state.");
  }
}
