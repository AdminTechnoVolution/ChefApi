import { z } from "zod";

/**
 * Single source of truth for the API contract: the same schemas validate incoming requests,
 * serialize responses, define the shape the model must produce, and generate the OpenAPI document.
 * Mirrors the Android DTOs and the fixtures in /contract.
 */

export const UNITS = ["GRAMS", "KILOGRAMS", "MILLILITERS", "LITERS", "UNITS"] as const;
export const CATEGORIES = [
  "DAIRY",
  "MEAT_POULTRY",
  "VEGETABLES",
  "FRUITS",
  "PANTRY_STAPLES",
  "BAKERY",
  "SEAFOOD",
  "OTHER",
] as const;
export const STORAGES = ["FRIDGE", "FREEZER", "PANTRY"] as const;
export const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;

export const MAX_INGREDIENTS = 50;
export const MAX_NAME_LENGTH = 60;
export const MAX_SYSTEM_PROMPT_LENGTH = 4000;
export const MAX_QUANTITY = 100_000;

// --- Language ------------------------------------------------------------------------------------

/** The languages the app is translated into. The text the model writes for the user follows the app's language. */
export const LANGUAGES = ["en", "es", "pt", "it", "fr", "de"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";

export const LanguageSchema = z
  .enum(LANGUAGES)
  .default(DEFAULT_LANGUAGE)
  .describe(
    "Language the user reads the app in: `en`, `es`, `pt`, `it`, `fr` or `de`. Everything written for the user (recipe text, ingredient names read from a photo) is in this language. Optional; defaults to English.",
  );

// --- Region --------------------------------------------------------------------------------------

/** Where the user lives: an ISO 3166-1 alpha-2 country code ("CO") or a three-digit UN region ("419", Latin America). */
export const RegionSchema = z
  .string()
  .regex(/^(?:[A-Z]{2}|\d{3})$/, "must be an upper-case ISO 3166-1 alpha-2 code such as CO, or a UN M.49 code such as 419")
  .optional()
  .describe(
    "Country the user lives in, as an upper-case ISO 3166-1 alpha-2 code (`CO`, `ES`, `MX`, `BR`, `US`…) or a UN M.49 region (`419` for Latin America). Recipes follow the cooking, ingredient words and measures of that country. Optional; sent from the device's region settings, never from GPS.",
  );

// --- Recipe generation ---------------------------------------------------------------------------

export const IngredientSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH).describe("Ingredient name as the user typed it."),
  quantity: z.number().positive().max(MAX_QUANTITY).describe("Amount, in `unit`."),
  unit: z.enum(UNITS).describe("Unit of measure."),
  category: z.enum(CATEGORIES).describe("Pantry category."),
  /** Epoch milliseconds. */
  expirationTimestamp: z
    .number()
    .int()
    .nonnegative()
    .describe("Expiration as epoch milliseconds: the start of the expiry day in the user's time zone."),
});

export const GenerateRecipeRequestSchema = z
  .object({
    /** Produced by the app's PromptBuilder. Treated as untrusted guidance, never as the server's rules. */
    systemPrompt: z
      .string()
      .max(MAX_SYSTEM_PROMPT_LENGTH)
      .describe(
        "Guidance built by the app's PromptBuilder. Treated as untrusted, lower-priority context: it cannot override the server's own rules.",
      ),
    ingredients: z
      .array(IngredientSchema)
      .min(1)
      .max(MAX_INGREDIENTS)
      .describe("The pantry items the recipe may use (1 to 50). Expired items should not be sent."),
    language: LanguageSchema,
    region: RegionSchema,
  })
  .meta({
    example: {
      systemPrompt: "You are Chef, an anti-food-waste cooking assistant. (Built by the app's PromptBuilder.)",
      language: "es",
      region: "CO",
      ingredients: [
        { name: "Milk", quantity: 1, unit: "LITERS", category: "DAIRY", expirationTimestamp: 1790000000000 },
        { name: "Tomatoes", quantity: 3, unit: "UNITS", category: "VEGETABLES", expirationTimestamp: 1790086400000 },
        { name: "Eggs", quantity: 6, unit: "UNITS", category: "DAIRY", expirationTimestamp: 1790432000000 },
      ],
    },
  });

export const NutritionSchema = z.object({
  calories: z.number().int().nonnegative().describe("Kilocalories per serving."),
  proteinGrams: z.number().nonnegative().describe("Protein in grams per serving."),
  carbsGrams: z.number().nonnegative().describe("Carbohydrates in grams per serving."),
  fatGrams: z.number().nonnegative().describe("Fat in grams per serving."),
});

