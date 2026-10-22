import { describe, expect, it } from "vitest";
import {
  convertQuantity,
  findOverusedIngredients,
  trimToPantry,
  findUnlistedIngredients,
  isEssential,
  matchPantryIngredient,
} from "../src/llm/ingredientMatcher.js";
import { ingredient } from "./helpers.js";

const pantry = [
  ingredient({ name: "Milk" }),
  ingredient({ name: "Cherry Tomatoes" }),
  ingredient({ name: "Eggs" }),
  ingredient({ name: "Jalapeño" }),
  ingredient({ name: "Strawberries" }),
];

describe("findUnlistedIngredients", () => {
  it("accepts names exactly as listed", () => {
    expect(findUnlistedIngredients(["Milk", "Eggs", "Cherry Tomatoes"], pantry)).toEqual([]);
  });

  it("ignores case and punctuation", () => {
    expect(findUnlistedIngredients(["MILK", "eggs.", "cherry-tomatoes"], pantry)).toEqual([]);
  });

  it("accepts singular/plural variations", () => {
    expect(findUnlistedIngredients(["Egg", "Tomato", "Strawberry"], pantry)).toEqual([]);
  });

  it("accepts a descriptive variation of a pantry name", () => {
    expect(findUnlistedIngredients(["Whole Milk", "Tomatoes"], pantry)).toEqual([]);
  });

  it("ignores accents", () => {
    expect(findUnlistedIngredients(["Jalapeno"], pantry)).toEqual([]);
  });

  it("allows the basic essentials", () => {
    expect(findUnlistedIngredients(["Salt", "Black Pepper", "Water", "Cooking Oil", "Olive oil"], pantry)).toEqual([]);
  });

  it("judges combined entries part by part", () => {
    expect(findUnlistedIngredients(["Salt and pepper", "Milk, Eggs"], pantry)).toEqual([]);
    expect(findUnlistedIngredients(["Salt and garlic"], pantry)).toEqual(["Salt and garlic"]);
  });

  it("flags ingredients that are not in the pantry", () => {
    expect(findUnlistedIngredients(["Milk", "Chicken", "Garlic"], pantry)).toEqual(["Chicken", "Garlic"]);
  });

  it("does not accept a substring that is only part of a word", () => {
    // 'ham' appears inside 'hamburger'/'chamomile' but is a different ingredient to 'milk'.
    expect(findUnlistedIngredients(["Hamburger"], pantry)).toEqual(["Hamburger"]);
  });

  it("flags an empty pantry match", () => {
    expect(findUnlistedIngredients(["Milk"], [])).toEqual(["Milk"]);
  });
});

describe("matchPantryIngredient", () => {
  it("returns the pantry item a recipe entry refers to", () => {
    expect(matchPantryIngredient("tomato", pantry)?.name).toBe("Cherry Tomatoes");
    expect(matchPantryIngredient("WHOLE MILK", pantry)?.name).toBe("Milk");
    expect(matchPantryIngredient("jalapeno", pantry)?.name).toBe("Jalapeño");
  });

  it("returns undefined for something that is not in the pantry", () => {
    expect(matchPantryIngredient("Chicken", pantry)).toBeUndefined();
    expect(matchPantryIngredient("", pantry)).toBeUndefined();
  });
});

describe("isEssential", () => {
  it("knows the basic essentials, however they are phrased", () => {
    for (const name of ["Salt", "black pepper", "Cooking Oil", "olive oil", "Water", "Sunflower oil"]) {
      expect(isEssential(name), name).toBe(true);
    }
    expect(isEssential("Garlic")).toBe(false);
  });
});

describe("convertQuantity", () => {
  it("converts within a family of units", () => {
    expect(convertQuantity(1500, "GRAMS", "KILOGRAMS")).toBe(1.5);
    expect(convertQuantity(2, "KILOGRAMS", "GRAMS")).toBe(2000);
    expect(convertQuantity(250, "MILLILITERS", "LITERS")).toBe(0.25);
    expect(convertQuantity(3, "UNITS", "UNITS")).toBe(3);
  });

  it("refuses to compare different kinds of unit", () => {
    expect(convertQuantity(1, "GRAMS", "LITERS")).toBeNull();
    expect(convertQuantity(1, "UNITS", "GRAMS")).toBeNull();
    expect(convertQuantity(1, "GRAMS", "CUPS")).toBeNull();
  });
});

