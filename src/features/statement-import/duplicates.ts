import type { DraftTransaction } from "@/features/statement-import/types"

/**
 * Within-file duplicate detection.
 *
 * The key is date + amount-in-cents + lowercased merchant — byte-for-byte the
 * same rule as `features/transactions/server/import.ts`'s `buildDedupeKey`,
 * so a row this converter flags is exactly a row that importer would skip.
 * Integer cents rather than the float avoids `0.1 + 0.2` style equality
 * misses.
 *
 * Duplicates are **flagged, never removed**. Two identical coffees on the
 * same day at the same price is a real thing that happens, and silently
 * dropping the second one loses money the user actually spent. The review
 * table shows the pairing and lets the user delete the row if it really is a
 * double-read of one transaction.
 *
 * Scope: this compares rows *within the converted statement only*. Duplicates
 * against transactions already in FinanceOS are still caught downstream —
 * `importTransactionsFromCsv` checks every row against the target account's
 * existing rows and reports them as `skippedDuplicates`. Re-implementing that
 * check here would mean pulling the account's full history into the browser
 * to answer a question the importer already answers correctly.
 */

/** Builds the dedup key for one row, or `null` when the row is too
 * incomplete to compare (no date or no amount) — an unparseable row is never
 * called a duplicate of anything. */
export function buildDedupeKey(draft: DraftTransaction): string | null {
  if (draft.date.trim().length === 0 || draft.amount === null) return null
  const cents = Math.round(draft.amount * 100)
  return `${draft.date}|${cents}|${draft.merchant.trim().toLowerCase()}`
}

/**
 * Returns a new array with `duplicateOfId` set on every row that repeats an
 * earlier one. The first occurrence of a key is never flagged — it is the
 * row the others point at.
 */
export function flagDuplicates(drafts: DraftTransaction[]): DraftTransaction[] {
  const firstSeenIdByKey = new Map<string, string>()

  return drafts.map((draft) => {
    const key = buildDedupeKey(draft)
    if (key === null) {
      return draft.duplicateOfId === null ? draft : { ...draft, duplicateOfId: null }
    }

    const firstId = firstSeenIdByKey.get(key)
    if (firstId === undefined) {
      firstSeenIdByKey.set(key, draft.id)
      return draft.duplicateOfId === null ? draft : { ...draft, duplicateOfId: null }
    }

    return draft.duplicateOfId === firstId ? draft : { ...draft, duplicateOfId: firstId }
  })
}
