import type {
  RawStatementRow,
  StatementBalance,
  StatementLine,
} from "@/features/statement-import/types"

/**
 * The statement-parser contract.
 *
 * Bank statements do not share a layout, so "find the transactions" is the
 * one part of this pipeline that cannot be written once. Each supported
 * format gets its own file implementing this interface, and `registry.ts`
 * picks the best-matching one per document. Everything downstream
 * (normalization, categorization, validation, dedup, CSV) consumes
 * `RawStatementRow` and never learns which parser produced it — which is
 * what makes adding a second bank a one-file change.
 */

/** Re-exported so a parser implementation only ever imports from this
 * module — `StatementBalance` itself is declared in the feature's `types.ts`
 * alongside the rest of the domain shapes. */
export type { StatementBalance }

export interface StatementParseResult {
  rows: RawStatementRow[]
  /** Lines that look like they carry a date and an amount but which this
   * parser could not turn into a row. Surfaced in the review UI so a
   * partially-understood statement never looks fully converted. */
  unparsedLines: StatementLine[]
  endingBalance: StatementBalance | null
}

export interface StatementParser {
  /** Stable machine id, recorded on the conversion result. */
  id: string
  /** Human-readable name shown in the review header. */
  label: string
  /**
   * How strongly this parser recognizes the document, `0` (not mine) to `1`
   * (certain). `registry.ts` picks the highest scorer, so a
   * format-specific parser must out-score the generic fallback whenever its
   * format is genuinely present.
   */
  detect(lines: StatementLine[]): number
  parse(lines: StatementLine[]): StatementParseResult
}