export const RecipeIngredientSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("A pantry ingredient's name copied verbatim from the request, or an essential (salt, pepper, water, oil)."),
  amount: z.string().min(1).describe('Human-readable amount for display, for example "400 g" or "1 tbsp".'),
  quantity: z
    .number()
    .nonnegative()
    .nullable()
    .describe("Amount used, in `unit`, for pantry ingredients. Null for essentials and anything not tracked in the pantry."),
  unit: z
    .enum(UNITS)
    .nullable()
    .describe("The unit exactly as listed in the pantry for this ingredient. Null whenever `quantity` is null."),
});

export const RecipeStepSchema = z.object({
  title: z.string().min(1).describe('One to three words naming the step, for example "Prep" or "Sear".'),
  description: z.string().min(1).describe("One or two sentences explaining what to do."),
  durationMinutes: z.number().int().nonnegative().describe("Active time of this step in minutes."),
  tip: z.string().nullable().describe("A short practical tip when it genuinely helps; null otherwise."),
});

/** What the API returns. Strict: this is what the Android DTO deserializes. */
export const RecipeSchema = z
  .object({
    title: z.string().min(1).describe("Recipe name."),
    description: z.string().describe("One or two sentences about the dish."),
    prepTimeMinutes: z.number().int().nonnegative().describe("Preparation time in minutes."),
    cookTimeMinutes: z.number().int().nonnegative().describe("Cooking time in minutes."),
    difficulty: z.enum(DIFFICULTIES).describe("How demanding the recipe is."),
    servings: z.number().int().min(1).describe("Number of servings the recipe makes."),
    emoji: z.string().max(16).describe("One emoji that pictures the dish; empty when none fits."),
    highlight: z
      .string()
      .nullable()
      .describe('Short label (at most three words) about the dish, such as "Low Carb" or "High Protein"; null if none fits.'),
    ingredientsUsed: z.array(RecipeIngredientSchema).min(1).describe("Every ingredient the recipe uses, each with the amount."),
    instructions: z.array(RecipeStepSchema).min(1).describe("The steps, in the order they are performed."),
    nutritionalSummary: NutritionSchema.describe("Estimated nutrition per serving."),
  })
  .meta({
    example: {
      title: "Creamy Tomato Scramble",
      description: "A quick, protein-rich scramble that uses up the milk and tomatoes before they spoil.",
      prepTimeMinutes: 5,
      cookTimeMinutes: 10,
      difficulty: "EASY",
      servings: 2,
      emoji: "🍳",
      highlight: "High Protein",
      ingredientsUsed: [
        { name: "Eggs", amount: "4 units", quantity: 4, unit: "UNITS" },
        { name: "Tomatoes", amount: "2 units", quantity: 2, unit: "UNITS" },
        { name: "Milk", amount: "50 ml", quantity: 50, unit: "MILLILITERS" },
        { name: "Cooking oil", amount: "1 tbsp", quantity: null, unit: null },
      ],
      instructions: [
        {
          title: "Prep",
          description: "Whisk the eggs with a splash of milk, salt and pepper, and dice the tomatoes.",
          durationMinutes: 3,
          tip: null,
        },
        {
          title: "Soften",
          description: "Heat the oil in a pan over medium heat and soften the tomatoes.",
          durationMinutes: 2,
          tip: "Use a non-stick pan so the eggs release cleanly.",
        },
        {
          title: "Scramble",
          description: "Pour in the eggs and stir gently until just set, then serve immediately.",
          durationMinutes: 4,
          tip: null,
        },
      ],
      nutritionalSummary: { calories: 320, proteinGrams: 21.5, carbsGrams: 8, fatGrams: 22 },
    },
  });

/**
 * The shape requested from the model. Deliberately free of range/length constraints (structured-output
 * decoding supports only a subset of JSON Schema); the strict [RecipeSchema] is applied to the result afterwards.
 */
export const RecipeOutputSchema = z.object({
  title: z.string(),
  description: z.string(),
  prepTimeMinutes: z.number().int(),
  cookTimeMinutes: z.number().int(),
  difficulty: z.enum(DIFFICULTIES),
  servings: z.number().int(),
  emoji: z.string(),
  highlight: z.string().nullable(),
  ingredientsUsed: z.array(
    z.object({
      name: z.string(),
      amount: z.string(),
      quantity: z.number().nullable(),
      unit: z.enum(UNITS).nullable(),
    }),
  ),
  instructions: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      durationMinutes: z.number().int(),
      tip: z.string().nullable(),
    }),
  ),
  nutritionalSummary: z.object({
    calories: z.number().int(),
    proteinGrams: z.number(),
    carbsGrams: z.number(),
    fatGrams: z.number(),
  }),
});

