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

/** How much of a product the pantry holds across all its lots, in the unit of the first lot (where the product is named). */
interface PantryTotal {
  item: Ingredient;
  quantity: number;
}

/** Every lot of the product [name] names, added up: two packs of eggs are one stock of eggs, as the model sees both lines. */
function pantryTotal(name: string, pantry: Ingredient[]): PantryTotal | undefined {
  const item = matchPantryIngredient(name, pantry);
  if (!item) return undefined;
  const wanted = tokens(name);
  const quantity = pantry
    .filter((lot) => matchesPantryItem(wanted, tokens(lot.name)))
    .reduce((sum, lot) => sum + (convertQuantity(lot.quantity, lot.unit, item.unit) ?? 0), 0);
  return { item, quantity };
}

/** What the recipe takes of each pantry product, its entries added up (the model may list eggs for the dough and for the glaze). */
function usageByProduct(used: RecipeIngredient[], pantry: Ingredient[]): Map<Ingredient, { total: PantryTotal; used: number; entries: number[] }> {
  const usage = new Map<Ingredient, { total: PantryTotal; used: number; entries: number[] }>();
  used.forEach((entry, index) => {
    if (entry.quantity === null || entry.unit === null) return;
    const total = pantryTotal(entry.name, pantry);
    if (!total) return;
    const inPantryUnit = convertQuantity(entry.quantity, entry.unit, total.item.unit);
    if (inPantryUnit === null) return; // e.g. "2 units" of something stocked in grams: cannot judge
    const current = usage.get(total.item) ?? { total, used: 0, entries: [] };
    current.used += inPantryUnit;
    current.entries.push(index);
    usage.set(total.item, current);
  });
  return usage;
}

/** Names of pantry ingredients the recipe uses in a larger amount than the pantry holds. */
export function findOverusedIngredients(used: RecipeIngredient[], pantry: Ingredient[]): string[] {
  const overused: string[] = [];
  for (const [item, { total, used: amount }] of usageByProduct(used, pantry)) {
    if (amount > total.quantity * OVERUSE_TOLERANCE) overused.push(item.name);
  }
  return overused;
}

const AMOUNT_LABEL: Record<string, string> = { GRAMS: "g", KILOGRAMS: "kg", MILLILITERS: "ml", LITERS: "l", UNITS: "" };

/** At most this much over what the pantry holds is trimmed: 1200 ml from 1 l still cooks the same dish, 12 eggs from 6 does not. */
const MAX_TRIM_RATIO = 1.25;

/**
 * The recipe with every over-used product brought down to what the pantry holds: its entries shrink in proportion, and their
 * amount text is rewritten to match. The last resort before refusing a recipe whose only fault is a little too much of something;
 * undefined when it is more than a little (its steps would no longer match the amounts).
 */
export function trimToPantry(used: RecipeIngredient[], pantry: Ingredient[]): { ingredients: RecipeIngredient[]; trimmed: string[] } | undefined {
  const ingredients = used.map((entry) => ({ ...entry }));
  const trimmed: string[] = [];
  for (const [item, { total, used: amount, entries }] of usageByProduct(used, pantry)) {
    if (amount <= total.quantity * OVERUSE_TOLERANCE || amount <= 0) continue;
    if (total.quantity <= 0 || amount > total.quantity * MAX_TRIM_RATIO) return undefined;
    const scale = total.quantity / amount;
    for (const index of entries) {
      const entry = ingredients[index]!;
      // Down to two decimals, so it never ends above what there is; the nudge keeps 49.999… (floating point) from becoming 49.
      const quantity = Math.floor((entry.quantity ?? 0) * scale * 100 + 1e-6) / 100;
      entry.quantity = quantity;
      const label = AMOUNT_LABEL[entry.unit ?? ""] ?? "";
      entry.amount = label ? `${quantity} ${label}` : `${quantity}`;
    }
    trimmed.push(item.name);
  }
  return { ingredients, trimmed };
}
