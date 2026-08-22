import { computeAmortization } from "@/features/debt/payoff-math"
import type { PayoffDebtInput } from "@/features/debt/types"

/**
 * One-time lump-sum allocation math — "I have a spare $600, where should it
 * go?"
 *
 * This is a genuinely different question from the one
 * `compareSnowballAndAvalanche` answers. That function models a **recurring
 * monthly extra payment** and simulates the rollover cascade as each debt
 * clears. This one models a **single windfall applied today**, split across
 * debts, with ordinary minimum payments continuing afterward. The answers
 * differ, and conflating them would give the user the wrong number.
 *
 * PURE and isomorphic, per naming-standards.md's "(Phase 3a) Isomorphic
 * pure-calculation files" rule and the precedent set by `payoff-math.ts`
 * (which lives at the feature root for exactly this reason): the advisor UI
 * recomputes on every keystroke of the amount input with no server round
 * trip. Never imports `lib/db.ts` or `lib/auth.ts`.
 *
 * **The model.** Baseline and post-payment projections both assume each debt
 * is paid at its own minimum every month, with no new charges — the same
 * assumption `computeAmortization` (and therefore the Debt page's existing
 * per-debt projections) already makes. A lump sum reduces a balance today;
 * the interest saved is the difference between the two projections.
 *
 * **Why highest-APR-first is the answer.** Interest accrues per dollar of
 * balance at each debt's own rate, so a dollar moved off the highest-rate
 * balance stops the most interest, every month, for the rest of that debt's
 * life. No ordering beats it for total interest paid. Snowball (smallest
 * balance first) and an even split are computed alongside it so the advisor
 * can *show* the difference rather than assert it — and so a user who values
 * clearing a card outright can see exactly what that preference costs.
 *
 * **Known simplification.** Clearing a debt outright frees its minimum
 * payment, which a user would then redirect at the remaining debts. That
 * rollover is not modeled here, so real-world savings are equal to or better
 * than what this reports — never worse. The advisor says so rather than
 * quietly overstating precision.
 */

/** Matches `payoff-math.ts`'s own epsilon — sub-cent float noise is not a
 * balance. */
const EPSILON = 0.005

export type LumpSumStrategyId = "avalanche" | "snowball" | "even-split"

export interface LumpSumAllocation {
  debtId: string
  /** Dollars from the lump sum directed at this debt. */
  amount: number
  balanceBefore: number
  balanceAfter: number
  interestRate: number
  /** True when this allocation clears the debt entirely. */
  paysOff: boolean
}

export interface LumpSumStrategyResult {
  strategy: LumpSumStrategyId
  label: string
  allocations: LumpSumAllocation[]
  /** Total interest still to be paid across all debts after this allocation.
   * `null` when at least one debt remains in negative amortization, where
   * "total interest" has no finite value. */
  totalInterestAfter: number | null
  /** Baseline interest minus `totalInterestAfter`. `null` means the payment
   * rescues a debt from negative amortization, where the saving is real but
   * unbounded rather than a computable figure. */
  interestSaved: number | null
  /** Months shaved off the last debt's payoff date. `null` under the same
   * negative-amortization condition. */
  monthsSaved: number | null
  /** How many debts this allocation clears outright. */
  debtsCleared: number
}

export interface LumpSumPlan {
  lumpSum: number
  /** Total interest across all debts if the lump sum is not applied. */
  baselineTotalInterest: number | null
  baselineMonthsToDebtFree: number | null
  /** The interest-minimizing allocation — always the avalanche result. */
  recommended: LumpSumStrategyResult
  /** Snowball and even-split, for comparison. */
  alternatives: LumpSumStrategyResult[]
  /** Ids of debts whose minimum payment does not cover their own interest.
   * These grow every month and are prioritized first. */
  negativeAmortizationDebtIds: string[]
  /** True when the lump sum is at least the total of every balance. */
  clearsAllDebt: boolean
}

/** Sums per-debt interest, propagating `null` (negative amortization) rather
 * than silently treating an unbounded total as zero. */
function totalInterestOf(debts: readonly PayoffDebtInput[], now: Date): number | null {
  let total = 0
  for (const debt of debts) {
    if (debt.balance <= EPSILON) continue
    const projection = computeAmortization(debt, now)
    if (projection.totalInterestRemaining === null) return null
    total += projection.totalInterestRemaining
  }
  return round(total)
}

