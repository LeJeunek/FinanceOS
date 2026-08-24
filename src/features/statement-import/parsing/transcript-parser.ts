import type { RawStatementRow, StatementLine } from "@/features/statement-import/types"
import type {
  StatementBalance,
  StatementParseResult,
  StatementParser,
} from "@/features/statement-import/parsing/types"

/**
 * Parser for the canonical transcript format produced by
 * `server/vision-text.ts` when a statement has no text layer (a scan or a
 * photo).
 *
 * Why this exists as its own parser rather than the vision step emitting
 * something the New Horizons parser already understands: asking a model to
 * reproduce a bank's exact column spacing is unreliable and unverifiable,
 * while asking it for one strict, delimited line per transaction is neither.
 * The model does exactly one job — read pixels into a fixed grammar — and
 * every decision that affects the money (sign, date normalization, merchant
 * cleanup, categorization, duplicate detection, validation) stays in the same
 * deterministic, unit-tested modules used for text-layer statements.
 *
 * The format, one line per posted transaction:
 *
 *     DATE | DESCRIPTION | DIRECTION | AMOUNT | BALANCE
 *
 * with an optional final line:
 *
 *     ENDING_BALANCE | 1234.56
 *
 * `DIRECTION` is the statement's own debit/credit determination, which is
 * what keeps a credit-card payment from being imported as income.
 */

/** Marks a transcript so `detect` can recognize it without being confused by
 * an ordinary statement that happens to contain pipes. Emitted as the first
 * line by `server/vision-text.ts`. */
export const TRANSCRIPT_HEADER = "#STATEMENT-TRANSCRIPT-V1"

const ENDING_BALANCE_PREFIX = "ENDING_BALANCE"

/** A plain decimal, no sign or separators — the format the transcript
 * contract requires. Anything else is treated as unreadable rather than
 * coerced. */
const AMOUNT_PATTERN = /^\d+(?:\.\d{1,2})?$/

function parseNumber(value: string): number | undefined {
  const trimmed = value.trim().replace(/[$,]/g, "")
  if (!AMOUNT_PATTERN.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

export const transcriptParser: StatementParser = {
  id: "vision-transcript",
  label: "Scanned statement (read visually)",

  detect(lines: StatementLine[]): number {
    // The header is emitted by this app's own vision step, so its presence is
    // conclusive — no other input produces it.
    return lines.some((line) => line.text.trim() === TRANSCRIPT_HEADER) ? 1 : 0
  },

  parse(lines: StatementLine[]): StatementParseResult {
    const rows: RawStatementRow[] = []
    const unparsedLines: StatementLine[] = []
    let endingBalance: StatementBalance | null = null

    for (const line of lines) {
      const text = line.text.trim()
      if (text.length === 0 || text === TRANSCRIPT_HEADER) continue

      const fields = text.split("|").map((field) => field.trim())

      if (fields[0].toUpperCase() === ENDING_BALANCE_PREFIX) {
        const amount = parseNumber(fields[1] ?? "")
        if (amount !== undefined) {
          endingBalance = {
            amount,
            source: "ending-balance-line",
            label: text,
            sourceLine: line.lineNumber,
            asOfDate: null,
          }
        }
        continue
      }

      // A well-formed row has at least date, description, direction, amount.
      if (fields.length < 4) {
        unparsedLines.push(line)
        continue
      }

      const [rawDate, rawDescription, directionField, rawAmount, rawBalance] = fields
      const normalizedDirection = directionField.toUpperCase()

      if (rawDate.length === 0 || parseNumber(rawAmount) === undefined) {
        unparsedLines.push(line)
        continue
      }

      // An unrecognized direction is reported as "unknown" rather than
      // assumed, which makes `normalization/amount.ts` record a visible
      // assumption on the row instead of silently picking a sign.
      const direction =
        normalizedDirection === "DEBIT"
          ? "debit"
          : normalizedDirection === "CREDIT"
            ? "credit"
            : "unknown"

      if (direction === "unknown") {
        // Still emitted — the money moved — but the row is also surfaced so
        // the user knows the transcript was ambiguous here.
        unparsedLines.push(line)
      }

      rows.push({
        sourceLine: line.lineNumber,
        rawDate,
        rawDescription,
        rawAmount,
        direction,
        directionLabel: directionField,
        rawNotes: rawDescription,
        runningBalance: rawBalance ? parseNumber(rawBalance) : undefined,
      })
    }

    // Fall back to the last row's running balance, matching the other parsers'
    // behavior, when the statement printed no explicit closing figure.
    if (endingBalance === null) {
      const lastWithBalance = [...rows].reverse().find((row) => row.runningBalance !== undefined)
      if (lastWithBalance?.runningBalance !== undefined) {
        endingBalance = {
          amount: lastWithBalance.runningBalance,
          source: "last-running-balance",
          label: `Running balance after ${lastWithBalance.rawDate} ${lastWithBalance.rawDescription}`,
          sourceLine: lastWithBalance.sourceLine,
          asOfDate: null,
        }
      }
    }

    return { rows, unparsedLines, endingBalance }
  },
}
