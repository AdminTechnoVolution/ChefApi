import type { Category } from "../schema.js";

export interface FoodIconGroup {
  category: Category;
  emojis: readonly string[];
}

/**
 * The icons a person can give an ingredient by hand in the apps, one group per category in the order of `CATEGORIES`. The
 * apps hold no data about foods, so the list lives here and is served as it is by `GET /v1/ingredients/icons` (no model
 * call). The suggester and the scans send an emoji only when one shows that exact food; this is where the person picks one
 * when there is none (papaya, green onion) or it does not fit.
 */
export const FOOD_ICONS: readonly FoodIconGroup[] = [
  { category: "DAIRY", emojis: ["🥛", "🧀", "🧈", "🥚", "🍦", "🍨", "🍮"] },
  { category: "MEAT_POULTRY", emojis: ["🥩", "🍗", "🍖", "🥓", "🌭", "🍔"] },
  {
    category: "VEGETABLES",
    emojis: ["🍅", "🥕", "🌽", "🌶️", "🫑", "🥒", "🥬", "🥦", "🧄", "🧅", "🥔", "🍠", "🍆", "🥑", "🫛", "🫚", "🍄", "🌿", "🌱", "🫒"],
  },
  { category: "FRUITS", emojis: ["🍎", "🍏", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐", "🍈", "🍒", "🍑", "🥭", "🍍", "🥥", "🥝"] },
  { category: "PANTRY_STAPLES", emojis: ["🍚", "🍝", "🍜", "🌾", "🥫", "🫘", "🥜", "🌰", "🫙", "🧂", "🍯", "🫗", "🥣", "🍫", "🍬", "🍿"] },
  { category: "BAKERY", emojis: ["🍞", "🥖", "🥐", "🥯", "🫓", "🥨", "🧇", "🥞", "🍰", "🎂", "🧁", "🍪", "🍩", "🥧"] },
  { category: "SEAFOOD", emojis: ["🐟", "🍤", "🦐", "🦞", "🦀", "🦑", "🐙", "🦪", "🍣", "🍥"] },
  {
    category: "OTHER",
    emojis: [
      "🧃", "🥤", "🧋", "☕", "🍵", "🧉", "🍷", "🍺", "🧊", "💧", "🍕", "🌮", "🌯", "🫔", "🥪", "🥗", "🍲", "🥘", "🍳", "🥟",
      "🍱", "🍛", "🧆", "🥙", "🫕",
    ],
  },
];
