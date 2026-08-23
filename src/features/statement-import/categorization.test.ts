import { describe, expect, it } from "vitest"

import { buildAllowedCategories, UNCATEGORIZED } from "@/features/statement-import/categories"
import { classifyTransaction } from "@/features/statement-import/categorization/classify"
import { CATEGORY_RULES } from "@/features/statement-import/categorization/rules"
import { DEFAULT_CATEGORIES } from "@/features/categories/default-categories"

const ALLOWED = buildAllowedCategories()

function categoryOf(merchant: string, notes = ""): string {
  return classifyTransaction(merchant, notes, ALLOWED).category
}

describe("category vocabulary", () => {
  it("uses the app's 11 system categories plus the Uncategorized sentinel", () => {
    expect(ALLOWED).toHaveLength(DEFAULT_CATEGORIES.length + 1)
    expect(ALLOWED).toContain("Housing")
    expect(ALLOWED).toContain(UNCATEGORIZED)
  })

  it("never targets a category that does not exist", () => {
    const systemNames = new Set(DEFAULT_CATEGORIES.map((category) => category.name))
    for (const rule of CATEGORY_RULES) {
      expect(systemNames.has(rule.category)).toBe(true)
    }
  })
})

describe("classifyTransaction", () => {
  it("matches known merchants exactly", () => {
    expect(categoryOf("Walmart")).toBe("Food")
    expect(categoryOf("Kroger")).toBe("Food")
    expect(categoryOf("Shell")).toBe("Transportation")
    expect(categoryOf("Netflix")).toBe("Entertainment")
  })

  it("is case-insensitive and tolerates statement formatting", () => {
    expect(categoryOf("NETFLIX.COM")).toBe("Entertainment")
    expect(categoryOf("netflix")).toBe("Entertainment")
    expect(categoryOf("Shell Oil #4821")).toBe("Transportation")
  })

  it("matches on keywords within a longer merchant name", () => {
    expect(categoryOf("Gulf Coast Dental Care")).toBe("Healthcare")
    expect(categoryOf("Riverside Apartments LLC")).toBe("Housing")
    expect(categoryOf("Geico Auto Insurance")).toBe("Insurance")
  })

  it("lets the longest keyword win when two categories could match", () => {
    // "max" (Entertainment) is a substring of "tj maxx" (Shopping).
    expect(categoryOf("TJ Maxx")).toBe("Shopping")
    // "amazon" (Shopping) vs "prime video" (Entertainment).
    expect(categoryOf("Amazon Prime Video")).toBe("Entertainment")
  })

  it("respects word boundaries so short keywords do not over-match", () => {
    expect(categoryOf("BPay Services")).not.toBe("Transportation")
  })

  it("reports confidence honestly", () => {
    expect(classifyTransaction("Netflix", "", ALLOWED).confidence).toBe("confident")
    expect(classifyTransaction("Zzyzx Holdings", "", ALLOWED).confidence).toBe("uncategorized")
  })

  it("falls back to notes only as a weak match", () => {
    const result = classifyTransaction("Sq Payments", "POS PURCHASE STARBUCKS STORE", ALLOWED)
    expect(result.category).toBe("Food")
    expect(result.confidence).toBe("weak")
  })

  it("returns Uncategorized rather than guessing", () => {
    expect(categoryOf("Meridian Payroll")).toBe(UNCATEGORIZED)
    expect(categoryOf("")).toBe(UNCATEGORIZED)
  })

  it("skips rules whose category the user does not have", () => {
    // A user without an "Entertainment" category must not get one invented.
    const limited = buildAllowedCategories(["Food", "Misc"])
    expect(classifyTransaction("Netflix", "", limited).category).toBe(UNCATEGORIZED)
    expect(classifyTransaction("Kroger", "", limited).category).toBe("Food")
  })

  it("returns the user's own casing for a category", () => {
    const limited = buildAllowedCategories(["food"])
    expect(classifyTransaction("Kroger", "", limited).category).toBe("food")
  })
})