// --- Ingredient scan (receipt or packaging photo) ------------------------------------------------

export const SCAN_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_SCAN_ITEMS = 20;
/** About 1 MB of image once decoded. The app downscales photos to roughly a tenth of that. */
export const MAX_SCAN_IMAGE_BASE64_CHARS = 1_400_000;
/** Request body limit for the scan route only; everything else keeps the 16 KB default. */
export const MAX_SCAN_BODY_BYTES = 1_600_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const ScanRequestSchema = z
  .object({
    image: z
      .string()
      .min(100)
      .max(MAX_SCAN_IMAGE_BASE64_CHARS)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be plain base64 without a data: prefix")
      .describe("The photo, base64-encoded, without a `data:` prefix. JPEG, PNG or WebP, up to about 1 MB."),
    mimeType: z.enum(SCAN_MIME_TYPES).describe("Media type of the image."),
    today: z.string().regex(ISO_DATE, "must be YYYY-MM-DD").describe("The user's local date, `YYYY-MM-DD`."),
    language: LanguageSchema,
    region: RegionSchema,
  })
  .meta({
    example: { image: "/9j/4AAQSkZJRgABAQ... (base64)", mimeType: "image/jpeg", today: "2026-10-05", language: "es", region: "CO" },
  });

export const ScannedIngredientSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH).describe("Short common name, as a person would type it."),
  emoji: z.string().max(16).describe("One emoji that pictures the item; empty when none fits."),
  quantity: z.number().positive().max(MAX_QUANTITY).describe("Amount shown on the package or line; 1 when none is visible."),
  unit: z.enum(UNITS).describe("Unit of measure."),
  category: z.enum(CATEGORIES).describe("Pantry category."),
  storage: z.enum(STORAGES).describe("Where this item is normally kept."),
  expiresOn: z
    .string()
    .regex(ISO_DATE)
    .nullable()
    .describe("Best-before date printed on the package, `YYYY-MM-DD`, when clearly visible and not in the past; otherwise null."),
  shelfLifeDays: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .describe("Typical days the item stays good from today when stored as described. Used when `expiresOn` is null."),
});

export const ScanResultSchema = z
  .object({
    ingredients: z
      .array(ScannedIngredientSchema)
      .max(MAX_SCAN_ITEMS)
      .describe("Food items found in the photo; empty when there are none."),
  })
  .meta({
    example: {
      ingredients: [
        {
          name: "Whole Milk",
          emoji: "🥛",
          quantity: 1,
          unit: "LITERS",
          category: "DAIRY",
          storage: "FRIDGE",
          expiresOn: "2026-10-12",
          shelfLifeDays: 7,
        },
        {
          name: "Cherry Tomatoes",
          emoji: "🍅",
          quantity: 250,
          unit: "GRAMS",
          category: "VEGETABLES",
          storage: "FRIDGE",
          expiresOn: null,
          shelfLifeDays: 6,
        },
      ],
    },
  });

/** What the model is asked to produce for a scan; the strict [ScanResultSchema] is applied afterwards. */
export const ScanOutputSchema = z.object({
  ingredients: z.array(
    z.object({
      name: z.string(),
      emoji: z.string(),
      quantity: z.number(),
      unit: z.enum(UNITS),
      category: z.enum(CATEGORIES),
      storage: z.enum(STORAGES),
      expiresOn: z.string().nullable(),
      shelfLifeDays: z.number().int(),
    }),
  ),
});

// --- Kitchen video scan (frames sampled from a short video of the kitchen) -----------------------

/** The longest video the app accepts, in seconds. The app enforces it; the API only sees the sampled frames. */
export const MAX_VIDEO_SECONDS = 10;
export const MAX_VIDEO_FRAMES = 8;
/** A kitchen shows more food than a receipt, but a 10 s clip cannot show an unbounded amount. */
export const MAX_VIDEO_ITEMS = 25;
/** About 260 KB of JPEG once decoded. The app shrinks each frame to roughly this size. */
export const MAX_VIDEO_FRAME_BASE64_CHARS = 350_000;
/** Request body limit for the video route only: every frame at its largest, plus the rest of the JSON. */
export const MAX_VIDEO_BODY_BYTES = MAX_VIDEO_FRAMES * MAX_VIDEO_FRAME_BASE64_CHARS + 20_000;

