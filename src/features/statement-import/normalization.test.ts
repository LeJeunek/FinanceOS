import { describe, expect, it } from "vitest"

import { parseAmountText, resolveSignedAmount } from "@/features/statement-import/normalization/amount"
import {
  inferStatementYear,
  normalizeDate,
} from "@/features/statement-import/normalization/date"
import { normalizeMerchant } from "@/features/statement-import/normalization/merchant"

describe("amount normalization", () => {
  it("reads the notations statements actually print", () => {
    expect(parseAmountText("$42.19")?.magnitude).toBe(42.19)
    expect(parseAmountText("1,245.32")?.magnitude).toBe(1245.32)
    expect(parseAmountText("(42.19)")).toMatchObject({ magnitude: 42.19, printedSign: -1 })
    expect(parseAmountText("-$42.19")).toMatchObject({ magnitude: 42.19, printedSign: -1 })
    expect(parseAmountText("42.19-")).toMatchObject({ magnitude: 42.19, printedSign: -1 })
    expect(parseAmountText("42.19 CR")).toMatchObject({ inlineDirection: "credit" })
  })

  it("rejects text that is not a number rather than guessing", () => {
    expect(parseAmountText("")).toBeNull()
    expect(parseAmountText("N/A")).toBeNull()
    expect(parseAmountText("--")).toBeNull()
    expect(parseAmountText("12.34.56")).toBeNull()
  })

  it("applies FinanceOS's sign convention from the debit/credit column", () => {
    // A withdrawal is money out. This is the exact bug in the original
    // scripts/convert-statement-pdf.ts, which wrote every amount positive.
    expect(resolveSignedAmount("42.19", "debit")?.amount).toBe(-42.19)
    expect(resolveSignedAmount("2,950.00", "credit")?.amount).toBe(2950)
  })

  it("keeps a printed sign and reports the conflict when the column disagrees", () => {
    const result = resolveSignedAmount("(42.19)", "credit")
    expect(result?.amount).toBe(-42.19)
    expect(result?.assumptions).toHaveLength(1)
    expect(result?.assumptions[0]).toMatch(/kept the printed sign/)
  })

  it("records an assumption when nothing indicates direction", () => {
    const result = resolveSignedAmount("42.19", "unknown")
    expect(result?.amount).toBe(-42.19)
    expect(result?.assumptions[0]).toMatch(/treated as money out/)
  })

  it("returns null for an unparseable amount instead of zero", () => {
    expect(resolveSignedAmount("", "debit")).toBeNull()
    expect(resolveSignedAmount("pending", "debit")).toBeNull()
  })
})

describe("date normalization", () => {
  it("normalizes the common statement formats to yyyy-mm-dd", () => {
    expect(normalizeDate("08/21/2026")?.iso).toBe("2026-08-21")
    expect(normalizeDate("08-21-2026")?.iso).toBe("2026-08-21")
    expect(normalizeDate("Aug 21, 2026")?.iso).toBe("2026-08-21")
    expect(normalizeDate("August 21 2026")?.iso).toBe("2026-08-21")
    expect(normalizeDate("2026-08-21")?.iso).toBe("2026-08-21")
  })

  it("will not invent a year, and records the one it is given", () => {
    expect(normalizeDate("08/21")).toBeNull()

    const withFallback = normalizeDate("08/21", { fallbackYear: 2026 })
    expect(withFallback?.iso).toBe("2026-08-21")
    expect(withFallback?.assumptions[0]).toMatch(/no year/)
  })

  it("expands a two-digit year and says so", () => {
    const result = normalizeDate("08/21/26")
    expect(result?.iso).toBe("2026-08-21")
    expect(result?.assumptions[0]).toMatch(/two-digit year/)
  })

  it("swaps day/month when the first number cannot be a month", () => {
    const result = normalizeDate("21/08/2026")
    expect(result?.iso).toBe("2026-08-21")
    expect(result?.assumptions[0]).toMatch(/day\/month/)
  })

  it("rejects impossible calendar dates", () => {
    expect(normalizeDate("02/30/2026")).toBeNull()
    expect(normalizeDate("13/45/2026")).toBeNull()
    expect(normalizeDate("not a date")).toBeNull()
  })

  it("infers the statement year from the document's most common year", () => {
    expect(inferStatementYear("Statement Period 08/01/2026 - 08/31/2026\n08/03/2026 x")).toBe(2026)
    expect(inferStatementYear("no years here")).toBeUndefined()
  })
})

describe("merchant normalization", () => {
  it("strips processor prefixes and store numbers", () => {
    expect(normalizeMerchant("SQ *WALMART #1234")).toBe("Walmart")
    expect(normalizeMerchant("TST* LOCAL BISTRO")).toBe("Local Bistro")
    expect(normalizeMerchant("POS DEBIT WALGREENS #4821")).toBe("Walgreens")
  })

  it("strips reference numbers and phone numbers", () => {
    expect(normalizeMerchant("NETFLIX.COM 8665797172")).toBe("Netflix.com")
    expect(normalizeMerchant("CITY UTILITIES 251-555-1234")).toBe("City Utilities")
  })

  it("title-cases all-caps names but leaves deliberate casing alone", () => {
    expect(normalizeMerchant("BURGER KING")).toBe("Burger King")
    expect(normalizeMerchant("iTunes")).toBe("iTunes")
    expect(normalizeMerchant("CVS PHARMACY")).toBe("CVS Pharmacy")
  })

  it("never erases the whole name", () => {
    expect(normalizeMerchant("7847")).toBe("7847")
    expect(normalizeMerchant("   ")).toBe("")
  })
})
