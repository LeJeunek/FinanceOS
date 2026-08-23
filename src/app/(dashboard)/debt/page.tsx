import { redirect } from "next/navigation"
import { CreditCard } from "lucide-react"

import { getCurrentUser } from "@/lib/auth"
import { getDebts } from "@/features/debt/server/service"
import { getAccounts } from "@/features/accounts/server/service"
import type { Account } from "@/features/accounts/types"
import { AddDebtButton } from "@/features/debt/components/debt-form"
import { DebtList } from "@/features/debt/components/debt-list"
import { LumpSumAdvisor } from "@/features/debt/components/lump-sum-advisor"
import { StrategyComparison } from "@/features/debt/components/strategy-comparison"
import { TotalActiveDebtCard } from "@/features/debt/components/total-active-debt-card"
import { getUserPreference } from "@/features/settings/server/service"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

/**
 * Debt — replaces the Phase 3 placeholder now that the Debt model and its
 * full Server Action/service surface exist (docs/product/debt-tracker.md,
 * docs/architecture/api-contracts.md's Debt Tracker section).
 *
 * Server Component: fetches both debt lists directly via `service.getDebts`
 * and the caller's accounts via `accounts.service.getAccounts`, per
 * api-contracts.md's "Server Component direct call" rows for every read in
 * this feature — never Server Actions for these, matching
 * accounts/page.tsx's and investments/page.tsx's identical read pattern.
 * Mutations (create/edit/archive/unarchive/link/unlink) happen in the Client
 * Component pieces rendered below (DebtCard, DebtFormDialog,
 * LinkAccountDialog) and call `router.refresh()` afterward, which simply
 * re-runs this Server Component and its fetches — see those components for
 * details.
 *
 * The snowball/avalanche comparison (`StrategyComparison`) is the one piece
 * of this page that is NOT a plain read-then-render: per api-contracts.md,
 * "no server call at all after initial load" — it receives the active,
 * non-paid-off debts as a prop and calls `../payoff-math.ts` directly,
 * client-side, recomputing live on every extra-payment keystroke (AC6/AC7).
 *
 * Eligible-accounts computation (for the Link-to-account dialog): every
 * Credit Card `Account` the user has, minus any account already linked to
 * *any* debt (active or archived — an archived debt can still hold a link,
 * and `Debt.accountId` is unique at the DB level, so an archived-but-linked
 * account must still be excluded here to avoid offering a selection that
 * would fail server-side). This is a pure read-side computation over two
 * already-fetched lists, not a new backend query — no `features/debt/server`
 * file needed this.
 */
export default async function DebtPage() {
  const user = await getCurrentUser()
  if (!user) {
    redirect("/login")
  }

  const [activeDebts, archivedDebts, accounts, userPreference] = await Promise.all([
    getDebts(user.id),
    getDebts(user.id, { includeArchived: true }),
    getAccounts(user.id),
    // (Phase 4c release-gate fix, docs/release/phase-4c-notes.md Section 1):
    // this page's own "Total active debt" figure below is formatted directly
    // in this Server Component, so it needs `currencyDisplay` resolved here
    // rather than via `useCurrencyDisplay()` (a Client-Component-only hook).
    getUserPreference(user.id),
  ])

  const hasAnyDebts = activeDebts.length > 0 || archivedDebts.length > 0

  const linkedAccountIds = new Set(
    [...activeDebts, ...archivedDebts]
      .map((debt) => debt.accountId)
      .filter((accountId): accountId is string => accountId !== null),
  )
  const eligibleAccounts: Account[] = accounts.filter(
    (account) => account.type === "CREDIT_CARD" && !linkedAccountIds.has(account.id),
  )

  // The comparison only makes sense for debts still actively accruing —
  // a Paid Off debt (effectiveBalance <= 0) has nothing left to allocate an
  // extra payment toward (Edge Cases: "only one active debt" already covers
  // the single-remaining-debt case; a fully-paid-off one is simply excluded
  // here rather than distorting either strategy's totals).
  const comparisonDebts = activeDebts.filter((debt) => !debt.isPaidOff)
  const totalActiveBalance = activeDebts.reduce(
    (sum, debt) => sum + debt.effectiveBalance,
    0,
  )

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-foreground">
            Debt
          </h1>
          <p className="text-sm text-muted-foreground">
            Every credit card, loan, and mortgage you owe — with a real
            payoff plan, not just a balance.
          </p>
        </div>
        {hasAnyDebts && <AddDebtButton />}
      </div>

      {!hasAnyDebts ? (
        <EmptyDebtState />
      ) : (
        <>
          {activeDebts.length > 0 && (
            <TotalActiveDebtCard
              totalActiveBalance={totalActiveBalance}
              currencyDisplay={userPreference.currencyDisplay}
            />
          )}

          {comparisonDebts.length > 0 && (
            <StrategyComparison debts={comparisonDebts} />
          )}

          {/* One-time windfall allocation — a different question from
              StrategyComparison's recurring-extra-payment model; see
              `features/debt/lump-sum.ts` for why the two are separate. Same
              client-side-only contract: takes the active debts as a prop and
              recomputes locally. */}
          {comparisonDebts.length > 0 && (
            <LumpSumAdvisor debts={comparisonDebts} />
          )}

          <Tabs defaultValue="active">
            <TabsList>
              <TabsTrigger value="active">
                Active ({activeDebts.length})
              </TabsTrigger>
              <TabsTrigger value="archived">
                Archived ({archivedDebts.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="active" className="mt-4">
              {activeDebts.length > 0 ? (
                <DebtList debts={activeDebts} eligibleAccounts={eligibleAccounts} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  No active debts. Unarchive one from the Archived tab, or add
                  a new debt.
                </p>
              )}
            </TabsContent>

            <TabsContent value="archived" className="mt-4">
              {archivedDebts.length > 0 ? (
                <DebtList debts={archivedDebts} eligibleAccounts={eligibleAccounts} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  No archived debts.
                </p>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  )
}

/** Zero-debts state — docs/product/debt-tracker.md's "Zero debts" edge case
 * ("a clear, positive empty state ... not a blank or broken screen"). */
function EmptyDebtState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <CreditCard className="size-8 text-muted-foreground" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="font-heading text-base font-medium text-foreground">
            No debt tracked — nice!
          </p>
          <p className="max-w-sm text-sm text-muted-foreground">
            If you do have a credit card, loan, or mortgage, add it here to
            see a real payoff date and total interest — and compare snowball
            vs. avalanche strategies once you&apos;re tracking more than one.
          </p>
        </div>
        <AddDebtButton label="Add your first debt" />
      </CardContent>
    </Card>
  )
}
