"use client"

/**
 * LumpSumAdvisor — "I have a spare $600, where should it go?"
 *
 * Answers the one-time-windfall question, which the neighbouring
 * `StrategyComparison` deliberately does not: that card models a *recurring
 * monthly* extra payment, this one models a *single* payment made now. See
 * `features/debt/lump-sum.ts` for the math and for why highest-rate-first is
 * the interest-minimizing answer.
 *
 * Same client-side-only contract as `StrategyComparison` (api-contracts.md:
 * "no server call at all after initial load") — it receives the active,
 * non-paid-off debts as a prop and recomputes on every keystroke by calling
 * the pure `buildLumpSumPlan` directly.
 *
 * The component's job is explanation, not just a number. It shows the
 * recommendation, what it saves against doing nothing, what it saves against
 * the obvious alternatives, and the one simplification the model makes — so
 * the user can judge the advice rather than take it on faith.
 */

import { useMemo, useState } from "react"
import { ArrowRight, TrendingDown } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useFormatCurrency } from "@/app/(dashboard)/currency-preference-provider"
import { advantageOverAlternatives, buildLumpSumPlan } from "@/features/debt/lump-sum"
import type { DebtWithProjection, PayoffDebtInput } from "@/features/debt/types"
import { ExtraPaymentSchema } from "@/features/debt/server/validation"

export interface LumpSumAdvisorProps {
  /** Active (non-archived), non-paid-off debts — the same list
   * `StrategyComparison` receives. */
  debts: DebtWithProjection[]
}

/** Mirrors `extra-payment-input.tsx`'s `parseExtraPaymentInput`: reuses the
 * feature's existing `ExtraPaymentSchema` (plain Zod, no server imports)
 * rather than hand-rolling a second money-input check. */
function parseAmount(raw: string): { value: number; error: string | null } {
  if (raw.trim() === "") return { value: 0, error: null }

  const numeric = Number(raw)
  if (!Number.isFinite(numeric)) {
    return { value: 0, error: "Amount must be a number" }
  }

  const parsed = ExtraPaymentSchema.safeParse(numeric)
  if (!parsed.success) {
    return { value: 0, error: parsed.error.issues[0]?.message ?? "Invalid amount" }
  }
  return { value: parsed.data, error: null }
}

function formatMonths(months: number): string {
  if (months < 12) return `${months} month${months === 1 ? "" : "s"}`
  const years = Math.floor(months / 12)
  const remainder = months % 12
  const yearPart = `${years} year${years === 1 ? "" : "s"}`
  return remainder === 0 ? yearPart : `${yearPart}, ${remainder} mo`
}

