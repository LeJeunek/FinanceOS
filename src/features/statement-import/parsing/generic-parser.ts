import type { RawStatementRow, StatementLine } from "@/features/statement-import/types"
import type {
  StatementBalance,
  StatementParseResult,
  StatementParser,
} from "@/features/statement-import/parsing/types"

/**
 * Last-resort parser for statement layouts nothing else recognizes.
 *
 * It assumes only the one convention essentially every statement shares: a
 * transaction line starts with a date and ends with an amount, with the
 * description in between. It deliberately makes no claim about debit/credit
 * direction (`direction: "unknown"`), which pushes the sign decision to
 * `normalization/amount.ts` where it is recorded as a visible assumption on
 * every affected row — the user reviews a table full of "treated as money
 * out" flags rather than silently importing a statement of inverted amounts.
 *
 * A new bank should get its own parser in this folder rather than having
 * this one bent to fit it; this exists so an unrecognized statement produces
 * a reviewable starting point instead of an empty table.
 */

/** `08/21/2026`, `08-21-26`, `08/21`, `Aug 21, 2026`, `August 21`. Kept
 * loose — `normalization/date.ts` is what actually validates and normalizes
 * whatever this captures. */
const DATE_SOURCE =
  String.raw`(?:\d{1,2}[/\-.]\d{1,2}(?:[/\-.]\d{2,4})?|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:,?\s*\d{2,4})?)`

/** `1,245.32`, `$42.19`, `(42.19)`, `-42.19`, `42.19-`, `42.19 CR`. Requires
 * cents, which is what separates a money column from a reference number. */
const AMOUNT_SOURCE = String.raw`\(?[-–+]?\$?\d[\d,]*\.\d{2}\)?[-–]?(?:\s*(?:CR|DR))?`

/** date + description + amount, with an optional second amount that is
 * treated as a running-balance column. */
const TRANSACTION_PATTERN = new RegExp(
  String.raw`^(${DATE_SOURCE})\s+(.*?)\s+(${AMOUNT_SOURCE})(?:\s+(${AMOUNT_SOURCE}))?\s*$`,
  "i",
)

/** A line that begins with a date and has no trailing amount — reported as
 * unparsed rather than ignored, since it may be a transaction whose amount
 * column the PDF text extraction dropped. */
const DATE_LEADING_PATTERN = new RegExp(String.raw`^${DATE_SOURCE}\s+\S`, "i")

/** Summary/marketing lines that start with a date but are not transactions. */
const NOISE_PATTERN =
  /statement\s+period|page\s+\d+\s+of\s+\d+|account\s+number|beginning\s+balance|previous\s+balance|balance\s+forward/i

/** How a closing balance is labeled across common statement layouts. */
const ENDING_BALANCE_PATTERN = new RegExp(
  String.raw`(ending\s+balance|closing\s+balance|new\s+balance|statement\s+balance|current\s+balance)\s*:?\s*(${AMOUNT_SOURCE})`,
  "i",
)

/** Reduces a matched money token to a plain number. Mirrors the notation
 * `normalization/amount.ts` handles; duplicated in miniature here because
 * balances are read by the parser layer, which must not depend on
 * normalization (the dependency runs the other way). */
function toNumber(token: string): number | null {
  let text = token.trim()
  let negative = false

  const creditDebit = /\s*(CR|DR)\s*$/i.exec(text)
  if (creditDebit) {
    if (creditDebit[1].toUpperCase() === "DR") negative = true
    text = text.replace(/\s*(CR|DR)\s*$/i, "").trim()
  }
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true
    text = text.slice(1, -1)
  }
  if (/^[-–]/.test(text)) {
    negative = true
    text = text.slice(1)
  } else if (/[-–]$/.test(text)) {
    negative = true
    text = text.slice(0, -1)
  }

  text = text.replace(/[$,\s+]/g, "")
  if (!/^\d*\.?\d+$/.test(text)) return null

  const value = Number(text)
  if (!Number.isFinite(value)) return null
  return negative ? -value : value
}

export const genericParser: StatementParser = {
  id: "generic-date-amount",
  label: "Generic statement layout",

  detect(lines: StatementLine[]): number {
    if (lines.length === 0) return 0
    const hits = lines.filter(
      (line) => !NOISE_PATTERN.test(line.text) && TRANSACTION_PATTERN.test(line.text),
    ).length
    if (hits === 0) return 0

    // Capped below every format-specific parser's minimum score (0.6) so a
    // recognized format always wins, while still beating "no parser at all".
    return Math.min(0.5, 0.2 + hits / 40)
  },

  parse(lines: StatementLine[]): StatementParseResult {
    const rows: RawStatementRow[] = []
    const unparsedLines: StatementLine[] = []

    for (const line of lines) {
      if (NOISE_PATTERN.test(line.text)) continue

      const match = TRANSACTION_PATTERN.exec(line.text)
      if (!match) {
        if (DATE_LEADING_PATTERN.test(line.text)) unparsedLines.push(line)
        continue
      }

      const [, rawDate, description, firstAmount, secondAmount] = match

      // With two money columns the layout is `amount balance`; the second is
      // the running balance, not a second transaction amount.
      const runningBalance = secondAmount ? toNumber(secondAmount) : null

      rows.push({
        sourceLine: line.lineNumber,
        rawDate,
        rawDescription: description.trim(),
        rawAmount: firstAmount,
        direction: "unknown",
        rawNotes: line.text.trim(),
        runningBalance: runningBalance ?? undefined,
      })
    }

    return {
      rows,
      unparsedLines,
      endingBalance: findEndingBalance(lines, rows),
    }
  },
}

function findEndingBalance(
  lines: StatementLine[],
  rows: RawStatementRow[],
): StatementBalance | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = ENDING_BALANCE_PATTERN.exec(lines[i].text)
    if (match) {
      const amount = toNumber(match[2])
      if (amount !== null) {
        return {
          amount,
          source: "ending-balance-line",
          label: lines[i].text.trim(),
          sourceLine: lines[i].lineNumber,
          asOfDate: null,
        }
      }
    }
  }

  const lastRow = rows.length > 0 ? rows[rows.length - 1] : undefined
  if (lastRow?.runningBalance !== undefined) {
    return {
      amount: lastRow.runningBalance,
      source: "last-running-balance",
      label: `Running balance after ${lastRow.rawDate} ${lastRow.rawDescription}`.trim(),
      sourceLine: lastRow.sourceLine,
      asOfDate: null,
    }
  }

  return null
}
