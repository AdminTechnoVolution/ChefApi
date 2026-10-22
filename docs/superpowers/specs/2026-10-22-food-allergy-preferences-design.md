# Food Allergy Preferences and Ingredient Warnings

## Goal

Let a signed-in user choose common food allergens and make that choice affect recipe generation and ingredient intake across Chef Android and iOS. A recipe must not recommend a selected allergen. When an ingredient the user is adding is recognized as a selected allergen, Chef must warn before saving it.

## Agreed scope

- Use a fixed, localized catalog of 14 common allergen groups with stable IDs shared by the API, Android, and iOS.
- Save selections to the user's Chef account so the preference is consistent across devices. The account deletion flow removes it with the user record.
- Place the allergy selector beside dietary preferences in the Recipes tab.
- For recipes, exclude matching pantry items, instruct the model to avoid selected allergens, and validate the response. Retry a noncompliant response once; if it still contains a selected allergen, return no recipe.
- For photo, video, and dictation results, identify matches before the user saves detected ingredients. For manual entry, check the ingredient name before saving.
- Show the matched ingredient and allergen and let the user cancel or confirm saving.
- Match the name of the recognized food against known aliases in the app's supported languages. Do not claim to inspect product labels, hidden components, or cross-contact.
- Preserve the existing uncommitted Android and iOS changes while implementing this feature.

## Allergen catalog and matching

The catalog uses stable IDs for peanuts, tree nuts, milk, eggs, fish, crustaceans, molluscs, soy, wheat/gluten, sesame, mustard, celery, lupin, and sulfites. Each ID has a translated display label in English, Spanish, Portuguese, Italian, French, and German.

The API owns the canonical alias table and matching policy. Matching normalizes case, Unicode accents, and whitespace and uses whole-word/phrase boundaries so unrelated words such as "eggplant" do not match "egg". Aliases cover the food names used by the supported locales. Ambiguous or unknown names do not produce a positive warning. The mobile clients use the same catalog and matching rules for manual ingredient entry, including offline use.

## Account and API behavior

Add authenticated `GET /v1/account/allergies` and `PUT /v1/account/allergies` routes. The response and request contain an `allergens` array of stable catalog IDs. Missing data on an older account means an empty selection. Validate IDs strictly, deduplicate selections, and persist the field on the existing account user record. Do not include allergy preferences or ingredient names in logs.

Recipe generation reads the authenticated user's saved selection server-side; the mobile recipe request does not carry an authoritative allergy list. The recipe policy removes matching pantry ingredients before model input and places the allergy rule above client-provided prompt text. Validate returned recipe text and ingredient lists against the selected aliases. Retry once with violation feedback; if the retry is still noncompliant, fail closed and return the existing recipe-refused error rather than returning a potentially unsafe recipe. This applies to pantry recipes and requested-dish recipes, including their shopping lists.

Photo, video, and dictation endpoints add an `allergenMatches` array to each detected ingredient, containing only selected allergen IDs that matched its name. The apps render those matches in the review/add flow before saving. For manual entry, the apps apply the same alias matcher before persisting an ingredient. Legacy app-key requests without a user profile have no saved allergy selection and return no matches.

## App behavior

Android and iOS show an expandable allergy selector beside the existing diet selector. On sign-in and when opening the selector, the apps read the account preference; changes are saved through the API. Recipe generation waits for the current selection to be available, while the API remains authoritative.

On a positive ingredient match, show a localized confirmation identifying both the ingredient and the matching allergy. Cancel leaves the ingredient unsaved; confirm continues the existing save flow. Apply the warning to photo scans, video scans, dictation, and manual ingredient entry. Keep unrelated ingredient review behavior unchanged.

## Failure handling and privacy

- Invalid catalog IDs are rejected by the API.
- If saving a changed allergy selection fails, keep the previous confirmed value visible and explain that the preference was not saved.
- If recipe safety validation cannot establish compliance after its retry, return an error rather than a recipe.
- Allergy preferences and match details are account data; do not log them. Account deletion removes them as part of deleting the user document.
- A warning only reflects a recognized ingredient name. It does not establish the full composition or safety of a packaged product.

## Acceptance checks

- A user can select, clear, reload, and sync allergy IDs across Android and iOS.
- Unknown IDs cannot be stored.
- A pantry ingredient matching a selected allergy is not sent to the recipe model.
- A generated recipe or shopping list containing a selected allergen is retried and never returned if still noncompliant.
- Photo, video, and dictation results identify selected allergen matches; manual entry warns before saving the same matches.
- An ingredient name with an unrelated substring does not trigger a false positive.
- With no selected allergies, recipe generation and ingredient intake retain their existing behavior.
- Existing account deletion removes the stored selection.

## Implementation boundaries

The change spans the ChefApi, ChefAndroid, and ChefIOS repositories. The API owns account persistence, the canonical catalog and recipe enforcement. Both apps provide translated settings and warnings and keep their manual-entry matcher aligned with the canonical aliases. No product-label OCR or cross-contact detection is included.
