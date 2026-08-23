import { describe, expect, it } from "vitest"

import { advantageOverAlternatives, buildLumpSumPlan } from "@/features/debt/lump-sum"
import type { PayoffDebtInput } from "@/features/debt/types"

/** Fixed clock so projections are deterministic — same convention as
 * `payoff-math.test.ts`. */
const NOW = new Date("2026-08-01T00:00:00.000Z")

/** The scenario this feature exists for: two cards, one small balance at a
 * low rate, one larger balance at a much higher rate. */
const HIGH_RATE_CARD: PayoffDebtInput = {
  id: "card-high",
  balance: 4200,
  interestRate: 24.99,
  minimumPayment: 120,
}

const LOW_RATE_CARD: PayoffDebtInput = {
  id: "card-low",
  balance: 1500,
  interestRate: 9.5,
  minimumPayment: 50,
}

const TWO_CARDS = [HIGH_RATE_CARD, LOW_RATE_CARD]

function allocationFor(
  allocations: { debtId: string; amount: number }[],
  debtId: string,
): number {
  return allocations.find((allocation) => allocation.debtId === debtId)?.amount ?? 0
}

describe("buildLumpSumPlan — the $600 question", () => {
  const plan = buildLumpSumPlan(TWO_CARDS, 600, NOW)!

  it("puts the whole lump sum on the highest-rate card", () => {
    expect(allocationFor(plan.recommended.allocations, "card-high")).toBe(600)
    expect(allocationFor(plan.recommended.allocations, "card-low")).toBe(0)
  })

  it("saves more interest than any alternative", () => {
    const saved = plan.recommended.interestSaved!
    for (const alternative of plan.alternatives) {
      expect(saved).toBeGreaterThan(alternative.interestSaved!)
    }
    expect(advantageOverAlternatives(plan)).toBeGreaterThan(0)
  })

  it("saves a real, positive amount of interest against doing nothing", () => {
    expect(plan.recommended.interestSaved).toBeGreaterThan(0)
    expect(plan.recommended.totalInterestAfter).toBeLessThan(plan.baselineTotalInterest!)
  })

  it("does not claim to clear a debt it cannot", () => {
    expect(plan.recommended.debtsCleared).toBe(0)
    expect(plan.clearsAllDebt).toBe(false)
  })

  it("offers snowball and even-split for comparison", () => {
    expect(plan.alternatives.map((alternative) => alternative.strategy)).toEqual([
      "snowball",
      "even-split",
    ])
    // Snowball targets the smaller balance, which here is the cheaper debt.
    expect(allocationFor(plan.alternatives[0].allocations, "card-low")).toBe(600)
    // An even split puts $300 on each.
    expect(allocationFor(plan.alternatives[1].allocations, "card-high")).toBe(300)
    expect(allocationFor(plan.alternatives[1].allocations, "card-low")).toBe(300)
  })
})

describe("buildLumpSumPlan — allocation mechanics", () => {
  it("cascades overflow to the next-highest rate once a card is cleared", () => {
    const plan = buildLumpSumPlan(TWO_CARDS, 5000, NOW)!
    expect(allocationFor(plan.recommended.allocations, "card-high")).toBe(4200)
    expect(allocationFor(plan.recommended.allocations, "card-low")).toBe(800)
    expect(plan.recommended.debtsCleared).toBe(1)
  })

  it("never allocates more than a balance", () => {
    const plan = buildLumpSumPlan(TWO_CARDS, 99_999, NOW)!
    const total = plan.recommended.allocations.reduce(
      (sum, allocation) => sum + allocation.amount,
      0,
    )
    expect(total).toBe(5700)
    expect(plan.clearsAllDebt).toBe(true)
    expect(plan.recommended.totalInterestAfter).toBe(0)
  })

  it("redistributes an even split's overflow instead of wasting it", () => {
    // $3,000 split evenly would put $1,500 on each — exactly clearing the
    // small card — so nothing overflows; $4,000 must push the excess onto the
    // card that can still absorb it.
    const plan = buildLumpSumPlan(TWO_CARDS, 4000, NOW)!
    const evenSplit = plan.alternatives[1]
    expect(allocationFor(evenSplit.allocations, "card-low")).toBe(1500)
    expect(allocationFor(evenSplit.allocations, "card-high")).toBe(2500)
  })

  it("breaks a rate tie toward the smaller balance", () => {
    const plan = buildLumpSumPlan(
      [
        { id: "big", balance: 3000, interestRate: 20, minimumPayment: 90 },
        { id: "small", balance: 800, interestRate: 20, minimumPayment: 30 },
      ],
      500,
      NOW,
    )!
    expect(allocationFor(plan.recommended.allocations, "small")).toBe(500)
  })

  it("ignores debts that are already paid off", () => {
    const plan = buildLumpSumPlan(
      [HIGH_RATE_CARD, { id: "cleared", balance: 0, interestRate: 30, minimumPayment: 25 }],
      600,
      NOW,
    )!
    expect(allocationFor(plan.recommended.allocations, "cleared")).toBe(0)
    expect(allocationFor(plan.recommended.allocations, "card-high")).toBe(600)
  })
})

describe("buildLumpSumPlan — edge cases", () => {
  it("returns null when there is nothing to advise on", () => {
    expect(buildLumpSumPlan([], 600, NOW)).toBeNull()
    expect(buildLumpSumPlan(TWO_CARDS, 0, NOW)).toBeNull()
    expect(buildLumpSumPlan(TWO_CARDS, -50, NOW)).toBeNull()
    expect(
      buildLumpSumPlan([{ id: "x", balance: 0, interestRate: 20, minimumPayment: 25 }], 600, NOW),
    ).toBeNull()
  })

  it("ties every strategy when there is only one debt, and says so", () => {
    const plan = buildLumpSumPlan([HIGH_RATE_CARD], 600, NOW)!
    expect(advantageOverAlternatives(plan)).toBe(0)
  })

  it("prioritizes a debt whose minimum does not cover its interest", () => {
    // $150/mo minimum against $9,000 at 29.99% accrues ~$225/mo — the balance
    // grows forever. Rate alone would rank the 31% card first; the growing
    // balance must outrank it.
    const plan = buildLumpSumPlan(
      [
        { id: "growing", balance: 9000, interestRate: 29.99, minimumPayment: 150 },
        { id: "steep", balance: 1000, interestRate: 31, minimumPayment: 200 },
      ],
      600,
      NOW,
    )!
    expect(plan.negativeAmortizationDebtIds).toEqual(["growing"])
    expect(allocationFor(plan.recommended.allocations, "growing")).toBe(600)
  })

  it("reports unbounded rather than fake savings while a balance still grows", () => {
    const plan = buildLumpSumPlan(
      [{ id: "growing", balance: 9000, interestRate: 29.99, minimumPayment: 150 }],
      600,
      NOW,
    )!
    expect(plan.baselineTotalInterest).toBeNull()
    expect(plan.recommended.interestSaved).toBeNull()
    expect(advantageOverAlternatives(plan)).toBeNull()
  })

  it("handles a 0% debt without dividing by zero", () => {
    const plan = buildLumpSumPlan(
      [
        { id: "zero", balance: 2000, interestRate: 0, minimumPayment: 100 },
        { id: "paid", balance: 2000, interestRate: 18, minimumPayment: 100 },
      ],
      600,
      NOW,
    )!
    // A 0% balance costs nothing to carry, so every dollar goes to the 18%.
    expect(allocationFor(plan.recommended.allocations, "paid")).toBe(600)
    expect(plan.recommended.interestSaved).toBeGreaterThan(0)
  })
})
