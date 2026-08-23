import type { RawStatementRow, StatementLine } from "@/features/statement-import/types"
import type {
  StatementBalance,
  StatementParseResult,
  StatementParser,
} from "@/features/statement-import/parsing/types"

/**
 * Parser for New Horizons Credit Union statements.
 *
 * This is a direct descendant of the one-off `scripts/convert-statement-pdf.ts`
 * — the line-continuation handling, the page-break skip logic, and the
 * address-stripping heuristics below were all derived from real statements
 * and are kept intact. Two things changed in the move into the app:
 *
 *   1. **Direction is reported, not discarded.** The old script wrote every
 *      amount as a positive number, so a Withdrawal imported into FinanceOS
 *      as *income* and pushed `Account.balance` the wrong way. This parser
 *      reports `direction: "debit" | "credit"` from the statement's own
 *      Withdrawal/Deposit column and lets `normalization/amount.ts` apply the
 *      sign — see that module for why the two steps are separate.
 *   2. **The running-balance column is captured.** The old script parsed the
 *      balance token purely to locate the amount token and then threw it
 *      away; keeping it is what lets `reconciliation.ts` offer to update the
 *      NHCU account's stored balance after an import.
 *
 * The statement's transaction rows look like:
 *
 *     08/21/2026  Withdrawal   ACH WALMART.COM        42.19    1,204.55
 *     WAL-MART.COM 8009666546 AR
 *
 * — a header line carrying date, type, an optional descriptor, the amount,
 * and the running balance, usually followed by a continuation line holding
 * the real merchant and its location.
 */

/** Header line: date + transaction type + everything else. */
const HEADER_PATTERN =
  /^(\d{2}\/\d{2}\/\d{4})\s+(Withdrawal|Deposit|Recurring Withdrawal|Recurring Deposit)(?:\s+(.*))?$/

/**
 * Statement boilerplate — page furniture, marketing copy, summary lines.
 * Kept verbatim from the original script (these strings were found by
 * running it against real statements), plus the branch-address and
 * member-notice lines that follow the same pattern.
 */
const NOISE_PATTERN =
  /Balance Forward|Ending Balance|Pending credit\/return|Dividends Paid YTD|^\s*ID \d|Statement Page|Account Number|Statement Period|Sign up for E-Statements|^\s*\d+ Withdrawals|^ATM (Withdrawal|Deposit)|^Date\s+(Description|Transaction Description)|^--\s*\d+ of \d+\s*--$|^Holiday Closing|^September \d|^All NHCU|^ATMs and Online|^use\.\s*Enroll in our free/

/** A continuation line that begins with its own date (the statement
 * occasionally repeats it) — the date is stripped before the line is read as
 * a merchant. */
const LEADING_DATE_PATTERN = /^\d{2}\/\d{2}\/\d{4}\s+/
/** The statement's explicit closing-balance line, the preferred
 * reconciliation source. */
const ENDING_BALANCE_PATTERN = /Ending Balance\s*:?\s*\$?(-?[\d,]+\.\d{2})/i

const LONG_REFERENCE_PATTERN = /\b\d{10,}\b/
const PHONE_PATTERN = /\b\d{3}-\d{3}-\d{4}\b/
/** A trailing two-letter state code on the address continuation line. */
const TRAILING_STATE_PATTERN = /\b[A-Z]{2}\s*$/

/** Two-word city names seen on these statements. A one-word city is handled
 * by the generic trailing-word heuristic below; multi-word ones cannot be,
 * so they are listed. Extend as new ones appear. */
const TWO_WORD_CITIES = ["SPANISH FORT", "BAY MINETTE", "GULF SHORES", "ORANGE BEACH"]

/** Descriptors that embed the merchant directly on the header line rather
 * than on a continuation line (ACH transfers and dividend postings). */
const EMBEDDED_MERCHANT_PATTERN = /\b(?:ACH|Dividend)\s+(.+)$/

/**
 * Strips the location tail (street number, city, state, phone, reference
 * number) off a New Horizons address continuation line, leaving the merchant.
 *
 * Format-specific on purpose — it lives here rather than in
 * `normalization/merchant.ts` because "the token after the merchant is a
 * street address" is a fact about THIS statement layout, not about merchant
 * names in general.
 */
export function stripLocationSuffix(raw: string): string {
  let text = raw.trim()

  // Order matters, and differs from the original script's: the address tail
  // reads "<city> <state>", so the state has to come off BEFORE a two-word
  // city can be anchored at the end. The script stripped cities first, which
  // meant its `\s+SPANISH FORT\s*$` anchor never matched a real line (they
  // all end in "AL") and "WAL-MART #1234 SPANISH FORT AL" degraded to
  // "WAL-MART #1234 SPANISH" via the single-word fallback below.
  text = text.replace(TRAILING_STATE_PATTERN, "").trim()
  for (const city of TWO_WORD_CITIES) {
    text = text.replace(new RegExp(`\\s+${city}\\s*$`, "i"), "")
  }
  text = text.replace(PHONE_PATTERN, "").trim()
  text = text.replace(LONG_REFERENCE_PATTERN, "").trim()

  // Truncate at the first purely-numeric token that is not the first word —
  // on these statements that token is always the start of a street address.
  const words = text.split(/\s+/)
  for (let i = 1; i < words.length; i++) {
    if (/^\d+$/.test(words[i])) {
      text = words.slice(0, i).join(" ")
      break
    }
  }

  // Drop a trailing all-caps single-word city when enough of the name
  // survives ("BURGER KING #9270 ROBERTSDALE" -> "BURGER KING #9270").
  const remaining = text.split(/\s+/)
  if (remaining.length >= 3 && /^[A-Z]+$/.test(remaining[remaining.length - 1])) {
    text = remaining.slice(0, -1).join(" ")
  }

  return text.trim().replace(/\s{2,}/g, " ")
}

