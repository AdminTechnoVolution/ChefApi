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
