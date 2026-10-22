/** Stable account/API IDs. Display labels are never used as the matching policy. */
export const ALLERGEN_IDS = [
  "peanuts", "tree_nuts", "milk", "eggs", "fish", "crustaceans", "molluscs",
  "soy", "wheat_gluten", "sesame", "mustard", "celery", "lupin", "sulfites",
] as const;

export type AllergenId = (typeof ALLERGEN_IDS)[number];
type Labels = Record<"en" | "es" | "pt" | "it" | "fr" | "de", string>;

/** Explicit food-name aliases across the six supported locales; no inference about hidden ingredients. */
export const ALLERGEN_CATALOG: Record<AllergenId, { labels: Labels; aliases: readonly string[] }> = {
  peanuts: {
    labels: { en: "Peanuts", es: "Cacahuetes", pt: "Amendoim", it: "Arachidi", fr: "Arachides", de: "Erdnüsse" },
    aliases: ["peanut", "peanuts", "groundnut", "groundnuts", "cacahuete", "cacahuetes", "cacahuate", "cacahuates", "maní", "maníes", "mani", "amendoim", "amendoins", "arachide", "arachidi", "arachides", "cacahuète", "cacahuètes", "erdnuss", "erdnüsse", "erdnussbutter"],
  },
  tree_nuts: {
    labels: { en: "Tree nuts", es: "Frutos de cáscara", pt: "Frutos de casca rija", it: "Frutta a guscio", fr: "Fruits à coque", de: "Schalenfrüchte" },
    aliases: ["tree nut", "tree nuts", "almond", "almonds", "walnut", "walnuts", "cashew", "cashews", "hazelnut", "hazelnuts", "pistachio", "pistachios", "pecan", "pecans", "brazil nut", "brazil nuts", "macadamia", "macadamias", "almendra", "almendras", "nuez", "nueces", "anacardo", "anacardos", "avellana", "avellanas", "pistacho", "pistachos", "amêndoa", "amêndoas", "noz", "nozes", "castanha de caju", "castanhas de caju", "avelã", "avelãs", "pistache", "pistaches", "mandorla", "mandorle", "noce", "noci", "anacardi", "nocciola", "nocciole", "pistacchio", "pistacchi", "amande", "amandes", "noix", "noix de cajou", "noisette", "noisettes", "pistaches", "mandel", "mandeln", "walnuss", "walnüsse", "haselnuss", "haselnüsse", "cashewnuss", "cashewnüsse", "pistazie", "pistazien", "paranuss", "paranüsse"],
  },
  milk: {
    labels: { en: "Milk", es: "Leche", pt: "Leite", it: "Latte", fr: "Lait", de: "Milch" },
    aliases: ["milk", "butter", "cheese", "cream", "yogurt", "yoghurt", "whey", "casein", "leche", "mantequilla", "queso", "nata", "yogur", "suero de leche", "caseína", "leite", "manteiga", "queijo", "creme de leite", "iogurte", "soro de leite", "latte", "burro", "formaggio", "panna", "siero di latte", "caseina", "lait", "beurre", "fromage", "crème", "yaourt", "lactosérum", "caséine", "milch", "käse", "sahne", "joghurt", "molke", "kasein"],
  },
  eggs: {
    labels: { en: "Eggs", es: "Huevos", pt: "Ovos", it: "Uova", fr: "Œufs", de: "Eier" },
    aliases: ["egg", "eggs", "huevo", "huevos", "ovo", "ovos", "uovo", "uova", "œuf", "œufs", "oeuf", "oeufs", "ei", "eier", "eigelb", "egg yolk", "egg white", "yema de huevo", "clara de huevo", "gema de ovo", "clara de ovo", "tuorlo", "albume", "jaune d'œuf", "blanc d'œuf"],
  },
  fish: {
    labels: { en: "Fish", es: "Pescado", pt: "Peixe", it: "Pesce", fr: "Poisson", de: "Fisch" },
    aliases: ["fish", "salmon", "tuna", "cod", "anchovy", "anchovies", "sardine", "sardines", "trout", "haddock", "mackerel", "pescado", "salmón", "atún", "bacalao", "anchoa", "anchoas", "sardina", "sardinas", "trucha", "caballa", "peixe", "salmão", "atum", "bacalhau", "anchova", "anchovas", "truta", "cavala", "pesce", "salmone", "tonno", "merluzzo", "acciuga", "acciughe", "trota", "sgombro", "poisson", "saumon", "thon", "cabillaud", "morue", "anchois", "truite", "maquereau", "fisch", "lachs", "thunfisch", "kabeljau", "sardelle", "sardellen", "forelle", "makrele"],
  },
  crustaceans: {
    labels: { en: "Crustaceans", es: "Crustáceos", pt: "Crustáceos", it: "Crostacei", fr: "Crustacés", de: "Krebstiere" },
    aliases: ["crustacean", "crustaceans", "shrimp", "shrimps", "prawn", "prawns", "crab", "crabs", "lobster", "lobsters", "crayfish", "crustáceo", "crustáceos", "camarón", "camarones", "gamba", "gambas", "langostino", "langostinos", "cangrejo", "langosta", "camarão", "camarões", "caranguejo", "lagosta", "crostacei", "gambero", "gamberi", "granchio", "aragosta", "astice", "crustacé", "crustacés", "crevette", "crevettes", "crabe", "homard", "écrevisse", "krebstiere", "garnele", "garnelen", "krabbe", "krabben", "hummer", "flusskrebs"],
  },
  molluscs: {
    labels: { en: "Molluscs", es: "Moluscos", pt: "Moluscos", it: "Molluschi", fr: "Mollusques", de: "Weichtiere" },
    aliases: ["mollusc", "molluscs", "mollusk", "mollusks", "clam", "clams", "mussel", "mussels", "oyster", "oysters", "scallop", "scallops", "squid", "octopus", "cuttlefish", "snail", "snails", "molusco", "moluscos", "almeja", "almejas", "mejillón", "mejillones", "ostra", "ostras", "vieira", "vieiras", "calamar", "calamares", "pulpo", "sepia", "caracol", "caracoles", "amêijoa", "amêijoas", "mexilhão", "mexilhões", "lula", "lulas", "polvo", "choco", "caracóis", "molluschi", "vongola", "vongole", "cozza", "cozze", "ostrica", "ostriche", "capasanta", "calamaro", "calamari", "polpo", "seppia", "lumaca", "lumache", "mollusques", "palourde", "palourdes", "moule", "moules", "huître", "huîtres", "coquille saint jacques", "calmar", "poulpe", "seiche", "escargot", "escargots", "weichtiere", "muschel", "muscheln", "auster", "austern", "jakobsmuschel", "tintenfisch", "kalmar", "oktopus", "schnecke", "schnecken"],
  },
  soy: {
    labels: { en: "Soy", es: "Soja", pt: "Soja", it: "Soia", fr: "Soja", de: "Soja" },
    aliases: ["soy", "soya", "soybean", "soybeans", "soja", "soya", "soia", "sojabohne", "sojabohnen", "tofu", "tempeh", "edamame", "miso"],
  },
  wheat_gluten: {
    labels: { en: "Wheat / gluten", es: "Trigo / gluten", pt: "Trigo / glúten", it: "Grano / glutine", fr: "Blé / gluten", de: "Weizen / Gluten" },
    aliases: ["wheat", "gluten", "barley", "rye", "spelt", "semolina", "bulgur", "couscous", "seitan", "trigo", "cebada", "centeno", "espelta", "sémola", "cevada", "centeio", "glúten", "grano", "frumento", "glutine", "orzo", "segale", "farro", "semola", "blé", "orge", "seigle", "épeautre", "semoule", "weizen", "gerste", "roggen", "dinkel", "grieß", "griess"],
  },
  sesame: {
    labels: { en: "Sesame", es: "Sésamo", pt: "Sésamo", it: "Sesamo", fr: "Sésame", de: "Sesam" },
    aliases: ["sesame", "sésamo", "ajonjolí", "gergelim", "sesamo", "sésame", "sesam", "tahini", "tahina"],
  },
  mustard: {
    labels: { en: "Mustard", es: "Mostaza", pt: "Mostarda", it: "Senape", fr: "Moutarde", de: "Senf" },
    aliases: ["mustard", "mostaza", "mostarda", "senape", "moutarde", "senf"],
  },
  celery: {
    labels: { en: "Celery", es: "Apio", pt: "Aipo", it: "Sedano", fr: "Céleri", de: "Sellerie" },
    aliases: ["celery", "celeriac", "apio", "aipo", "salsão", "sedano", "céleri", "sellerie", "knollensellerie", "staudensellerie"],
  },
  lupin: {
    labels: { en: "Lupin", es: "Altramuces", pt: "Tremoços", it: "Lupini", fr: "Lupin", de: "Lupinen" },
    aliases: ["lupin", "lupins", "lupine", "lupines", "altramuz", "altramuces", "chocho", "chochos", "tremoço", "tremoços", "lupino", "lupini", "lupinen"],
  },
  sulfites: {
    labels: { en: "Sulfites", es: "Sulfitos", pt: "Sulfitos", it: "Solfiti", fr: "Sulfites", de: "Sulfite" },
    aliases: ["sulfite", "sulfites", "sulphite", "sulphites", "sulfito", "sulfitos", "solfito", "solfiti", "sulfit", "schwefeldioxid", "sulfur dioxide", "sulphur dioxide", "dióxido de azufre", "dióxido de enxofre", "anidride solforosa", "dioxyde de soufre"],
  },
};

/** Folding accents plus œ/ß keeps the policy consistent across supported scripts. */
export function normalizeAllergenName(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/œ/g, "oe").replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** The wire format has one deterministic, display-independent order. */
export function canonicalAllergens(selected: readonly AllergenId[]): AllergenId[] {
  return [...new Set(selected)].sort();
}

const normalizedAliases = Object.fromEntries(ALLERGEN_IDS.map(id => [
  id, [...new Set(ALLERGEN_CATALOG[id].aliases.map(normalizeAllergenName))],
])) as Record<AllergenId, string[]>;

export function allergenMatches(name: string, selected: readonly AllergenId[]): AllergenId[] {
  const normalized = ` ${normalizeAllergenName(name)} `;
  return canonicalAllergens(selected).filter(id => normalizedAliases[id].some(alias => normalized.includes(` ${alias} `)));
}