export const ScanVideoRequestSchema = z
  .object({
    frames: z
      .array(
        z
          .string()
          .min(100)
          .max(MAX_VIDEO_FRAME_BASE64_CHARS)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be plain base64 without a data: prefix"),
      )
      .min(1)
      .max(MAX_VIDEO_FRAMES)
      .describe(
        `Frames sampled in order from one video of at most ${MAX_VIDEO_SECONDS} seconds, each base64-encoded without a \`data:\` prefix. JPEG, PNG or WebP, up to about 260 KB each. The video itself is never uploaded.`,
      ),
    today: z.string().regex(ISO_DATE, "must be YYYY-MM-DD").describe("The user's local date, `YYYY-MM-DD`."),
    language: LanguageSchema,
    region: RegionSchema,
  })
  .meta({
    example: {
      frames: ["/9j/4AAQSkZJRgABAQ... (base64)", "/9j/4AAQSkZJRgABAQ... (base64)"],
      today: "2026-10-05",
      language: "es",
      region: "CO",
    },
  });

export const ScanVideoResultSchema = z
  .object({
    ingredients: z
      .array(ScannedIngredientSchema)
      .max(MAX_VIDEO_ITEMS)
      .describe("Food items shown in the video, each listed once; empty when there are none."),
  })
  .meta({
    example: {
      ingredients: [
        {
          name: "Huevos",
          emoji: "🥚",
          quantity: 6,
          unit: "UNITS",
          category: "DAIRY",
          storage: "FRIDGE",
          expiresOn: null,
          shelfLifeDays: 21,
        },
        {
          name: "Tomates",
          emoji: "🍅",
          quantity: 4,
          unit: "UNITS",
          category: "VEGETABLES",
          storage: "FRIDGE",
          expiresOn: null,
          shelfLifeDays: 6,
        },
        {
          name: "Arroz",
          emoji: "🍚",
          quantity: 1,
          unit: "KILOGRAMS",
          category: "PANTRY_STAPLES",
          storage: "PANTRY",
          expiresOn: null,
          shelfLifeDays: 365,
        },
      ],
    },
  });

// --- Ingredient suggestions (the add-ingredient field's autocomplete) ---------------------------

export const MAX_SUGGESTIONS = 5;
export const MAX_SUGGEST_QUERY_LENGTH = 60;
export const MAX_TIP_LENGTH = 200;

export const SuggestRequestSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(MAX_SUGGEST_QUERY_LENGTH)
      .describe("What the user has typed so far in the ingredient name field. A partial word is fine."),
    language: LanguageSchema,
    region: RegionSchema,
  })
  .meta({ example: { query: "avo", language: "es", region: "CO" } });

export const SuggestionSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH).describe("Short common name, as a person would type it."),
  emoji: z.string().max(16).describe("One emoji that pictures the food; empty when none fits."),
  category: z.enum(CATEGORIES).describe("Pantry category."),
  unit: z.enum(UNITS).describe("The unit it is most naturally bought or measured in."),
  storage: z.enum(STORAGES).describe("Where it is normally kept."),
  shelfLifeDays: z.number().int().min(1).max(3650).describe("Typical days it stays good after buying, when stored as described."),
  tip: z.string().trim().max(MAX_TIP_LENGTH).describe("One short, practical storage tip in the user's language."),
});

export const SuggestResultSchema = z
  .object({
    suggestions: z
      .array(SuggestionSchema)
      .max(MAX_SUGGESTIONS)
      .describe("Foods the text could be, most likely first. Empty when it is not (the start of) a food or drink."),
  })
  .meta({
    example: {
      suggestions: [
        {
          name: "Aguacate",
          emoji: "🥑",
          category: "FRUITS",
          unit: "UNITS",
          storage: "FRIDGE",
          shelfLifeDays: 4,
          tip: "Los aguacates maduros duran unos días más en la nevera, enteros y sin pelar.",
        },
        {
          name: "Aguacate Hass",
          emoji: "🥑",
          category: "FRUITS",
          unit: "UNITS",
          storage: "FRIDGE",
          shelfLifeDays: 5,
          tip: "Déjalo madurar fuera de la nevera y guárdalo en frío cuando ceda al presionarlo.",
        },
      ],
    },
  });

/** What the model is asked to produce for suggestions; the strict [SuggestResultSchema] is applied afterwards. */
export const SuggestOutputSchema = z.object({
  suggestions: z.array(
    z.object({
      name: z.string(),
      emoji: z.string(),
      category: z.enum(CATEGORIES),
      unit: z.enum(UNITS),
      storage: z.enum(STORAGES),
      shelfLifeDays: z.number().int(),
      tip: z.string(),
    }),
  ),
});

