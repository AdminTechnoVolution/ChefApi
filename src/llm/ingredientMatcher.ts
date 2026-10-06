import type { Ingredient, RecipeIngredient } from "../schema.js";
import { PANTRY_ESSENTIALS } from "./essentials.js";

/**
 * Enforces the product's core promise after generation: every ingredient of a recipe must be a pantry
 * ingredient (or a basic essential), and no more of it may be used than the pantry holds. Matching is
 * deliberately tolerant of what an LLM naturally does with names (case, plurals, "whole milk" for "milk")
 * but not of genuinely new ingredients.
 */

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("oes")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function tokens(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((token) => token.length > 0)
    .map(singular);
}

const ESSENTIAL_TOKEN_SETS = PANTRY_ESSENTIALS.map((essential) => tokens(essential).join(" "));

export function isEssential(name: string): boolean {
  return ESSENTIAL_TOKEN_SETS.includes(tokens(name).join(" "));
}

function matchesPantryItem(used: string[], pantry: string[]): boolean {
  if (used.length === 0 || pantry.length === 0) return false;
  // "milk" vs "whole milk": one token set contains the other.
  return pantry.every((token) => used.includes(token)) || used.every((token) => pantry.includes(token));
}

/** The pantry ingredient a recipe entry refers to, or undefined when it names something else. */
export function matchPantryIngredient(name: string, pantry: Ingredient[]): Ingredient | undefined {
  const wanted = tokens(name);
  return pantry.find((item) => matchesPantryItem(wanted, tokens(item.name)));
}

/** Entries that are neither a pantry ingredient nor a basic essential. Empty means the recipe is compliant. */
export function findUnlistedIngredients(ingredientsUsed: string[], pantry: Ingredient[]): string[] {
  return ingredientsUsed.filter((entry) => {
    // "salt and pepper" / "sal y pimienta" / "Salz und Pfeffer": judge every part on its own.
    const parts = entry.split(/,|&|\+|\/|\b(?:and|y|e|et|und)\b/i).map((part) => part.trim()).filter(Boolean);
    const candidates = parts.length > 0 ? parts : [entry];

    return candidates.some((part) => !isEssential(part) && !matchPantryIngredient(part, pantry));
  });
}

// --- Quantities -----------------------------------------------------------------------------------

/** How many of the base unit (grams, millilitres, pieces) one of each unit is. */
const BASE_FACTOR: Record<string, { base: "mass" | "volume" | "count"; factor: number }> = {
  GRAMS: { base: "mass", factor: 1 },
  KILOGRAMS: { base: "mass", factor: 1000 },
  MILLILITERS: { base: "volume", factor: 1 },
  LITERS: { base: "volume", factor: 1000 },
  UNITS: { base: "count", factor: 1 },
};

/** Converts [quantity] between compatible units (g/kg, ml/l, pieces); null when they cannot be compared. */
export function convertQuantity(quantity: number, from: string, to: string): number | null {
  const source = BASE_FACTOR[from];
  const target = BASE_FACTOR[to];
  if (!source || !target || source.base !== target.base) return null;
  return (quantity * source.factor) / target.factor;
}

/** Tolerance so rounding ("0.3 kg" of 300 g) never counts as overuse. */
const OVERUSE_TOLERANCE = 1.001;

/** Names of pantry ingredients the recipe uses in a larger amount than the pantry holds. */
export function findOverusedIngredients(used: RecipeIngredient[], pantry: Ingredient[]): string[] {
  const overused: string[] = [];

  for (const entry of used) {
    if (entry.quantity === null || entry.unit === null) continue;
    const item = matchPantryIngredient(entry.name, pantry);
    if (!item) continue;

    const inPantryUnit = convertQuantity(entry.quantity, entry.unit, item.unit);
    if (inPantryUnit === null) continue; // e.g. "2 units" of something stocked in grams: cannot judge
    if (inPantryUnit > item.quantity * OVERUSE_TOLERANCE) overused.push(item.name);
  }

  return overused;
}
