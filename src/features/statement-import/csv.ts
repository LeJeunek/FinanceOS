import type { DraftTransaction } from "@/features/statement-import/types"

/**
 * CSV generation.
 *
 * The output targets `features/transactions/server/import.ts` exactly: the
 * header is the five columns that module resolves (`date`, `merchant`,
 * `amount`, `category`, `notes`), in that order, and the values use the
 * formats its own parsers accept (`yyyy-mm-dd`, plain signed decimals). The
 * file is equally usable in any spreadsheet program — it is plain RFC 4180.
 *
 * A note on the `category` column: rows classified as `Uncategorized` are
 * written with that literal name rather than an empty cell. The importer
 * looks category names up case-insensitively against the user's real
 * categories and falls back to `categoryId: null` when there is no match, so
 * "Uncategorized" round-trips into FinanceOS as a genuinely uncategorized
 * transaction — while keeping the CSV self-describing if the user opens it
 * in Excel instead.
 */

export const CSV_COLUMNS = ["date", "merchant", "amount", "category", "notes"] as const

export const CSV_HEADER = CSV_COLUMNS.join(",")

/**
 * RFC 4180 field escaping: a field containing a comma, a double quote, or a
 * newline is wrapped in double quotes, and any embedded double quote is
 * doubled. Everything else is written bare.
 *
 * This is what preserves a merchant like `Dillard's Bakery, Inc.` and a
 * multi-line note through the round trip — `import.ts`'s hand-rolled parser
 * implements the matching un-escaping.
 */
export function escapeCsvField(value: string): string {
  if (!/[",\n\r]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

/** Formats an amount for the CSV: always two decimals, sign preserved, no
 * thousands separators or currency symbol (all three of which would force
 * the importer to re-interpret a number this tool already resolved). */
export function formatCsvAmount(amount: number): string {
  return amount.toFixed(2)
}

/** One data row. Exported separately so tests can assert a single row's
 * escaping without building a whole file. */
export function toCsvRow(draft: DraftTransaction): string {
  return [
    escapeCsvField(draft.date),
    escapeCsvField(draft.merchant.trim()),
    draft.amount === null ? "" : formatCsvAmount(draft.amount),
    escapeCsvField(draft.category),
    escapeCsvField(draft.notes.trim()),
  ].join(",")
}

/**
 * Renders the finished CSV, header first, with a trailing newline (which
 * `import.ts` tolerates — it drops fully-blank trailing lines).
 *
 * Callers decide which rows to pass: the review UI exports valid rows only
 * unless the user explicitly overrides. This function does not filter, so
 * "what got exported" stays one visible decision in the UI rather than a
 * hidden rule in here.
 */
export function generateCsv(drafts: readonly DraftTransaction[]): string {
  return [CSV_HEADER, ...drafts.map(toCsvRow)].join("\n") + "\n"
}

/** Builds a stable, human-meaningful download name, e.g.
 * `statement-2026-08-21.csv`, falling back to the source PDF's name. */
export function buildCsvFileName(sourceFileName: string, latestDate: string | null): string {
  const base = sourceFileName.replace(/\.pdf$/i, "").replace(/[^\w.-]+/g, "-")
  return latestDate ? `${base}-${latestDate}.csv` : `${base}.csv`
}
