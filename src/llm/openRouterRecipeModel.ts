import type { FastifyBaseLogger } from "fastify";
import { ApiError } from "../errors.js";
import { firstEmoji } from "../emoji.js";
import { RecipeSchema } from "../schema.js";
import { OpenRouterClient, parseJsonContent } from "./openRouterClient.js";
import { RECIPE_JSON_SCHEMA_NAME, buildRecipeJsonSchema } from "./recipeJsonSchema.js";
import type { ModelRequest, ModelResponse, RecipeModel } from "./recipeModel.js";

export interface OpenRouterModelOptions {
  apiKey: string;
  model: string;
  /** e.g. https://openrouter.ai/api/v1 (no trailing path). Overridable for tests and gateways. */
  baseUrl: string;
  maxTokens: number;
  temperature: number;
  /** Route only to Zero-Data-Retention endpoints. Same privacy posture as AntySpendApi. */
  zdr: boolean;
}

/** Turns the pantry into a recipe through OpenRouter, mirroring AntySpendApi's `chatCompletionJson`. */
export class OpenRouterRecipeModel implements RecipeModel {
  readonly provider = "openrouter";

  private readonly client: OpenRouterClient;
  private readonly jsonSchema = buildRecipeJsonSchema();

  constructor(
    private readonly options: OpenRouterModelOptions,
    private readonly log?: FastifyBaseLogger,
  ) {
    this.client = new OpenRouterClient(
      { apiKey: options.apiKey, baseUrl: options.baseUrl, zdr: options.zdr },
      log,
    );
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const result = await this.client.chatJson({
      model: this.options.model,
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
      messages: [
        { role: "system", content: request.system.map((block) => block.text).join("\n\n") },
        { role: "user", content: request.userMessage },
      ],
      schemaName: RECIPE_JSON_SCHEMA_NAME,
      schema: this.jsonSchema,
      // Repairs small JSON defects (trailing commas, fences) server-side before we ever see the answer.
      healing: true,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });

    // Structured output narrows the shape; the strict schema also enforces non-empty / non-negative values.
    const strict = RecipeSchema.safeParse(parseJsonContent(result.content));
    if (!strict.success) {
      // Field paths only: never log the generated content.
      this.log?.warn(
        { model: this.options.model, invalidFields: strict.error.issues.slice(0, 5).map((i) => i.path.join(".")) },
        "recipe failed strict validation",
      );
      throw new ApiError("upstream_error", "The generated recipe was incomplete. Please try again.");
    }

    return {
      // One emoji, whatever the model wrote around it.
      recipe: { ...strict.data, emoji: firstEmoji(strict.data.emoji) },
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      model: result.model,
    };
  }
}
