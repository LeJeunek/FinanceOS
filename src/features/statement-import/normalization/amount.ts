import type { LedgerDirection } from "@/features/statement-import/types"

/**
 * Amount normalization: printed statement text -> a signed `number`.
 *
 * The guiding rule for this file is that the converter must never silently
 * change what a row *means*. Two consequences shape the API below:
 *
 * 1. Magnitude parsing and sign resolution are separate steps. Reading the
 *    characters `"(1,245.32)"` as the quantity 1245.32 is mechanical;
 *    deciding that a withdrawal is money leaving the account is an
 *    interpretation, and interpretations are made explicitly in
 *    `resolveSignedAmount` and recorded as assumptions the user can see.
 * 2. An explicit sign printed on the statement always beats the
 *    debit/credit column. If the two disagree, the printed sign wins and the
 *    disagreement is reported rather than quietly resolved.
 *
 * FinanceOS's sign convention (money out is negative, money in is positive)
 * is the target: see `features/demo/fixtures/transactions.ts` (Netflix
 * `-15.99`, payroll `+2950`) and `features/transactions/server/
 * balance-adjustment.ts`, which increments `Account.balance` by the signed
 * amount.
 */

/** Currency symbols and separators stripped before numeric parsing. Covers
 * the symbols that realistically appear on a US bank/credit-card statement
 * plus the two most common non-US ones; anything else falls through to the
 * `Number()` check below and is reported as unparseable rather than guessed
 * at. */
const CURRENCY_NOISE_PATTERN = /[$£€¥\s,]/g

/** A trailing `CR`/`DR` marker, the other common way statements encode
 * direction inline with the amount (e.g. `"42.19 CR"`). */
const TRAILING_CREDIT_DEBIT_PATTERN = /\s*(CR|DR)\s*$/i

export interface ParsedAmountText {
  /** Always >= 0 — the quantity with any sign notation removed. */
  magnitude: number
  /** The sign the statement actually printed, or `null` when the text
   * carried no sign notation at all (a bare `"42.19"`). */
  printedSign: -1 | 1 | null
  /** Direction implied by an inline `CR`/`DR` marker, if present. */
  inlineDirection: LedgerDirection
}

/**
 * Reads the numeric quantity and any sign notation out of a printed amount.
 *
 * Handles, in this order: a trailing `CR`/`DR` marker, surrounding
 * parentheses (the accounting negative convention), a leading or trailing
 * minus/en-dash, a leading plus, currency symbols, and thousands separators.
 * Returns `null` for anything that does not reduce to a finite number — the
 * caller surfaces that as a row-level validation error instead of importing
 * a wrong number.
 */
export function parseAmountText(raw: string): ParsedAmountText | null {
  let text = raw.trim()
  if (text.length === 0) return null

  let inlineDirection: LedgerDirection = "unknown"
  const creditDebitMatch = TRAILING_CREDIT_DEBIT_PATTERN.exec(text)
  if (creditDebitMatch) {
    inlineDirection = creditDebitMatch[1].toUpperCase() === "CR" ? "credit" : "debit"
    text = text.replace(TRAILING_CREDIT_DEBIT_PATTERN, "").trim()
  }

  let printedSign: -1 | 1 | null = null

  if (text.startsWith("(") && text.endsWith(")")) {
    printedSign = -1
    text = text.slice(1, -1).trim()
  }

  // A minus may sit on either end ("-42.19" or "42.19-", the latter being a
  // mainframe-era convention some credit unions still print). Both are
  // checked before currency noise is stripped so a lone "-" cannot survive
  // into the numeric parse.
  if (/^[-–]/.test(text)) {
    printedSign = -1
    text = text.slice(1).trim()
  } else if (/[-–]$/.test(text)) {
    printedSign = -1
    text = text.slice(0, -1).trim()
  } else if (text.startsWith("+")) {
    printedSign = printedSign ?? 1
    text = text.slice(1).trim()
  }

  text = text.replace(CURRENCY_NOISE_PATTERN, "")
  if (text.length === 0 || !/^\d*\.?\d+$/.test(text)) return null

  const magnitude = Number(text)
  if (!Number.isFinite(magnitude)) return null

  return { magnitude, printedSign, inlineDirection }
}

export interface SignedAmount {
  amount: number
  /** Interpretations made while choosing the sign, surfaced in the review
   * table. Empty when the statement was unambiguous. */
  assumptions: string[]
}

/**
 * Applies FinanceOS's sign convention to a printed amount, using the
 * direction the format-specific parser detected.
 *
 * Precedence, highest first:
 *   1. A sign printed on the amount itself (`-42.19`, `(42.19)`).
 *   2. An inline `CR`/`DR` marker on the amount.
 *   3. The `direction` the parser read from a separate column
 *      ("Withdrawal"/"Deposit").
 *   4. Nothing — the amount is assumed to be a debit, and that assumption is
 *      recorded on the row. Statements that list only charges (the common
 *      credit-card case) print bare positive numbers, so debit is the right
 *      default; recording it means the user can spot and fix the exception
 *      (a payment or refund) in the review table.
 */
export function resolveSignedAmount(
  raw: string,
  direction: LedgerDirection,
): SignedAmount | null {
  const parsed = parseAmountText(raw)
  if (!parsed) return null

  const assumptions: string[] = []
  const effectiveDirection =
    parsed.inlineDirection !== "unknown" ? parsed.inlineDirection : direction

  if (parsed.printedSign !== null) {
    const signedByText = parsed.magnitude * parsed.printedSign
    const textSaysNegative = parsed.printedSign === -1
    if (
      effectiveDirection !== "unknown" &&
      textSaysNegative !== (effectiveDirection === "debit")
    ) {
      assumptions.push(
        `Statement prints this amount as ${raw.trim()} but marks it a ${effectiveDirection}; kept the printed sign.`,
      )
    }
    return { amount: signedByText, assumptions }
  }

  if (effectiveDirection === "debit") {
    return { amount: -parsed.magnitude, assumptions }
  }
  if (effectiveDirection === "credit") {
    return { amount: parsed.magnitude, assumptions }
  }

  assumptions.push(
    "No debit/credit marker on this row — treated as money out (negative). Flip the sign if it was a deposit or refund.",
  )
  return { amount: -parsed.magnitude, assumptions }
}
