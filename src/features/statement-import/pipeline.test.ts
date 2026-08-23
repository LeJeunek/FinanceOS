import { describe, expect, it } from "vitest"

import { UNCATEGORIZED } from "@/features/statement-import/categories"
import { generateCsv } from "@/features/statement-import/csv"
import { convertStatementText, revalidate, summarize } from "@/features/statement-import/pipeline"
import type { DraftTransaction } from "@/features/statement-import/types"

/**
 * End-to-end pipeline tests: fixture statement text in, reviewable
 * transactions out. No PDF, no network, no React — the whole converter past
 * the extraction boundary is exercised from a string, which is the point of
 * keeping `extraction/` behind an interface.
 *
 * The fixture mirrors the real New Horizons Credit Union layout the original
 * `scripts/convert-statement-pdf.ts` was written against: a header line
 * carrying date/type/amount/running-balance, with the merchant on a
 * following address line.
 */
const NEW_HORIZONS_STATEMENT = [
  "New Horizons Credit Union",
  "Statement Period 08/01/2026 - 08/31/2026",
  "Account Number XXXXXX1234",
  "Date        Description",
  "Balance Forward                                    1,000.00",
  "08/03/2026 Withdrawal                      42.19      957.81",
  "WAL-MART #1234 SPANISH FORT AL",
  "08/05/2026 Recurring Withdrawal ACH NETFLIX.COM      15.99      941.82",
  "TYPE: SUBSCRIPTION",
  "08/07/2026 Deposit ACH MERIDIAN PAYROLL           2,950.00    3,891.82",
  "TYPE: DIRECT DEP",
  "08/09/2026 Withdrawal                      68.00    3,823.82",
  "SHELL OIL 5748392011 BAY MINETTE AL",
  "08/09/2026 Withdrawal                      68.00    3,755.82",
  "SHELL OIL 5748392011 BAY MINETTE AL",
  "Ending Balance                                     3,755.82",
].join("\n")

function byId(transactions: DraftTransaction[], id: string): DraftTransaction {
  const found = transactions.find((transaction) => transaction.id === id)
  if (!found) throw new Error(`No transaction ${id}`)
  return found
}

describe("convertStatementText — New Horizons statement", () => {
  const result = convertStatementText(NEW_HORIZONS_STATEMENT)

  it("selects the format-specific parser over the generic fallback", () => {
    expect(result.parserId).toBe("new-horizons-credit-union")
  })

  it("extracts every transaction and no boilerplate", () => {
    // Balance Forward / Ending Balance / period / account-number lines must
    // not become transactions.
    expect(result.transactions).toHaveLength(5)
  })

  it("parses a full transaction correctly", () => {
    expect(byId(result.transactions, "row-1")).toMatchObject({
      date: "2026-08-03",
      merchant: "Wal-mart",
      amount: -42.19,
      category: "Food",
      confidence: "confident",
    })
  })

  it("signs withdrawals negative and deposits positive", () => {
    expect(byId(result.transactions, "row-2").amount).toBe(-15.99)
    expect(byId(result.transactions, "row-3").amount).toBe(2950)
  })

  it("reads a merchant embedded in the descriptor rather than a following line", () => {
    expect(byId(result.transactions, "row-2")).toMatchObject({
      merchant: "Netflix.com",
      category: "Entertainment",
    })
  })

  it("strips city, state, and reference numbers off the address line", () => {
    expect(byId(result.transactions, "row-4")).toMatchObject({
      merchant: "Shell Oil",
      category: "Transportation",
    })
  })

  it("leaves an unrecognized merchant uncategorized rather than guessing", () => {
    expect(byId(result.transactions, "row-3")).toMatchObject({
      merchant: "Meridian Payroll",
      category: UNCATEGORIZED,
      confidence: "uncategorized",
    })
  })

  it("flags the repeated row as a duplicate without removing it", () => {
    expect(byId(result.transactions, "row-4").duplicateOfId).toBeNull()
    expect(byId(result.transactions, "row-5").duplicateOfId).toBe("row-4")
    expect(result.transactions).toHaveLength(5)
  })

  it("keeps the original statement text as notes for every row", () => {
    expect(byId(result.transactions, "row-1").notes).toContain("WAL-MART #1234 SPANISH FORT AL")
  })

  it("reads the statement's closing balance", () => {
    expect(result.endingBalance).toMatchObject({
      amount: 3755.82,
      source: "ending-balance-line",
      asOfDate: "2026-08-09",
    })
  })

  it("produces no validation errors for a clean statement", () => {
    expect(result.transactions.flatMap((transaction) => transaction.errors)).toEqual([])
  })

  it("summarizes what the user needs to look at", () => {
    const summary = summarize(result.transactions)
    expect(summary).toMatchObject({
      total: 5,
      categorized: 4,
      uncategorized: 1,
      duplicates: 1,
      invalid: 0,
    })
    // row-3 (uncategorized) and row-5 (duplicate) both need review.
    expect(summary.needsReview).toBe(2)
  })
})

