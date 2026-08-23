import { describe, expect, it } from "vitest"

import { escapeCsvField, generateCsv, toCsvRow } from "@/features/statement-import/csv"
import type { DraftTransaction } from "@/features/statement-import/types"

function draft(overrides: Partial<DraftTransaction> = {}): DraftTransaction {
  return {
    id: "row-1",
    date: "2026-08-21",
    merchant: "Walmart",
    amount: -42.19,
    category: "Food",
    notes: "",
    confidence: "confident",
    isEdited: false,
    assumptions: [],
    errors: [],
    duplicateOfId: null,
    source: {
      sourceLine: 1,
      rawDate: "08/21/2026",
      rawDescription: "WALMART",
      rawAmount: "42.19",
      direction: "debit",
    },
    ...overrides,
  }
}

describe("CSV escaping", () => {
  it("leaves ordinary fields bare", () => {
    expect(escapeCsvField("Walmart")).toBe("Walmart")
  })

  it("quotes fields containing a comma", () => {
    expect(escapeCsvField("Dillard's Bakery, Inc.")).toBe('"Dillard\'s Bakery, Inc."')
  })

  it("doubles embedded quotes", () => {
    expect(escapeCsvField('The "Corner" Cafe')).toBe('"The ""Corner"" Cafe"')
  })

  it("quotes fields containing newlines", () => {
    expect(escapeCsvField("line one\nline two")).toBe('"line one\nline two"')
  })
})

describe("CSV rows", () => {
  it("preserves commas inside a merchant name", () => {
    expect(toCsvRow(draft({ merchant: "Kroger, Fuel Center" }))).toBe(
      '2026-08-21,"Kroger, Fuel Center",-42.19,Food,',
    )
  })

  it("preserves negative amounts and always writes two decimals", () => {
    expect(toCsvRow(draft({ amount: -42.1 }))).toContain(",-42.10,")
    expect(toCsvRow(draft({ amount: 2950 }))).toContain(",2950.00,")
  })

  it("writes no thousands separator or currency symbol", () => {
    expect(toCsvRow(draft({ amount: -1245.32 }))).toContain(",-1245.32,")
  })

  it("preserves notes, quoting them when needed", () => {
    expect(toCsvRow(draft({ notes: "ACH, recurring" }))).toContain(',"ACH, recurring"')
  })

  it("writes an empty amount cell rather than a zero when the amount is unknown", () => {
    // A zero here would be a silent lie about the money; empty makes the
    // importer reject the row, which is the correct outcome.
    expect(toCsvRow(draft({ amount: null }))).toBe("2026-08-21,Walmart,,Food,")
  })
})

describe("CSV file", () => {
  it("emits exactly the five expected columns in order", () => {
    const csv = generateCsv([draft()])
    expect(csv.split("\n")[0]).toBe("date,merchant,amount,category,notes")
  })

  it("emits one row per transaction and a trailing newline", () => {
    const csv = generateCsv([draft({ id: "row-1" }), draft({ id: "row-2" })])
    expect(csv.endsWith("\n")).toBe(true)
    expect(csv.trimEnd().split("\n")).toHaveLength(3)
  })

  it("emits a header-only file for an empty selection", () => {
    expect(generateCsv([])).toBe("date,merchant,amount,category,notes\n")
  })
})
