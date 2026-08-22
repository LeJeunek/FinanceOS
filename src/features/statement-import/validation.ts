import { canonicalizeCategory } from "@/features/statement-import/categories"
import type { DraftTransaction, DraftValidationError } from "@/features/statement-import/types"

/**
 * Pre-export validation for converted rows.
 *
 * These constraints intentionally mirror
 * `features/transactions/server/validation.ts` (`merchantSchema`,
 * `amountSchema`, `dateOnlySchema`) so a CSV this converter is willing to
 * export is a CSV `features/transactions/server/import.ts` is willing to
 * accept — catching a 200-character merchant here, in a table the user can
 * edit, beats catching it as row 47 of an import error list.
 *
 * They are re-declared rather than imported because that module lives under
 * another feature's `server/` directory, which `docs/architecture/folder-tree.md`
 * rules out as a cross-domain import target (the same reason
 * `hasAtMostTwoDecimalPlaces` is deliberately duplicated between the
 * transactions and accounts validation modules). If the limits below ever
 * change there, change them here too.
 */

const MERCHANT_MAX_LENGTH = 200
const NOTES_MAX_LENGTH = 1000
const MAX_TRANSACTION_AMOUNT_ABS = 999_999_999_999.99

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Same float-noise-tolerant check as the transactions module's. */
function hasAtMostTwoDecimalPlaces(value: number): boolean {
  const cents = value * 100
  return Math.abs(Math.round(cents) - cents) < 1e-6
}

/** Rejects a well-formed-but-impossible date (`2026-02-30`), which the
 * pattern alone would let through. */
function isRealCalendarDate(iso: string): boolean {
  const [year, month, day] = iso.split("-").map(Number)
  const utc = new Date(Date.UTC(year, month - 1, day))
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  )
}

/**
 * Returns every validation failure on one row. An empty array means the row
 * is safe to export.
 *
 * A row is never mutated or dropped here — invalid rows stay in the review
 * table with their errors attached so the user can fix them in place, which
 * is the whole point of reviewing before exporting.
 */
export function validateDraft(
  draft: DraftTransaction,
  allowed: readonly string[],
): DraftValidationError[] {
  const errors: DraftValidationError[] = []

  if (draft.date.trim().length === 0) {
    errors.push({ field: "date", message: "Date is missing or could not be read" })
  } else if (!ISO_DATE_PATTERN.test(draft.date) || !isRealCalendarDate(draft.date)) {
    errors.push({ field: "date", message: `"${draft.date}" is not a valid date (yyyy-mm-dd)` })
  }

  const merchant = draft.merchant.trim()
  if (merchant.length === 0) {
    errors.push({ field: "merchant", message: "Merchant is required" })
  } else if (merchant.length > MERCHANT_MAX_LENGTH) {
    errors.push({
      field: "merchant",
      message: `Merchant must be ${MERCHANT_MAX_LENGTH} characters or fewer`,
    })
  }

  if (draft.amount === null) {
    errors.push({
      field: "amount",
      message: `Amount could not be read from "${draft.source.rawAmount}"`,
    })
  } else if (!Number.isFinite(draft.amount)) {
    errors.push({ field: "amount", message: "Amount must be a finite number" })
  } else if (!hasAtMostTwoDecimalPlaces(draft.amount)) {
    errors.push({ field: "amount", message: "Amount supports at most 2 decimal places" })
  } else if (Math.abs(draft.amount) > MAX_TRANSACTION_AMOUNT_ABS) {
    errors.push({ field: "amount", message: "Amount is larger than the supported maximum" })
  }

  if (canonicalizeCategory(draft.category, allowed) === null) {
    errors.push({
      field: "category",
      message: `"${draft.category}" is not one of your categories`,
    })
  }

  if (draft.notes.length > NOTES_MAX_LENGTH) {
    errors.push({
      field: "notes",
      message: `Notes must be ${NOTES_MAX_LENGTH} characters or fewer`,
    })
  }

  return errors
}

/** True when the row carries no validation errors. */
export function isExportable(draft: DraftTransaction): boolean {
  return draft.errors.length === 0
}
