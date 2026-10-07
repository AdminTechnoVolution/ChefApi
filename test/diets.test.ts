import { describe, expect, it } from "vitest";
import { DIET_RULES, dietAllowsCategory, filterPantryForDiets, uniqueDiets } from "../src/llm/diets.js";
import { CATEGORIES, DIETS, type Ingredient } from "../src/schema.js";

const item = (name: string, category: Ingredient["category"]): Ingredient => ({
  name,
  quantity: 1,
  unit: "UNITS",
  category,
  expirationTimestamp: 1_800_000_000_000,
});

const pantry = [
  item("Chicken", "MEAT_POULTRY"),
  item("Salmon", "SEAFOOD"),
  item("Milk", "DAIRY"),
  item("Spinach", "VEGETABLES"),
  item("Bread", "BAKERY"),
  item("Rice", "PANTRY_STAPLES"),
];

const names = (items: Ingredient[]) => items.map((entry) => entry.name);

describe("DIET_RULES", () => {
  it("says what every diet means, so none is left to the model's guess", () => {
    for (const diet of DIETS) expect(DIET_RULES[diet], diet).toMatch(/\S{3,}/);
  });
});

describe("filterPantryForDiets", () => {
  it("keeps everything when no diet is asked for", () => {
    expect(filterPantryForDiets(pantry, [])).toEqual(pantry);
  });

  it("vegetarian drops meat and seafood but keeps dairy", () => {
    expect(names(filterPantryForDiets(pantry, ["VEGETARIAN"]))).toEqual(["Milk", "Spinach", "Bread", "Rice"]);
  });

  it("vegan drops meat, seafood and dairy", () => {
    expect(names(filterPantryForDiets(pantry, ["VEGAN"]))).toEqual(["Spinach", "Bread", "Rice"]);
  });

  it("pescatarian drops meat only", () => {
    expect(names(filterPantryForDiets(pantry, ["PESCATARIAN"]))).toEqual(["Salmon", "Milk", "Spinach", "Bread", "Rice"]);
  });

  it("combines with the rest, which a category cannot settle and so leaves to the model", () => {
    expect(names(filterPantryForDiets(pantry, ["VEGETARIAN", "GLUTEN_FREE", "NUT_FREE", "HALAL"]))).toEqual([
      "Milk", "Spinach", "Bread", "Rice",
    ]);
  });

  it("applies the strictest of the diets asked for", () => {
    expect(names(filterPantryForDiets(pantry, ["VEGETARIAN", "VEGAN"]))).toEqual(["Spinach", "Bread", "Rice"]);
  });

  it("does not touch the list it was given", () => {
    const before = [...pantry];

    filterPantryForDiets(pantry, ["VEGAN"]);

    expect(pantry).toEqual(before);
  });
});

describe("dietAllowsCategory", () => {
  it("allows every category when there is no diet", () => {
    for (const category of CATEGORIES) expect(dietAllowsCategory([], category), category).toBe(true);
  });

  it("never rules out plants or staples, whatever the diet", () => {
    for (const diet of DIETS) {
      for (const category of ["VEGETABLES", "FRUITS", "PANTRY_STAPLES", "OTHER"] as const) {
        expect(dietAllowsCategory([diet], category), `${diet} ${category}`).toBe(true);
      }
    }
  });
});

describe("uniqueDiets", () => {
  it("lists each requirement once, in the order it first appeared", () => {
    expect(uniqueDiets(["VEGAN", "GLUTEN_FREE", "VEGAN", "KETO", "GLUTEN_FREE"])).toEqual(["VEGAN", "GLUTEN_FREE", "KETO"]);
  });
});