/** Splits a header line's tail into `descriptor amount balance`. The amount
 * and running balance are always the last two whitespace-separated tokens. */
function splitAmountAndBalance(
  tail: string,
): { rawAmount: string; runningBalance: number | undefined; descriptor: string } | null {
  const tokens = tail.trim().split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return null

  const rawAmount = tokens[tokens.length - 2]
  const balanceToken = tokens[tokens.length - 1]
  if (!/^-?[\d,]+\.\d{2}$/.test(rawAmount)) return null

  const balance = Number(balanceToken.replace(/,/g, ""))
  return {
    rawAmount,
    runningBalance: Number.isFinite(balance) ? balance : undefined,
    descriptor: tokens.slice(0, -2).join(" "),
  }
}

function toIsoDate(mmddyyyy: string): string {
  const [month, day, year] = mmddyyyy.split("/")
  return `${year}-${month}-${day}`
}

function isDebit(transactionType: string): boolean {
  return transactionType.toLowerCase().includes("withdrawal")
}

export const newHorizonsParser: StatementParser = {
  id: "new-horizons-credit-union",
  label: "New Horizons Credit Union",

  detect(lines: StatementLine[]): number {
    const headerHits = lines.filter((line) => HEADER_PATTERN.test(line.text)).length
    if (headerHits === 0) return 0

    const brandHit = lines.some((line) => /New Horizons|NHCU/i.test(line.text))
    // Three or more of this exact header shape is conclusive on its own; the
    // brand string is a bonus rather than a requirement, since a statement's
    // first page may be the only one carrying the credit union's name.
    const base = headerHits >= 3 ? 0.9 : 0.6
    return Math.min(1, base + (brandHit ? 0.1 : 0))
  },

  parse(lines: StatementLine[]): StatementParseResult {
    const rows: RawStatementRow[] = []
    const unparsedLines: StatementLine[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (NOISE_PATTERN.test(line.text)) continue

      const headerMatch = HEADER_PATTERN.exec(line.text)
      if (!headerMatch) continue

      const [, printedDate, transactionType, tail = ""] = headerMatch
      const split = splitAmountAndBalance(tail)
      if (!split) {
        // A header-shaped line whose tail has no amount/balance pair is a
        // genuine parse failure worth reporting, not silent noise.
        unparsedLines.push(line)
        continue
      }

      const direction = isDebit(transactionType) ? "debit" : "credit"
      const notesParts = [split.descriptor].filter((part) => part.length > 0)

      // Page breaks inject footers/headers between a transaction line and its
      // continuation — skip over any run of boilerplate to find the real next
      // content line.
      let next = i + 1
      while (next < lines.length && NOISE_PATTERN.test(lines[next].text)) next++
      const continuation = next < lines.length ? lines[next] : undefined

      const embedded = EMBEDDED_MERCHANT_PATTERN.exec(split.descriptor)
      let description: string

      if (embedded) {
        // ACH/dividend rows name the merchant inline; the following line is
        // metadata (TYPE:, Annual Percentage Yield) and is kept as notes only.
        description = embedded[1].trim()
        if (continuation && !HEADER_PATTERN.test(continuation.text)) {
          notesParts.push(continuation.text)
          i = next
        }
      } else if (!continuation || HEADER_PATTERN.test(continuation.text)) {
        // No continuation line at all — the row is still emitted with an
        // empty description so validation flags it in the review table and
        // the user can type the merchant in, rather than the transaction
        // vanishing from the export.
        description = ""
      } else {
        i = next
        const continuationText = continuation.text.replace(LEADING_DATE_PATTERN, "")
        description = stripLocationSuffix(continuationText)
        notesParts.push(continuation.text)
      }

      rows.push({
        sourceLine: line.lineNumber,
        rawDate: printedDate,
        rawDescription: description,
        rawAmount: split.rawAmount,
        direction,
        directionLabel: transactionType,
        rawNotes: notesParts.join(" | "),
        runningBalance: split.runningBalance,
      })
    }

    return {
      rows,
      unparsedLines,
      endingBalance: findEndingBalance(lines, rows),
    }
  },
}

/**
 * Finds the statement's closing balance, preferring the explicit
 * "Ending Balance" line and falling back to the running balance printed on
 * the last transaction.
 *
 * The fallback is exact rather than approximate: on a running-balance
 * statement the last row's balance column IS the closing balance. Which of
 * the two was used is reported on the result so the reconciliation prompt
 * can show the user where the number came from.
 */
function findEndingBalance(
  lines: StatementLine[],
  rows: RawStatementRow[],
): StatementBalance | null {
  const lastRow = rows.length > 0 ? rows[rows.length - 1] : undefined
  const asOfDate = lastRow ? toIsoDate(lastRow.rawDate) : null

  // Scan from the end — a multi-page statement repeats summary blocks, and
  // the final one is the authoritative closing figure.
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = ENDING_BALANCE_PATTERN.exec(lines[i].text)
    if (match) {
      const amount = Number(match[1].replace(/,/g, ""))
      if (Number.isFinite(amount)) {
        return {
          amount,
          source: "ending-balance-line",
          label: lines[i].text.trim(),
          sourceLine: lines[i].lineNumber,
          asOfDate,
        }
      }
    }
  }

  if (lastRow?.runningBalance !== undefined) {
    return {
      amount: lastRow.runningBalance,
      source: "last-running-balance",
      label: `Running balance after ${lastRow.rawDate} ${lastRow.rawDescription}`.trim(),
      sourceLine: lastRow.sourceLine,
      asOfDate,
    }
  }

  return null
}
