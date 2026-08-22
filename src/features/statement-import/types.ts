/**
 * Domain types for the PDF Statement -> CSV converter
 * (`features/statement-import`).
 *
 * This module is the seam between the converter's layers. Each layer below
 * consumes the previous layer's type and knows nothing about the next:
 *
 *   PDF bytes
 *     -> `extraction/` .............. string (raw statement text)
 *     -> `parsing/` ................. RawStatementRow[]   (format-specific)
 *     -> `normalization/` ........... DraftTransaction[]  (format-agnostic)
 *     -> `categorization/` .......... DraftTransaction[]  (+ category)
 *     -> `validation.ts` ............ DraftTransaction[]  (+ errors)
 *     -> `duplicates.ts` ............ DraftTransaction[]  (+ duplicateOfId)
 *     -> `components/` .............. review + inline edits
 *     -> `csv.ts` ................... string (import-ready CSV)
 *
 * Nothing here imports React, Prisma, or `lib/db` — the whole pipeline is
 * pure and unit-testable with fixture strings alone, the same testability
 * bar as `features/debt/payoff-math.ts` and `lib/merchant-normalization.ts`.
 */

/**
 * Which side of the ledger a statement row falls on, decided by the
 * format-specific parser (which is the only layer that can read a
 * "Withdrawal"/"Deposit" column, a trailing `CR`/`DR` marker, or a
 * separate debit/credit column).
 *
 * `"unknown"` means the parser found an amount but no direction evidence at
 * all — normalization must then fall back to an explicit, recorded
 * assumption rather than silently picking a sign (see
 * `normalization/amount.ts`'s `resolveSignedAmount`).
 */
export type LedgerDirection = "debit" | "credit" | "unknown"

/**
 * How the row's category was arrived at. Surfaced in the review table so a
 * weak guess is visually distinguishable from a confident one — per the
 * converter's "do not pretend every classification is certain" rule.
 */
export type CategoryConfidence =
  /** Exact merchant/alias hit, or an unambiguous keyword hit. */
  | "confident"
  /** Matched, but more than one category's rules fired — check this one. */
  | "weak"
  /** No rule matched; category is the `Uncategorized` sentinel. */
  | "uncategorized"
  /** The user picked the category by hand in the review table. */
  | "manual"

/** One line of extracted statement text, with its 1-based line number kept
 * for provenance (every `DraftTransaction` can point back at the exact line
 * it came from, which is what makes a mis-parse debuggable without
 * re-running the PDF). */
export interface StatementLine {
  lineNumber: number
  text: string
}

/**
 * A transaction row as lifted off the statement by a format-specific parser
 * — deliberately all-strings and un-interpreted. The parser's only job is
 * "which characters on this page are the date / description / amount", NOT
 * "what does 08/21 mean" or "is this negative"; that is normalization's job.
 *
 * Keeping this layer stringly-typed is what lets a new bank format be added
 * as one new file in `parsing/` with zero changes to normalization,
 * categorization, validation, dedup, or CSV output.
 */
export interface RawStatementRow {
  /** 1-based line number in the extracted text this row started on. */
  sourceLine: number
  /** The date exactly as printed (e.g. `"08/21/2026"`, `"Aug 21"`). */
  rawDate: string
  /** The merchant/description text, uncleaned. */
  rawDescription: string
  /** The amount exactly as printed (e.g. `"1,245.32"`, `"($42.19)"`). */
  rawAmount: string
  /** Debit/credit evidence the parser found, if the format carries any. */
  direction: LedgerDirection
  /** The literal text that produced `direction` (e.g. `"Recurring
   * Withdrawal"`), kept for the review table's provenance popover. */
  directionLabel?: string
  /** Extra statement text worth preserving as notes (reference numbers,
   * ACH metadata, the untrimmed original description). */
  rawNotes?: string
  /**
   * The account balance printed alongside this row, when the statement
   * carries a running-balance column.
   *
   * Captured so the converter can reconcile the account's stored balance
   * after an import (see `reconciliation.ts`): the running balance on the
   * chronologically-last transaction IS the statement's closing balance, and
   * is available even on statements that never print an explicit
   * "Ending Balance" line.
   */
  runningBalance?: number
}

/** One validation failure on a single draft row. `field` drives which cell
 * the review table highlights. */
export interface DraftValidationError {
  field: "date" | "merchant" | "amount" | "category" | "notes"
  message: string
}

/**
 * A normalized, categorized, validated transaction awaiting the user's
 * review — the converter's central working type, and the only shape the
 * review UI and `csv.ts` ever see.
 *
 * `amount` is `number | null` (not `number`) and `date` may be `""` on
 * purpose: an unparseable cell must survive all the way into the review
 * table so the user can *fix* it, rather than the row being dropped during
 * parsing and silently missing from the export.
 */
export interface DraftTransaction {
  /** Stable client-side id (`row-<n>`), used as the React key, the dedup
   * back-reference, and nothing else — never sent to the server. */
  id: string
  /** `"yyyy-mm-dd"`, or `""` when the statement's date could not be parsed. */
  date: string
  merchant: string
  /** `null` when the printed amount could not be reduced to a number. */
  amount: number | null
  /** An allowed category name, or the `UNCATEGORIZED` sentinel. */
  category: string
  notes: string
  confidence: CategoryConfidence
  /** Set when the user edits a cell in the review table; edited rows are
   * never re-categorized or re-normalized by a later pipeline pass. */
  isEdited: boolean
  /** Human-readable interpretation notes the pipeline had to make (year
   * inferred, sign assumed, merchant heavily rewritten). Shown in the review
   * table so no interpretation is invisible. */
  assumptions: string[]
  errors: DraftValidationError[]
  /** `id` of the earlier row this one duplicates (date+merchant+amount), or
   * `null`. Duplicates are flagged, never auto-deleted. */
  duplicateOfId: string | null
  /** Untouched parser output, kept for debugging a bad extraction. */
  source: RawStatementRow
}

/**
 * The closing balance a statement reports, used by `reconciliation.ts` to
 * offer an account-balance update after an import.
 */
export interface StatementBalance {
  /** Signed, in the account's own terms — positive for a deposit account's
   * credit balance. */
  amount: number
  /**
   * Where the number came from, shown to the user before they accept a
   * balance update. Reconciliation overwrites a stored balance, so its
   * provenance is never hidden.
   */
  source: "ending-balance-line" | "last-running-balance"
  /** The literal statement text this was read from. */
  label: string
  sourceLine: number
  /** `"yyyy-mm-dd"` the balance is as of (the last transaction's date, or the
   * statement period end), or `null` if the format does not say. */
  asOfDate: string | null
}

/** Everything the review UI needs from one conversion run. */
export interface ConversionResult {
  transactions: DraftTransaction[]
  /**
   * The statement's closing balance, when the format prints one. Drives the
   * post-import reconciliation prompt (`reconciliation.ts`) that offers to
   * update the account's stored balance to match the statement.
   */
  endingBalance: StatementBalance | null
  /** Id of the `parsing/` adapter that claimed this statement. */
  parserId: string
  /** Human-readable parser name, shown in the review header. */
  parserLabel: string
  /** Lines that looked like transactions but could not be parsed — surfaced
   * so a partially-understood statement never *looks* fully converted. */
  unparsedLines: StatementLine[]
  /** Total non-blank lines of text extracted from the PDF. */
  totalLines: number
}

/** Review-table summary counts (the converter's "X detected / X need
 * review / ..." strip). */
export interface ConversionSummary {
  total: number
  needsReview: number
  categorized: number
  uncategorized: number
  duplicates: number
  invalid: number
}
