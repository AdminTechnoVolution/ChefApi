import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FOOD_ICONS } from "../src/icons/foodIcons.js";
import { CATEGORIES, FoodIconsResultSchema } from "../src/schema.js";
import { appWith, contractFixture, contractRecipe, StubGenerator } from "./helpers.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

describe("GET /v1/ingredients/icons", () => {
  it("returns exactly the shared contract, with no key or account", async () => {
    app = await appWith(StubGenerator.returning(contractRecipe()));

    const res = await app.inject({ method: "GET", url: "/v1/ingredients/icons" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(contractFixture("ingredient-icons-response.example.json"));
    expect(FoodIconsResultSchema.parse(res.json())).toEqual(res.json());
    expect(res.headers["cache-control"]).toBe("public, max-age=86400");
  });
});

describe("the food icons", () => {
  const all = FOOD_ICONS.flatMap((group) => group.emojis);

  it("have one group per category, in the order of the categories", () => {
    expect(FOOD_ICONS.map((group) => group.category)).toEqual([...CATEGORIES]);
    for (const group of FOOD_ICONS) expect(group.emojis.length).toBeGreaterThanOrEqual(5);
  });

  it("are each offered once, and each is a single emoji", () => {
    expect(new Set(all).size).toBe(all.length);
    for (const emoji of all) {
      expect([...graphemes.segment(emoji)], emoji).toHaveLength(1);
      expect(/\p{Extended_Pictographic}/u.test(emoji), emoji).toBe(true);
    }
  });

  it("include something close for the foods that have no emoji of their own", () => {
    // Papaya and green onion have none: the person may prefer a melon, a herb or a sprout to the category's icon.
    for (const emoji of ["🍈", "🌿", "🌱", "🥭", "🧅"]) expect(all).toContain(emoji);
  });
});
