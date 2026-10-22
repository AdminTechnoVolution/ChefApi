const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const pictographic = /\p{Extended_Pictographic}/u;

/**
 * The first emoji in [value], or "" when there is none. The model is asked for exactly one, but this keeps a stray
 * sentence, a word or a doubled emoji from ever reaching a screen.
 */
export function firstEmoji(value: unknown): string {
  if (typeof value !== "string") return "";
  for (const { segment } of graphemes.segment(value.trim())) {
    if (pictographic.test(segment)) return segment;
  }
  return "";
}

/**
 * How a food's emoji is chosen, the same in every prompt that names foods (suggestions, photos, videos, dictation, Mero). Unicode
 * has no emoji for many foods, and a look-alike of another food is worse than none: without one the app shows the category's
 * icon, and the person can always pick one themselves.
 */
export const FOOD_EMOJI_RULE =
  '"emoji" is one emoji that shows this exact food, or "" when no emoji does. Many foods have none (papaya, green onion or ' +
  "scallion, leek, plantain, cassava, guava, passion fruit, yogurt): give them \"\", never the emoji of another food that looks " +
  "alike or is related. 🥭 is only a mango, 🍈 only a melon, 🧅 only a bulb onion, 🍌 only a banana, 🍋 only a lemon (not a lime), " +
  "🌶️ only a chili pepper (a bell pepper is 🫑), 🥬 only leafy greens such as lettuce, cabbage or chard. An emoji for the kind of " +
  "thing is right only when the item is that thing: 🥩 for a cut of red meat, 🍗 for chicken, 🐟 for a fish, 🌿 for a fresh herb " +
  "such as cilantro or parsley, 🧀 for a cheese, 🥫 for a canned food, 🧃 for a juice.";
