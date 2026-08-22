import { genericParser } from "@/features/statement-import/parsing/generic-parser"
import { newHorizonsParser } from "@/features/statement-import/parsing/new-horizons-parser"
import type { StatementParser } from "@/features/statement-import/parsing/types"
import type { StatementLine } from "@/features/statement-import/types"

/**
 * The statement-parser registry — the one place a newly supported bank gets
 * wired in.
 *
 * Adding a format is: write `parsing/<bank>-parser.ts` implementing
 * `StatementParser`, then add it to this array. Nothing else in the pipeline
 * changes, because every layer past `parsing/` consumes the shared
 * `RawStatementRow` shape.
 *
 * Order in this array does not decide the winner — `detect()` scores do —
 * but format-specific parsers are listed before the generic fallback so the
 * intended precedence is obvious when reading the file.
 */
export const STATEMENT_PARSERS: readonly StatementParser[] = [
  newHorizonsParser,
  genericParser,
]

export interface ParserSelection {
  parser: StatementParser
  /** The winning `detect()` score, `0`–`1`. */
  score: number
}

/**
 * Picks the parser that recognizes this document most strongly.
 *
 * Returns `null` when nothing recognizes it at all (score `0` across the
 * board) — a scanned/image-only PDF, or a document that is not a statement.
 * That case is reported to the user as "no transactions found" rather than
 * being handed to the generic parser to produce a table of garbage rows.
 */
export function selectParser(lines: StatementLine[]): ParserSelection | null {
  let best: ParserSelection | null = null

  for (const parser of STATEMENT_PARSERS) {
    const score = parser.detect(lines)
    if (score > 0 && (best === null || score > best.score)) {
      best = { parser, score }
    }
  }

  return best
}