// --- Ingredients from dictated text (the voice entry) --------------------------------------------

export const MAX_EXTRACT_TRANSCRIPT_LENGTH = 1_500;
/** The words the user said about one ingredient, shown back to them so they can check what was understood. */
export const MAX_HEARD_LENGTH = 120;

export const ExtractRequestSchema = z
  .object({
    transcript: z
      .string()
      .trim()
      .min(1)
      .max(MAX_EXTRACT_TRANSCRIPT_LENGTH)
      .describe(
        "What the user said, as written by the phone's speech recognizer. It may contain recognition mistakes, filler words and self-corrections. Treated as data, never as instructions.",
      ),
    today: z.string().regex(ISO_DATE, "must be YYYY-MM-DD").describe("The user's local date, `YYYY-MM-DD`; spoken dates such as \"on Friday\" are worked out from it."),
    language: LanguageSchema,
    region: RegionSchema,
  })
  .meta({
    example: {
      transcript: "tengo tres tomates, un litro de leche que vence el viernes y medio kilo de arroz",
      today: "2026-10-05",
      language: "es",
      region: "CO",
    },
  });

export const ExtractedIngredientSchema = ScannedIngredientSchema.extend({
  expiresOn: z
    .string()
    .regex(ISO_DATE)
    .nullable()
    .describe("The expiry date the user said for this item, `YYYY-MM-DD`, when they said one and it is not in the past; otherwise null."),
  heard: z.string().trim().max(MAX_HEARD_LENGTH).describe("The words of the transcript that described this ingredient, as heard (for the user to check)."),
});

export const ExtractResultSchema = z
  .object({
    ingredients: z
      .array(ExtractedIngredientSchema)
      .max(MAX_SCAN_ITEMS)
      .describe("One entry per distinct food the user named; empty when they named none."),
  })
  .meta({
    example: {
      ingredients: [
        { name: "Tomates", emoji: "🍅", quantity: 3, unit: "UNITS", category: "VEGETABLES", storage: "FRIDGE", expiresOn: null, shelfLifeDays: 6, heard: "tres tomates" },
        { name: "Leche", emoji: "🥛", quantity: 1, unit: "LITERS", category: "DAIRY", storage: "FRIDGE", expiresOn: "2026-10-09", shelfLifeDays: 7, heard: "un litro de leche que vence el viernes" },
        { name: "Arroz", emoji: "🍚", quantity: 500, unit: "GRAMS", category: "PANTRY_STAPLES", storage: "PANTRY", expiresOn: null, shelfLifeDays: 365, heard: "medio kilo de arroz" },
      ],
    },
  });

/** What the model is asked to produce from dictated text; the strict [ExtractResultSchema] is applied afterwards. */
export const ExtractOutputSchema = z.object({
  ingredients: z.array(
    z.object({
      name: z.string(),
      emoji: z.string(),
      quantity: z.number(),
      unit: z.enum(UNITS),
      category: z.enum(CATEGORIES),
      storage: z.enum(STORAGES),
      expiresOn: z.string().nullable(),
      shelfLifeDays: z.number().int(),
      heard: z.string(),
    }),
  ),
});

// --- Shared --------------------------------------------------------------------------------------

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().describe("Stable machine-readable error code."),
    message: z.string().describe("Safe, human-readable message. Never contains upstream or internal details."),
  }),
});

/** The same envelope with a per-status description and a realistic example, so each error response is documented on its own. */
export const errorResponse = (description: string, example: { code: string; message: string }) =>
  ErrorEnvelopeSchema.describe(description).meta({ example: { error: example } });

export const HealthSchema = z.object({ status: z.literal("ok") });

export type Ingredient = z.infer<typeof IngredientSchema>;
export type GenerateRecipeRequest = z.infer<typeof GenerateRecipeRequestSchema>;
export type Recipe = z.infer<typeof RecipeSchema>;
export type RecipeIngredient = z.infer<typeof RecipeIngredientSchema>;
export type ScanRequest = z.infer<typeof ScanRequestSchema>;
export type ScanVideoRequest = z.infer<typeof ScanVideoRequestSchema>;
export type ScannedIngredient = z.infer<typeof ScannedIngredientSchema>;
export type Suggestion = z.infer<typeof SuggestionSchema>;
export type ExtractedIngredient = z.infer<typeof ExtractedIngredientSchema>;
