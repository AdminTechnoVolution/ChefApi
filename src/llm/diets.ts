import type { Category, Diet, Ingredient } from "../schema.js";

/**
 * What each dietary requirement asks of a recipe, written for the model. These sit in the server's rules, so the app (or anything
 * typed in it) cannot soften them.
 */
export const DIET_RULES: Record<Diet, string> = {
  VEGETARIAN:
    "Vegetarian: no meat, poultry, fish or shellfish, nor anything made from them (stock, gelatin, lard, animal rennet). Eggs and dairy are allowed.",
  VEGAN:
    "Vegan: no animal products of any kind: no meat, poultry, fish, shellfish, eggs, dairy, honey or gelatin, nor anything made from them.",
  PESCATARIAN:
    "Pescatarian: no meat or poultry, nor stock, gelatin or lard made from them. Fish, shellfish, eggs and dairy are allowed.",
  GLUTEN_FREE:
    "Gluten-free: no wheat, barley, rye, spelt, semolina, couscous, regular pasta, bread, flour or breadcrumbs, nor anything made from them (soy sauce included). Rice, corn, potatoes, quinoa and legumes are fine.",
  DAIRY_FREE:
    "Dairy-free and lactose-free: no milk, cream, butter, cheese, yogurt or anything made from milk. Eggs are allowed.",
  EGG_FREE: "Egg-free: no eggs and nothing that contains them (mayonnaise, fresh pasta, most batters).",
  NUT_FREE:
    "Nut-free: no peanuts or tree nuts (almonds, walnuts, cashews, hazelnuts, pistachios and the like), nor their butters, oils or flours.",
  LOW_CARB:
    "Low-carb: about 25 g of net carbohydrate per serving or less; avoid grains, bread, pasta, rice, potatoes, sugar and sweet fruit, and favour protein, eggs, vegetables and healthy fats.",
  KETO:
    "Keto: very low carbohydrate (about 10 g net per serving or less), high in fat and moderate in protein; no grains, sugar, legumes, starchy vegetables or most fruit.",
  HALAL:
    "Halal: no pork or anything derived from it (bacon, ham, lard, gelatin), no alcohol in any form, and no meat unless it is explicitly halal.",
  KOSHER:
    "Kosher: no pork or shellfish, never meat and dairy in the same dish, and only fish that has fins and scales.",
};

/**
 * The pantry categories an eating style rules out, as a backstop to the model: a recipe that uses a pantry item of one of
 * these categories is rejected whatever the model says. Only the styles for which a category settles it are here: a
 * category cannot say whether something has gluten or nuts, so those requirements are left to the model.
 */
const EXCLUDED_CATEGORIES: Partial<Record<Diet, readonly Category[]>> = {
  VEGETARIAN: ["MEAT_POULTRY", "SEAFOOD"],
  VEGAN: ["MEAT_POULTRY", "SEAFOOD", "DAIRY"],
  PESCATARIAN: ["MEAT_POULTRY"],
};

/** Each requirement once, in the order the app lists them. */
export function uniqueDiets(diets: readonly Diet[]): Diet[] {
  return [...new Set(diets)];
}

export function dietAllowsCategory(diets: readonly Diet[], category: Category): boolean {
  return !diets.some((diet) => EXCLUDED_CATEGORIES[diet]?.includes(category));
}

/** The pantry without what the requested eating style rules out: the model never sees it, so it cannot use it. */
export function filterPantryForDiets(pantry: Ingredient[], diets: readonly Diet[]): Ingredient[] {
  return pantry.filter((ingredient) => dietAllowsCategory(diets, ingredient.category));
}
