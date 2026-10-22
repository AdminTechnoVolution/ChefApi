import { MAX_RECENT_RECIPES } from "../schema.js";
import { sanitizeInline } from "./prompt.js";

/**
 * Ways to cook a pantry, in no particular order. Every request hands them to the model freshly shuffled, so the same ingredients
 * do not keep landing on the same default dish (meat and potatoes would otherwise be a stew every time).
 */
export const COOKING_STYLES = [
  "oven-baked or roasted",
  "pan-seared, with a quick pan sauce",
  "stir-fried or sautéed in a skillet",
  "grilled, broiled or on skewers",
  "soup or broth",
  "stew or braise",
  "crispy hash or skillet",
  "patties, croquettes or fritters (pan-fried or baked)",
  "omelette, frittata or scrambled eggs",
  "warm or cold salad",
  "gratin or casserole",
  "stuffed (vegetables, potatoes or wraps)",
  "mash or purée with a topping",
  "rice, pasta or grain dish",
  "tacos, wraps, sandwiches or toasts",
  "steamed or poached",
] as const;

const MAX_RECENT_TITLE_CHARS = 100;

/** A fresh order of [COOKING_STYLES] (Fisher-Yates). `random` returns [0, 1), like Math.random. */
export function shuffledCookingStyles(random: () => number = Math.random): string[] {
  const styles: string[] = [...COOKING_STYLES];
  for (let i = styles.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [styles[i], styles[j]] = [styles[j]!, styles[i]!];
  }
  return styles;
}

/** The titles the app sent, one line each, without blanks or repeats, the newest first, at most [MAX_RECENT_RECIPES]. */
export function tidyRecentRecipes(titles: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const tidy: string[] = [];
  for (const title of titles) {
    const clean = sanitizeInline(title, MAX_RECENT_TITLE_CHARS);
    const key = clean.toLowerCase();
    if (clean === "" || seen.has(key)) continue;
    seen.add(key);
    tidy.push(clean);
    if (tidy.length === MAX_RECENT_RECIPES) break;
  }
  return tidy;
}

/**
 * Kinds of dish that keep coming back under another name ("guiso" or "estofado", "stew" or "braise"), in the app's languages.
 * Two recipes of the same kind that share a main ingredient are the same dish to the user.
 */
const DISH_KINDS: Record<string, readonly string[]> = {
  stew: [
    "guiso", "guisado", "guisada", "estofado", "sudado", "cocido", "carbonada", "stew", "braise", "braised", "ragout", "ragu",
    "goulash", "gulasch", "eintopf", "ensopado", "cozido", "picadinho", "spezzatino", "umido", "mijote", "daube",
  ],
  soup: [
    "sopa", "caldo", "consome", "sancocho", "ajiaco", "soup", "broth", "chowder", "potage", "soupe", "veloute", "zuppa",
    "minestra", "minestrone", "brodo", "suppe", "bruhe", "canja",
  ],
  salad: ["ensalada", "salad", "salada", "insalata", "salade", "salat"],
  eggs: ["omelette", "omelet", "omelete", "omelett", "frittata", "revuelto", "scramble", "scrambled", "ruhrei", "perico"],
  gratin: ["gratin", "gratinado", "gratinada", "gratinati", "casserole", "auflauf", "sformato"],
  stirFry: ["salteado", "saltado", "salteada", "stir", "wok", "refogado", "saltato", "saute", "sauteed", "poele"],
};

const KIND_OF_WORD = new Map(Object.entries(DISH_KINDS).flatMap(([kind, words]) => words.map((word) => [word, kind] as const)));

/** Little words that say nothing about the dish, in the app's languages. Words under three letters are dropped anyway. */
const FILLER = new Set([
  "con", "sin", "del", "los", "las", "una", "uno", "para", "and", "with", "the", "com", "dos", "das", "uma", "ao", "aos",
  "avec", "aux", "des", "les", "pour", "sur", "alla", "allo", "alle", "della", "dello", "delle", "und", "mit", "der", "die",
  "dem", "den", "vom", "style", "estilo", "facil", "easy", "rapido", "rapida", "quick", "casero", "casera", "homemade",
]);

/** Lower case, no accents, the dish words only, a plural "s" dropped so "papas" and "papa" are one word. */
function dishWords(title: string): string[] {
  return title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !FILLER.has(word))
    .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word));
}

/**
 * The recent recipe that [title] repeats, if any: nearly the same name (three in four dish words shared), or the same kind of
 * dish (a stew after a stew) with a main ingredient in common. Best effort on titles alone; the prompt is what asks for variety.
 */
export function findRepeatedRecipe(title: string, recent: readonly string[]): string | undefined {
  const words = new Set(dishWords(title));
  if (words.size === 0) return undefined;
  const kinds = new Set([...words].flatMap((word) => KIND_OF_WORD.get(word) ?? []));
  return recent.find((previous) => {
    const before = new Set(dishWords(previous));
    const shared = [...words].filter((word) => before.has(word));
    const union = new Set([...words, ...before]).size;
    if (shared.length > 0 && shared.length / union >= 0.75) return true;
    const sameKind = [...before].some((word) => {
      const kind = KIND_OF_WORD.get(word);
      return kind !== undefined && kinds.has(kind);
    });
    return sameKind && shared.some((word) => !KIND_OF_WORD.has(word));
  });
}