describe("convertStatementText — mixed valid and invalid rows", () => {
  const STATEMENT = [
    "New Horizons Credit Union",
    "Statement Period 08/01/2026 - 08/31/2026",
    "08/03/2026 Withdrawal                      42.19      957.81",
    "KROGER 0442 MOBILE AL",
    "08/04/2026 Withdrawal                      19.00      938.81",
    "08/05/2026 Withdrawal                      pending    938.81",
  ].join("\n")

  const result = convertStatementText(STATEMENT)

  it("keeps a valid row valid", () => {
    expect(byId(result.transactions, "row-1").errors).toEqual([])
  })

  it("reports a missing merchant instead of dropping the transaction", () => {
    // Row 2 has no continuation line, so its merchant is unknown — but the
    // money moved, so the row must survive into the review table.
    const row = byId(result.transactions, "row-2")
    expect(row.amount).toBe(-19)
    expect(row.errors).toEqual([{ field: "merchant", message: "Merchant is required" }])
  })

  it("reports an unparseable amount as an unparsed line, not a silent drop", () => {
    // "pending" is not an amount, so the line never becomes a transaction —
    // it is surfaced for the user instead of disappearing.
    expect(result.transactions).toHaveLength(2)
    expect(result.unparsedLines.map((line) => line.text)).toContain(
      "08/05/2026 Withdrawal                      pending    938.81",
    )
  })
})

describe("convertStatementText — generic layouts", () => {
  it("falls back to the generic parser and flags assumed signs", () => {
    const result = convertStatementText(
      [
        "Card Statement",
        "08/03/2026  STARBUCKS STORE 1234        6.45",
        "08/04/2026  SHELL OIL                  48.10",
      ].join("\n"),
    )

    expect(result.parserId).toBe("generic-date-amount")
    expect(result.transactions).toHaveLength(2)
    // No debit/credit column exists, so every row carries a visible
    // assumption rather than a silent sign choice.
    expect(result.transactions[0].amount).toBe(-6.45)
    expect(result.transactions[0].assumptions[0]).toMatch(/treated as money out/)
    expect(result.transactions[0].category).toBe("Food")
  })

  it("honors an explicit CR marker over the assumed direction", () => {
    const result = convertStatementText(
      ["Card Statement", "08/03/2026  PAYMENT THANK YOU        250.00 CR"].join("\n"),
    )
    expect(result.transactions[0].amount).toBe(250)
  })

  it("reports nothing found when no parser recognizes the document", () => {
    const result = convertStatementText("This is a letter from your bank.\nThank you.")
    expect(result.parserId).toBe("none")
    expect(result.transactions).toEqual([])
  })
})

describe("revalidate", () => {
  it("re-checks and re-dedupes after a manual edit without re-categorizing", () => {
    const result = convertStatementText(NEW_HORIZONS_STATEMENT)
    const edited = result.transactions.map((transaction) =>
      transaction.id === "row-3"
        ? { ...transaction, category: "Misc", confidence: "manual" as const, isEdited: true }
        : transaction,
    )

    const revalidated = revalidate(edited)
    const row = byId(revalidated, "row-3")

    expect(row.category).toBe("Misc")
    expect(row.confidence).toBe("manual")
    expect(row.errors).toEqual([])
  })

  it("clears a duplicate flag once the user fixes the duplicated row", () => {
    const result = convertStatementText(NEW_HORIZONS_STATEMENT)
    const edited = result.transactions.map((transaction) =>
      transaction.id === "row-5" ? { ...transaction, date: "2026-08-10" } : transaction,
    )

    expect(byId(revalidate(edited), "row-5").duplicateOfId).toBeNull()
  })

  it("rejects a category the user does not have", () => {
    const result = convertStatementText(NEW_HORIZONS_STATEMENT)
    const edited = result.transactions.map((transaction) =>
      transaction.id === "row-1" ? { ...transaction, category: "Crypto Moonshots" } : transaction,
    )

    expect(byId(revalidate(edited), "row-1").errors).toEqual([
      { field: "category", message: '"Crypto Moonshots" is not one of your categories' },
    ])
  })

  it("accepts a user's own custom category", () => {
    const result = convertStatementText(NEW_HORIZONS_STATEMENT, {
      allowedCategories: ["Food", "Pets", "Misc"],
    })
    const edited = result.transactions.map((transaction) =>
      transaction.id === "row-1" ? { ...transaction, category: "Pets" } : transaction,
    )

    expect(
      byId(revalidate(edited, { allowedCategories: ["Food", "Pets", "Misc"] }), "row-1").errors,
    ).toEqual([])
  })
})

describe("CSV export of a converted statement", () => {
  it("produces an import-ready file", () => {
    const result = convertStatementText(NEW_HORIZONS_STATEMENT)
    const csv = generateCsv(result.transactions.filter((row) => row.duplicateOfId === null))
    const lines = csv.trimEnd().split("\n")

    expect(lines[0]).toBe("date,merchant,amount,category,notes")
    expect(lines).toHaveLength(5)
    expect(lines[1]).toMatch(/^2026-08-03,Wal-mart,-42\.19,Food,/)
    expect(lines[3]).toMatch(/^2026-08-07,Meridian Payroll,2950\.00,Uncategorized,/)
  })
})