/** Months until the LAST debt is paid off — the debt-free date. */
function monthsToDebtFreeOf(debts: readonly PayoffDebtInput[], now: Date): number | null {
  let longest = 0
  for (const debt of debts) {
    if (debt.balance <= EPSILON) continue
    const projection = computeAmortization(debt, now)
    if (projection.monthsToPayoff === null) return null
    longest = Math.max(longest, projection.monthsToPayoff)
  }
  return longest
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Applies an allocation to produce the post-payment debt set.
 *
 * A debt cleared to zero keeps its (now irrelevant) minimum payment in the
 * returned shape; `computeAmortization` short-circuits on `balance <= 0`, so
 * it contributes no further interest either way.
 */
function applyAllocations(
  debts: readonly PayoffDebtInput[],
  allocations: readonly LumpSumAllocation[],
): PayoffDebtInput[] {
  const byId = new Map(allocations.map((allocation) => [allocation.debtId, allocation.amount]))
  return debts.map((debt) => ({
    ...debt,
    balance: round(Math.max(0, debt.balance - (byId.get(debt.id) ?? 0))),
  }))
}

/** Walks an ordered debt list, spending the lump sum on each in turn. */
function allocateInOrder(
  ordered: readonly PayoffDebtInput[],
  lumpSum: number,
): LumpSumAllocation[] {
  let remaining = lumpSum
  const allocations: LumpSumAllocation[] = []

  for (const debt of ordered) {
    if (remaining <= EPSILON) break
    if (debt.balance <= EPSILON) continue

    const amount = round(Math.min(remaining, debt.balance))
    remaining = round(remaining - amount)

    allocations.push({
      debtId: debt.id,
      amount,
      balanceBefore: debt.balance,
      balanceAfter: round(debt.balance - amount),
      interestRate: debt.interestRate,
      paysOff: debt.balance - amount <= EPSILON,
    })
  }

  return allocations
}

/**
 * Splits the lump sum equally, then redistributes whatever overflows a
 * debt's balance across the debts that can still absorb it — so an even
 * split never wastes money on an already-cleared balance.
 */
function allocateEvenly(
  debts: readonly PayoffDebtInput[],
  lumpSum: number,
): LumpSumAllocation[] {
  const active = debts.filter((debt) => debt.balance > EPSILON)
  if (active.length === 0) return []

  const applied = new Map<string, number>(active.map((debt) => [debt.id, 0]))
  let remaining = lumpSum

  // Repeat until the money is spent or every balance is covered: each pass
  // shares what is left equally among debts that still have room.
  while (remaining > EPSILON) {
    const absorbers = active.filter(
      (debt) => debt.balance - (applied.get(debt.id) ?? 0) > EPSILON,
    )
    if (absorbers.length === 0) break

    const share = remaining / absorbers.length
    let spentThisPass = 0

    for (const debt of absorbers) {
      const already = applied.get(debt.id) ?? 0
      const room = debt.balance - already
      const amount = Math.min(share, room)
      applied.set(debt.id, already + amount)
      spentThisPass += amount
    }

    remaining -= spentThisPass
    if (spentThisPass <= EPSILON) break
  }

  return active
    .map((debt) => {
      const amount = round(applied.get(debt.id) ?? 0)
      return {
        debtId: debt.id,
        amount,
        balanceBefore: debt.balance,
        balanceAfter: round(debt.balance - amount),
        interestRate: debt.interestRate,
        paysOff: debt.balance - amount <= EPSILON,
      }
    })
    .filter((allocation) => allocation.amount > EPSILON)
}

/**
 * Orders debts highest-APR-first, with two refinements:
 *   - A debt in negative amortization comes first regardless of rate. Its
 *     balance is *growing*; no ordinary rate comparison captures how bad that
 *     is, and reducing it is the only thing that stops the bleeding.
 *   - Ties on rate break toward the smaller balance, which clears a card
 *     sooner at identical interest cost.
 */
function avalancheOrder(debts: readonly PayoffDebtInput[], now: Date): PayoffDebtInput[] {
  const negative = new Set(
    debts
      .filter((debt) => computeAmortization(debt, now).isNegativeAmortization)
      .map((debt) => debt.id),
  )

  return [...debts].sort((left, right) => {
    const leftNegative = negative.has(left.id) ? 1 : 0
    const rightNegative = negative.has(right.id) ? 1 : 0
    if (leftNegative !== rightNegative) return rightNegative - leftNegative
    if (right.interestRate !== left.interestRate) return right.interestRate - left.interestRate
    return left.balance - right.balance
  })
}

/** Smallest balance first — the snowball ordering, kept for comparison. */
function snowballOrder(debts: readonly PayoffDebtInput[]): PayoffDebtInput[] {
  return [...debts].sort((left, right) => left.balance - right.balance)
}

function buildStrategy(
  strategy: LumpSumStrategyId,
  label: string,
  debts: readonly PayoffDebtInput[],
  allocations: LumpSumAllocation[],
  baselineInterest: number | null,
  baselineMonths: number | null,
  now: Date,
): LumpSumStrategyResult {
  const after = applyAllocations(debts, allocations)
  const totalInterestAfter = totalInterestOf(after, now)
  const monthsAfter = monthsToDebtFreeOf(after, now)

  const interestSaved =
    baselineInterest === null || totalInterestAfter === null
      ? null
      : round(baselineInterest - totalInterestAfter)

  const monthsSaved =
    baselineMonths === null || monthsAfter === null ? null : baselineMonths - monthsAfter

  return {
    strategy,
    label,
    allocations,
    totalInterestAfter,
    interestSaved,
    monthsSaved,
    debtsCleared: allocations.filter((allocation) => allocation.paysOff).length,
  }
}

/**
 * Builds the full advice for applying `lumpSum` across `debts`.
 *
 * Returns `null` when there is nothing to advise on — no active debt, or a
 * non-positive amount — so the UI can simply not render rather than showing
 * a plan full of zeroes.
 */
export function buildLumpSumPlan(
  debts: readonly PayoffDebtInput[],
  lumpSum: number,
  now: Date = new Date(),
): LumpSumPlan | null {
  const active = debts.filter((debt) => debt.balance > EPSILON)
  if (active.length === 0 || lumpSum <= EPSILON) return null

  const baselineTotalInterest = totalInterestOf(active, now)
  const baselineMonthsToDebtFree = monthsToDebtFreeOf(active, now)

  const negativeAmortizationDebtIds = active
    .filter((debt) => computeAmortization(debt, now).isNegativeAmortization)
    .map((debt) => debt.id)

  const recommended = buildStrategy(
    "avalanche",
    "Highest interest rate first",
    active,
    allocateInOrder(avalancheOrder(active, now), lumpSum),
    baselineTotalInterest,
    baselineMonthsToDebtFree,
    now,
  )

  const alternatives = [
    buildStrategy(
      "snowball",
      "Smallest balance first",
      active,
      allocateInOrder(snowballOrder(active), lumpSum),
      baselineTotalInterest,
      baselineMonthsToDebtFree,
      now,
    ),
    buildStrategy(
      "even-split",
      "Split evenly",
      active,
      allocateEvenly(active, lumpSum),
      baselineTotalInterest,
      baselineMonthsToDebtFree,
      now,
    ),
  ]

  const totalBalance = active.reduce((sum, debt) => sum + debt.balance, 0)

  return {
    lumpSum,
    baselineTotalInterest,
    baselineMonthsToDebtFree,
    recommended,
    alternatives,
    negativeAmortizationDebtIds,
    clearsAllDebt: lumpSum + EPSILON >= totalBalance,
  }
}

/**
 * How much better the recommended allocation is than the best alternative —
 * the number that answers "does it actually matter where I put it?".
 *
 * Returns `0` when every strategy ties (one debt, or a lump sum large enough
 * to clear everything), which the UI reports plainly instead of manufacturing
 * a distinction that does not exist.
 */
export function advantageOverAlternatives(plan: LumpSumPlan): number | null {
  if (plan.recommended.interestSaved === null) return null

  const alternativeSavings = plan.alternatives
    .map((alternative) => alternative.interestSaved)
    .filter((saved): saved is number => saved !== null)

  if (alternativeSavings.length === 0) return null

  return round(plan.recommended.interestSaved - Math.max(...alternativeSavings))
}
