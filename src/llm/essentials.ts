import type { Language } from "../schema.js";

/**
 * Basic essentials a recipe may use without them being in the pantry: salt, pepper, water and cooking oil. The model
 * writes the recipe in the user's language, so each language's own words are accepted too ("sal", "Pfeffer", "huile
 * d'olive"). This is matching vocabulary for the ingredients-only check, not text the user reads.
 */
export const ESSENTIALS_BY_LANGUAGE: Record<Language, readonly string[]> = {
  en: ["salt", "pepper", "black pepper", "water", "cooking oil", "oil", "vegetable oil", "olive oil", "sunflower oil"],
  es: [
    "sal", "pimienta", "pimienta negra", "agua", "aceite", "aceite de cocina", "aceite vegetal", "aceite de oliva",
    "aceite de girasol",
  ],
  pt: [
    "sal", "pimenta", "pimenta preta", "pimenta do reino", "pimenta-do-reino", "agua", "água", "oleo", "óleo",
    "oleo de cozinha", "óleo de cozinha", "oleo vegetal", "óleo vegetal", "azeite", "azeite de oliva", "oleo de girassol",
    "óleo de girassol",
  ],
  it: [
    "sale", "pepe", "pepe nero", "acqua", "olio", "olio da cucina", "olio vegetale", "olio d'oliva", "olio di oliva",
    "olio extravergine d'oliva", "olio di semi", "olio di girasole",
  ],
  fr: [
    "sel", "poivre", "poivre noir", "eau", "huile", "huile de cuisson", "huile végétale", "huile d'olive",
    "huile de tournesol",
  ],
  de: [
    "salz", "pfeffer", "schwarzer pfeffer", "wasser", "öl", "speiseöl", "pflanzenöl", "olivenöl", "sonnenblumenöl",
    "bratöl",
  ],
};

/** Every language's essentials: an entry is allowed if it is an essential in any of them. */
export const PANTRY_ESSENTIALS: readonly string[] = Object.values(ESSENTIALS_BY_LANGUAGE).flat();
