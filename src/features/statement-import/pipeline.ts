import { buildAllowedCategories, UNCATEGORIZED } from "@/features/statement-import/categories"
import { classifyTransaction } from "@/features/statement-import/categorization/classify"
import { flagDuplicates } from "@/features/statement-import/duplicates"
import { resolveSignedAmount } from "@/features/statement-import/normalization/amount"
import {
  inferStatementYear,
  normalizeDate,
} from "@/features/statement-import/normalization/date"
import { normalizeMerchant } from "@/features/statement-import/normalization/merchant"
import { selectParser } from "@/features/statement-import/parsing/registry"
import type {
  ConversionResult,
  ConversionSummary,
  DraftTransaction,
  RawStatementRow,
  StatementLine,
} from "@/features/statement-import/types"
import { validateDraft } from "@/features/statement-import/validation"

/**
 * The conversion pipeline — the single place the layers are wired together.
 *
 *   extracted text -> lines -> parser -> normalize -> classify -> validate
 *                  -> flag duplicates -> ConversionResult
 *
 * Everything here is pure: give it the same statement text and it produces
 * the same result, with no network, no database, and no clock. That is what
 * makes the whole converter testable from fixture strings (see
 * `pipeline.test.ts`) rather than only through the UI.
 */

export interface ConvertOptions {
  /** The user's real category names. Defaults to the 11 system categories
   * when omitted (tests, and any caller without user context). */
  allowedCategories?: readonly string[]
}

/** Splits extracted PDF text into non-blank lines, keeping each line's
 * original 1-based position so a row can point back at the exact line it came
 * from even after blanks are dropped. */
export function toStatementLines(text: string): StatementLine[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ lineNumber: index + 1, text: line.trim() }))
    .filter((line) => line.text.length > 0)
}

/**
 * Turns one parsed row into a review-ready draft.
 *
 * Each normalization step contributes its own assumptions to the row, so the
 * review table can show exactly which interpretations were made — an inferred
 * year, an assumed sign, a printed sign that contradicted the statement's own
 * debit/credit column.
 */
function toDraft(
  row: RawStatementRow,
  index: number,
  allowed: readonly string[],
  fallbackYear: number | undefined,
): DraftTransaction {
  const assumptions: string[] = []

  const normalizedDate = normalizeDate(row.rawDate, { fallbackYear })
  if (normalizedDate) assumptions.push(...normalizedDate.assumptions)

  const signedAmount = resolveSignedAmount(row.rawAmount, row.direction)
  if (signedAmount) assumptions.push(...signedAmount.assumptions)

  const merchant = normalizeMerchant(row.rawDescription)
  const notes = (row.rawNotes ?? "").trim()

  const classification =
    merchant.length > 0 || notes.length > 0
      ? classifyTransaction(merchant, notes, allowed)
      : { category: UNCATEGORIZED, confidence: "uncategorized" as const }

  const draft: DraftTransaction = {
    id: `row-${index + 1}`,
    date: normalizedDate?.iso ?? "",
    merchant,
    amount: signedAmount?.amount ?? null,
    category: classification.category,
    notes,
    confidence: classification.confidence,
    isEdited: false,
    assumptions,
    errors: [],
    duplicateOfId: null,
    source: row,
  }

  return { ...draft, errors: validateDraft(draft, allowed) }
}

/**
 * Converts extracted statement text into reviewable transactions.
 *
 * Returns an empty result (with `parserId: "none"`) when no parser recognizes
 * the document — a scanned image-only PDF, or something that is not a
 * statement. The UI reports that as "no transactions found" rather than
 * showing an empty table that looks like a successful conversion of nothing.
 */
export function convertStatementText(
  text: string,
  options: ConvertOptions = {},
): ConversionResult {
  const allowed = buildAllowedCategories(options.allowedCategories)
  const lines = toStatementLines(text)
  const selection = selectParser(lines)

  if (!selection) {
    return {
      transactions: [],
      parserId: "none",
      parserLabel: "Unrecognized statement layout",
      unparsedLines: [],
      endingBalance: null,
      totalLines: lines.length,
    }
  }

  const parsed = selection.parser.parse(lines)
  // The year is inferred from the whole document, not per row, so a
  // statement that prints "08/21" on every line still dates correctly from
  // its period header.
  const fallbackYear = inferStatementYear(text)

  const drafts = parsed.rows.map((row, index) => toDraft(row, index, allowed, fallbackYear))

  return {
    transactions: flagDuplicates(drafts),
    parserId: selection.parser.id,
    parserLabel: selection.parser.label,
    unparsedLines: parsed.unparsedLines,
    endingBalance: parsed.endingBalance,
    totalLines: lines.length,
  }
}

/**
 * Re-runs validation and duplicate detection after the user edits a cell.
 *
 * Normalization and categorization are deliberately NOT re-run: once a user
 * has typed a merchant or picked a category, having the pipeline overwrite it
 * on the next keystroke would be actively hostile. Edited rows keep
 * `isEdited: true` and their manual values; only the checks that describe the
 * row's *current* state are recomputed.
 */
export function revalidate(
  drafts: DraftTransaction[],
  options: ConvertOptions = {},
): DraftTransaction[] {
  const allowed = buildAllowedCategories(options.allowedCategories)
  const validated = drafts.map((draft) => ({
    ...draft,
    errors: validateDraft(draft, allowed),
  }))
  return flagDuplicates(validated)
}

/** Counts for the review header strip. `needsReview` is the actionable
 * number: anything invalid, duplicated, weakly categorized, or uncategorized
 * — i.e. every row the user should actually look at before exporting. */
export function summarize(drafts: readonly DraftTransaction[]): ConversionSummary {
  let needsReview = 0
  let categorized = 0
  let uncategorized = 0
  let duplicates = 0
  let invalid = 0

  for (const draft of drafts) {
    const isUncategorized = draft.category === UNCATEGORIZED
    const isInvalid = draft.errors.length > 0
    const isDuplicate = draft.duplicateOfId !== null

    if (isUncategorized) uncategorized += 1
    else categorized += 1
    if (isInvalid) invalid += 1
    if (isDuplicate) duplicates += 1

    if (isInvalid || isDuplicate || isUncategorized || draft.confidence === "weak") {
      needsReview += 1
    }
  }

  return {
    total: drafts.length,
    needsReview,
    categorized,
    uncategorized,
    duplicates,
    invalid,
  }
}
