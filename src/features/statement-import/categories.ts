import { DEFAULT_CATEGORIES } from "@/features/categories/default-categories"

/**
 * The converter's category vocabulary — the ONE place to change what the
 * classifier is allowed to output.
 *
 * The allowed set is *not* redeclared here: it is derived from
 * `features/categories/default-categories.ts`, the existing single source of
 * truth for the Charter's fixed 11-category starter set (that file's own
 * header says "Do not hardcode this list a third time" — this module obeys
 * that by importing it rather than copying the names).
 *
 * At runtime the review UI passes the user's *actual* categories (system +
 * any custom ones they added, from `features/categories`) into
 * `buildAllowedCategories`, so a user who created a "Pets" category can
 * classify into it too. `DEFAULT_CATEGORY_NAMES` is the fallback used by the
 * pure pipeline and its unit tests, where no user context exists.
 */

/** The sentinel written to the CSV's `category` column when the classifier
 * is not confident. `features/transactions/server/import.ts` looks the
 * category name up case-insensitively against the user's real categories
 * and falls back to `categoryId: null` when there is no match — so this
 * value round-trips into FinanceOS as a genuinely uncategorized
 * transaction, which is exactly the intent. */
export const UNCATEGORIZED = "Uncategorized"

/** Names of the 11 system categories, in the Charter's order. */
export const DEFAULT_CATEGORY_NAMES: readonly string[] = DEFAULT_CATEGORIES.map(
  (category) => category.name,
)

/**
 * Builds the allowed-category list for one conversion run.
 *
 * Passing the user's own category names in keeps the converter honest for
 * users with custom categories: `validation.ts` rejects any category outside
 * this list, so a hardcoded 11-name list would flag a perfectly valid "Pets"
 * row as invalid. `UNCATEGORIZED` is always allowed and never duplicated.
 */
export function buildAllowedCategories(userCategoryNames?: readonly string[]): string[] {
  const names = userCategoryNames?.length ? userCategoryNames : DEFAULT_CATEGORY_NAMES
  const unique: string[] = []
  const seen = new Set<string>()
  for (const name of [...names, UNCATEGORIZED]) {
    const key = name.trim().toLowerCase()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    unique.push(name.trim())
  }
  return unique
}

/** Case-insensitive membership test, matching the comparison convention
 * `features/categories/server/actions.ts` and `server/import.ts` both use
 * for category names. Returns the canonically-cased name so the CSV always
 * carries the user's own spelling ("food" -> "Food"). */
export function canonicalizeCategory(
  name: string,
  allowed: readonly string[],
): string | null {
  const key = name.trim().toLowerCase()
  return allowed.find((allowedName) => allowedName.toLowerCase() === key) ?? null
}
