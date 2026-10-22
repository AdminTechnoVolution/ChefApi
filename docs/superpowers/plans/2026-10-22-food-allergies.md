# Food Allergy Preferences and Warnings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let signed-in users select food allergies, prevent matching allergens from being recommended in recipes, and warn before saving matching detected or manually entered ingredients.

**Architecture:** ChefApi owns the canonical allergen IDs, aliases, account preference, recipe enforcement, and per-item match annotations for scan/video/dictation results. Android and iOS fetch and save the account selection, clear it from active state on sign-out, use the same alias rules for manual entry, and present localized warnings before saving.

**Tech Stack:** Node 22+, TypeScript, Fastify, Zod, MongoDB; Kotlin, Jetpack Compose, Retrofit, Hilt; Swift, SwiftUI, URLSession, ChefCore/ChefPersistence.

**Spec:** `docs/superpowers/specs/2026-10-22-food-allergy-preferences-design.md`

## Global Constraints

- The fixed catalog contains 14 common allergen groups and uses stable IDs shared by ChefApi, ChefAndroid, and ChefIOS.
- Localized labels cover English, Spanish, Portuguese, Italian, French, and German.
- Allergy selection requires a signed-in account; clear active allergy state on sign-out.
- Persist the preference on the Chef account; missing data for older accounts means an empty selection.
- Do not log allergy preferences or ingredient names.
- Product-label OCR, hidden components, and cross-contact detection are out of scope.
- Preserve all pre-existing uncommitted changes in ChefAndroid and ChefIOS.
- Do not add or run automated tests unless the user asks for verification; use the review checkpoints below for this plan.

## Review Focus

- Accented, translated, and compound ingredient names must match their selected IDs, while substring lookalikes such as `eggplant` must not.
- Existing MongoDB accounts without the `allergens` field must read as an empty selection.
- Dish recipes must not put an allergen into `ingredientsUsed` or `missingIngredients`; a repeated violation must not return a recipe.
- Legacy app-key scan/extract calls without a signed-in profile must return empty `allergenMatches` arrays.
- If a user edits a detected or dictated name before saving, the warning must reflect the edited name rather than a stale server annotation.

---

### Task 1: Canonical catalog and account preference API

**Repository:** `ChefApi`

**Files:**
- Create: `src/allergens/catalog.ts`
- Modify: `src/accountSchema.ts`
- Modify: `src/accounts/stores.ts`
- Modify: `src/accounts/mongoStores.ts`
- Modify: `src/accounts/memoryStores.ts`
- Modify: `src/accounts/routes.ts`
- Modify: `README.md`
- Modify: `test/accountRoutes.test.ts`, `test/accountStores.test.ts`, and add `test/allergens.test.ts` when test work is authorized

**Interfaces:**
- Produces: `ALLERGEN_IDS`, `AllergenId`, and `allergenMatches(name: string, selected: readonly AllergenId[]): AllergenId[]`.
- Produces: authenticated `GET /v1/account/allergies` and `PUT /v1/account/allergies` with `{ allergens: AllergenId[] }` request/response bodies.
- Produces: optional `User.allergens`; stores treat a missing field as `[]` and expose `setAllergens(id, allergens): Promise<boolean>`.

- [ ] Define the 14 stable IDs and localized labels for `en`, `es`, `pt`, `it`, `fr`, and `de`; keep API display-independent matching aliases in this catalog.
- [ ] Implement normalization and whole-word/phrase alias matching; do not match unrelated substrings such as `egg` inside `eggplant`.
- [ ] Add a strict Zod account preference schema that rejects unknown IDs and deduplicates repeated values.
- [ ] Extend `User` and both memory and Mongo stores; ensure old user documents return an empty selection and existing account deletion removes the field with the user document.
- [ ] Register the authenticated GET/PUT routes beside `/account/mascot`; return `401` when the user record cannot be found, return IDs in stable sorted order, and do not log request values.
- [ ] Review the API OpenAPI output and account route/store behavior for old accounts, empty selections, and invalid IDs.

### Task 2: Enforce allergies during recipe generation

**Repository:** `ChefApi`