describe("findOverusedIngredients", () => {
  const stock = [
    ingredient({ name: "Milk", quantity: 1, unit: "LITERS" }),
    ingredient({ name: "Eggs", quantity: 6, unit: "UNITS" }),
    ingredient({ name: "Flour", quantity: 500, unit: "GRAMS" }),
  ];
  const entry = (name: string, quantity: number | null, unit: "GRAMS" | "KILOGRAMS" | "MILLILITERS" | "LITERS" | "UNITS" | null) => ({
    name,
    amount: "x",
    quantity,
    unit,
  });

  it("is empty when everything fits", () => {
    expect(findOverusedIngredients([entry("Eggs", 4, "UNITS"), entry("Milk", 200, "MILLILITERS")], stock)).toEqual([]);
  });

  it("flags using more than the pantry holds", () => {
    expect(findOverusedIngredients([entry("Eggs", 7, "UNITS")], stock)).toEqual(["Eggs"]);
  });

  it("compares across compatible units", () => {
    expect(findOverusedIngredients([entry("Flour", 0.6, "KILOGRAMS")], stock)).toEqual(["Flour"]);
    expect(findOverusedIngredients([entry("Flour", 0.5, "KILOGRAMS")], stock)).toEqual([]);
    expect(findOverusedIngredients([entry("Milk", 1200, "MILLILITERS")], stock)).toEqual(["Milk"]);
  });

  it("allows exactly the available amount, with a hair of rounding tolerance", () => {
    expect(findOverusedIngredients([entry("Flour", 500, "GRAMS")], stock)).toEqual([]);
    expect(findOverusedIngredients([entry("Flour", 500.4, "GRAMS")], stock)).toEqual([]);
    expect(findOverusedIngredients([entry("Flour", 502, "GRAMS")], stock)).toEqual(["Flour"]);
  });

  it("ignores entries without an amount, essentials and things it cannot compare", () => {
    expect(
      findOverusedIngredients(
        [entry("Salt", null, null), entry("Cooking oil", 999, "MILLILITERS"), entry("Milk", 50, "UNITS"), entry("Chicken", 9999, "GRAMS")],
        stock,
      ),
    ).toEqual([]);
  });

  it("counts every lot of a product, as the model sees them all", () => {
    const twoLots = [...stock, ingredient({ name: "Milk", quantity: 1, unit: "LITERS" }), ingredient({ name: "Whole milk", quantity: 500, unit: "MILLILITERS" })];
    expect(findOverusedIngredients([entry("milk", 2.5, "LITERS")], twoLots)).toEqual([]);
    expect(findOverusedIngredients([entry("milk", 2.6, "LITERS")], twoLots)).toEqual(["Milk"]);
  });

  it("adds up a product listed twice in the recipe", () => {
    expect(findOverusedIngredients([entry("Eggs", 4, "UNITS"), entry("eggs", 3, "UNITS")], stock)).toEqual(["Eggs"]);
    expect(findOverusedIngredients([entry("Eggs", 4, "UNITS"), entry("eggs", 2, "UNITS")], stock)).toEqual([]);
  });

  it("reports each over-used ingredient once, by its pantry name", () => {
    expect(findOverusedIngredients([entry("whole milk", 2, "LITERS"), entry("eggs", 10, "UNITS")], stock)).toEqual(["Milk", "Eggs"]);
  });
});

describe("trimToPantry", () => {
  const stock = [ingredient({ name: "Eggs", quantity: 6, unit: "UNITS" }), ingredient({ name: "Flour", quantity: 500, unit: "GRAMS" })];
  const entry = (name: string, quantity: number, unit: "GRAMS" | "KILOGRAMS" | "UNITS", amount = "x") => ({ name, amount, quantity, unit });

  it("brings an over-used product down to what there is and rewrites its amount", () => {
    const { ingredients, trimmed } = trimToPantry([entry("Flour", 0.6, "KILOGRAMS", "600 g"), entry("Eggs", 2, "UNITS", "2")], stock)!;
    expect(trimmed).toEqual(["Flour"]);
    expect(ingredients[0]).toMatchObject({ quantity: 0.5, unit: "KILOGRAMS", amount: "0.5 kg" });
    expect(ingredients[1]).toMatchObject({ quantity: 2, amount: "2" });
    expect(findOverusedIngredients(ingredients, stock)).toEqual([]);
  });

  it("shares what there is between the entries of one product", () => {
    const { ingredients } = trimToPantry([entry("Eggs", 5, "UNITS"), entry("eggs", 2.5, "UNITS")], stock)!;
    expect(ingredients.map((e) => e.quantity)).toEqual([4, 2]);
    expect(findOverusedIngredients(ingredients, stock)).toEqual([]);
  });

  it("does not lose a hundredth to floating point", () => {
    // 2.32 × (2.3 / 2.32) is 2.2999999999999998 in floating point.
    const rice = [ingredient({ name: "Rice", quantity: 2.3, unit: "KILOGRAMS" })];
    const { ingredients } = trimToPantry([entry("Rice", 2.32, "KILOGRAMS")], rice)!;
    expect(ingredients[0]).toMatchObject({ quantity: 2.3, amount: "2.3 kg" });
  });

  it("will not trim more than a quarter over what there is: the steps would no longer match", () => {
    expect(trimToPantry([entry("Eggs", 12, "UNITS")], stock)).toBeUndefined();
    expect(trimToPantry([entry("Eggs", 6, "UNITS"), entry("Flour", 900, "GRAMS")], stock)).toBeUndefined();
    expect(trimToPantry([entry("Eggs", 7.5, "UNITS")], stock)).toBeDefined();
  });
});