export function LumpSumAdvisor({ debts }: LumpSumAdvisorProps) {
  const formatCurrency = useFormatCurrency()
  const [raw, setRaw] = useState("")

  const { value: lumpSum, error } = parseAmount(raw)

  const payoffInputs: PayoffDebtInput[] = useMemo(
    () =>
      debts.map((debt) => ({
        id: debt.id,
        balance: debt.effectiveBalance,
        interestRate: debt.interestRate,
        minimumPayment: debt.minimumPayment,
      })),
    [debts],
  )

  const debtNameById = useMemo(
    () => new Map(debts.map((debt) => [debt.id, debt.name])),
    [debts],
  )

  const plan = useMemo(
    () => buildLumpSumPlan(payoffInputs, lumpSum),
    [payoffInputs, lumpSum],
  )

  const advantage = plan ? advantageOverAlternatives(plan) : null
  const nameOf = (debtId: string) => debtNameById.get(debtId) ?? "this debt"

  return (
    <Card>
      <CardHeader>
        <CardTitle>Where should a spare payment go?</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lump-sum">One-time amount available</Label>
          <Input
            id="lump-sum"
            type="number"
            step="0.01"
            min="0"
            placeholder="600"
            className="max-w-48"
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            aria-invalid={error !== null}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <p className="text-xs text-muted-foreground">
            A single payment you can make now — a bonus, a tax refund, money left over this
            month. Your minimum payments continue as normal.
          </p>
        </div>

        {!plan && (
          <p className="text-sm text-muted-foreground">
            Enter an amount above to see how to split it across your debts for the least
            interest.
          </p>
        )}

        {plan && (
          <div className="flex flex-col gap-4">
            {/* ---------- The recommendation ---------- */}
            <div className="rounded-lg border bg-muted/40 p-3">
              <div className="mb-2 flex items-center gap-2">
                <TrendingDown className="size-4 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                <span className="text-sm font-medium">
                  {plan.clearsAllDebt
                    ? "That clears everything you owe."
                    : plan.recommended.allocations.length === 1
                      ? `Put all ${formatCurrency(plan.lumpSum)} on ${nameOf(plan.recommended.allocations[0].debtId)}.`
                      : `Split it across ${plan.recommended.allocations.length} debts, highest rate first.`}
                </span>
              </div>

              <ul className="flex flex-col gap-1.5">
                {plan.recommended.allocations.map((allocation) => (
                  <li key={allocation.debtId} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium tabular-nums">
                      {formatCurrency(allocation.amount)}
                    </span>
                    <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    <span>{nameOf(allocation.debtId)}</span>
                    <Badge variant="outline">{allocation.interestRate}% APR</Badge>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatCurrency(allocation.balanceBefore)} →{" "}
                      {formatCurrency(allocation.balanceAfter)}
                    </span>
                    {allocation.paysOff && <Badge variant="secondary">Paid off</Badge>}
                  </li>
                ))}
              </ul>
            </div>

            {/* ---------- What it buys you ---------- */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Interest saved</p>
                <p className="text-lg font-semibold tabular-nums">
                  {plan.recommended.interestSaved === null
                    ? "Stops a growing balance"
                    : formatCurrency(plan.recommended.interestSaved)}
                </p>
                {plan.recommended.monthsSaved !== null && plan.recommended.monthsSaved > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Debt-free {formatMonths(plan.recommended.monthsSaved)} sooner
                  </p>
                )}
              </div>

              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Versus the next-best split</p>
                <p className="text-lg font-semibold tabular-nums">
                  {advantage === null
                    ? "—"
                    : advantage === 0
                      ? "No difference"
                      : `${formatCurrency(advantage)} better`}
                </p>
                <p className="text-xs text-muted-foreground">
                  {advantage === 0
                    ? "Every split costs the same here."
                    : "Extra interest avoided by choosing this order."}
                </p>
              </div>
            </div>

            {/* ---------- Why, and what else you could do ---------- */}
            {plan.negativeAmortizationDebtIds.length > 0 && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                <span className="font-medium">
                  {plan.negativeAmortizationDebtIds.map(nameOf).join(", ")}
                </span>{" "}
                {plan.negativeAmortizationDebtIds.length === 1 ? "is" : "are"} growing — the
                minimum payment does not cover the interest, so the balance rises every month
                even when you pay on time. That is why it comes first here, ahead of rate order.
              </p>
            )}

            {plan.alternatives.some((alternative) => alternative.interestSaved !== null) && (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs font-medium text-muted-foreground">If you&apos;d rather:</p>
                {plan.alternatives.map((alternative) => (
                  <div
                    key={alternative.strategy}
                    className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <span>
                      {alternative.label}
                      {alternative.allocations.length > 0 && (
                        <span className="text-muted-foreground">
                          {" "}
                          —{" "}
                          {alternative.allocations
                            .map(
                              (allocation) =>
                                `${formatCurrency(allocation.amount)} to ${nameOf(allocation.debtId)}`,
                            )
                            .join(", ")}
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {alternative.interestSaved === null
                        ? "—"
                        : `saves ${formatCurrency(alternative.interestSaved)}`}
                      {alternative.debtsCleared > 0 && ", clears a card"}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Assumes you keep paying each minimum and add no new charges. Clearing a card frees
              its minimum payment to redirect at the others, which this does not count — so real
              savings are this much or better, never less.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