**Files:**
- Modify: `src/app.ts`
- Modify: `README.md`
- Modify: `src/llm/recipeGenerator.ts`
- Modify: `src/llm/constrainedRecipeGenerator.ts`
- Modify: `src/llm/prompt.ts`
- Modify: `src/llm/ingredientMatcher.ts` only if the existing name matcher cannot host the allergen-specific check cleanly
- Modify: `test/constrained.test.ts`, `test/app.test.ts`, and prompt contract fixtures when test work is authorized

**Interfaces:**
- Consumes Task 1: `AllergenId` and `allergenMatches`.
- Produces: `GenerateRecipeInput.allergens: readonly AllergenId[]`.
- Produces: route-level allergy lookup from `request.client.userId`; unauthenticated app-key requests pass `[]`.

- [ ] Read the signed-in user's allergy IDs in the recipe route and pass them into the generator; never accept a client-supplied allergy list as authoritative.
- [ ] Filter matching pantry ingredients before model input, including selected ingredients and the pantry used for requested-dish recipes.
- [ ] Add the allergy rule above client-provided prompt text and include selected IDs' localized names/aliases in model guidance.
- [ ] Validate the recipe title, description, `ingredientsUsed`, `missingIngredients`, and instruction text against selected allergens.
- [ ] Use the existing retry budget for a recipe with an allergy violation and fail closed with `recipe_refused` if the final response still violates the rule.
- [ ] Review pantry and requested-dish flows, including the case where filtering leaves no usable pantry ingredients.

### Task 3: Annotate detected ingredients in API responses

**Repository:** `ChefApi`

**Files:**
- Modify: `src/schema.ts`
- Modify: `src/app.ts`
- Modify: `test/scanRoute.test.ts`, `test/scanVideoRoute.test.ts`, `test/extract.test.ts`, `test/docs.test.ts`
- Modify: `test/fixtures/scan-response.example.json`, `test/fixtures/scan-video-response.example.json`, and `test/fixtures/extract-response.example.json`

**Interfaces:**
- Consumes Task 1: `allergenMatches(name, selected)` and the account preference.
- Produces: response-only `allergenMatches: AllergenId[]` on each scanned and extracted ingredient. Keep `ScannedIngredientSchema` and `ExtractedIngredientSchema` for model output unchanged so the model is not asked to author safety annotations.

- [ ] Add response-level ingredient schemas that extend model result shapes with `allergenMatches` and use them for photo, video, and extraction route responses.
- [ ] After scanner/extractor normalization, look up the authenticated user's saved IDs and annotate each item by its current name.
- [ ] Return `allergenMatches: []` when no user profile is present or no selected ID matches.
- [ ] Update API fixtures and contract descriptions to show the additive response field without changing model-output schemas.
- [ ] Review signed-in and app-key response shapes, including an edited/unknown food name producing no match.

### Task 4: Add account settings and warnings in ChefAndroid

**Repository:** `ChefAndroid`

**Files:**
- Create: `app/src/main/java/com/ichef/app/account/domain/AllergyPreferences.kt`
- Create: `app/src/main/java/com/ichef/app/account/data/AllergyPreferencesRepositoryImpl.kt`
- Create: `app/src/main/java/com/ichef/app/pantry/domain/AllergenMatcher.kt`
- Modify: `app/src/main/java/com/ichef/app/account/data/AccountApiService.kt`, `AccountDtos.kt`, and `account/di/AccountModule.kt`
- Modify: `app/src/main/java/com/ichef/app/recipe/presentation/home/RecipesViewModel.kt`, `RecipesUiState.kt`, and `RecipesScreen.kt`
- Modify: `app/src/main/java/com/ichef/app/pantry/data/scan/dto/ScanDtos.kt`, `ScanMappers.kt`, `pantry/domain/scan/IngredientScanner.kt`, `pantry/presentation/add/AddIngredientViewModel.kt`, and `ScanComponents.kt`
- Modify: `app/src/main/java/com/ichef/app/pantry/data/extract/dto/ExtractDtos.kt`, `ExtractMappers.kt`, `pantry/presentation/voice/VoiceEntryViewModel.kt`, and `VoiceOverlays.kt`
- Modify: `app/src/main/res/values/strings.xml`, `values-es/strings.xml`, `values-pt/strings.xml`, `values-fr/strings.xml`, `values-it/strings.xml`, and `values-de/strings.xml`

**Interfaces:**
- Consumes Tasks 1–3: account preference routes, stable IDs, and detected-item `allergenMatches`.
- Produces: a session-scoped `StateFlow<Set<AllergenId>>` preference interface; clear it when `AuthRepository.session` becomes null.
- Produces: a localized confirmation before saving a matching manual, scanned, video-scanned, or dictated item.

- [ ] Add Retrofit request/response DTOs and account methods for GET/PUT allergies; bind a session-aware repository that loads on sign-in and clears active state on sign-out.
- [ ] Decode absent `allergenMatches` as an empty list so the app remains compatible with an API response that has not yet deployed the additive field.
- [ ] Add the local name matcher with the API's canonical alias behavior for user-edited names; use returned `allergenMatches` for unchanged scan/extract names.
- [ ] Add the expandable selector beside `DietSection`; when signed out, route the action through the existing sign-in flow and do not retain a selection.
- [ ] Before `AddIngredientViewModel` saves a manual ingredient or scan/video selection, show the matched allergen and require cancel/confirm; recalculate after name edits.
- [ ] Before `VoiceEntryViewModel` commits dictated items, show the same confirmation for any selected matching item; preserve per-item review edits.
- [ ] Add localized selector, sign-in, save-failure, and warning strings in all six Android resource locales.
- [ ] Review signed-in loading/saving, save failure retaining the last confirmed selection, sign-out clearing state, and signed-out manual entry continuing without allergy warnings.

### Task 5: Add account settings and warnings in ChefIOS

**Repository:** `ChefIOS`

**Files:**
- Create: `Sources/ChefCore/Domain/Models/FoodAllergy.swift`
- Create: `Sources/ChefCore/Domain/Pantry/AllergenMatcher.swift`
- Modify: `Sources/ChefCore/Application/Ports/AccountPorts.swift`, `Sources/ChefCore/Application/UseCases/AccountRepository.swift`, and `Sources/ChefCore/Domain/Models/Account.swift`
- Modify: `App/Adapters/Network/AuthAPIClient.swift` and `App/Composition/AppContainer.swift`
- Modify: `App/Presentation/Stores/RecipesStore.swift`, `App/Presentation/Views/RecipesView.swift`, and `App/Resources/Localizable.xcstrings`
- Modify: `Sources/ChefCore/Domain/Capture/CapturedFood.swift`, `App/Adapters/Network/IngredientCaptureAPI.swift`, `App/Presentation/Stores/CaptureStore.swift`, and `App/Presentation/Views/CaptureView.swift`
- Modify: `App/Presentation/Stores/AddIngredientStore.swift` and `App/Presentation/Views/AddIngredientView.swift`

**Interfaces:**
- Consumes Tasks 1–3: account preference routes, stable IDs, and detected-item `allergenMatches`.
- Produces: `FoodAllergy` stable IDs plus `allergenMatches(name: String, selected: Set<FoodAllergy>)`.
- Extends: `AccountGateway` and `AccountUseCase` with read/save allergy preference operations that use the existing access-token renewal path.

- [ ] Add `FoodAllergy` IDs/labels and the same whole-word alias behavior as ChefApi; add `allergenMatches` to captured-food decoding.
- [ ] Decode a missing `allergenMatches` key as an empty list for compatibility while API deployments roll out.
- [ ] Extend the account gateway/use case and API client for GET/PUT allergies; preserve the existing token refresh path and clear active preference state when the session ends.
- [ ] Load/save the selector state in `RecipesStore` and render the expandable selector beside the existing `DietSection`; prompt for sign-in when signed out.
- [ ] Check manual ingredient save and scan/video/dictation review confirmation against the current edited name, and require explicit cancel/confirm before pantry writes.
- [ ] Add localized labels, loading/failure states, and warning copy to `Localizable.xcstrings` for all six supported languages.
- [ ] Review signed-in state refresh, save failure, sign-out clearing, and signed-out manual entry continuing without allergy warnings.

## Cross-Repository Review

- Confirm the API catalog IDs are identical in both mobile clients and that each client sends/decodes the exact `allergens` and `allergenMatches` field names.
- Confirm generated recipe requests cannot override the account preference and do not return a recipe after an unresolved allergy violation.
- Confirm Android and iOS pre-existing local changes remain intact.
