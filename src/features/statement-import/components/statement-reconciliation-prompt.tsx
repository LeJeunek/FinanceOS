"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, Scale } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { useFormatCurrency } from "@/app/(dashboard)/currency-preference-provider"
import { updateAccount } from "@/features/accounts/server/actions"
import type { ReconciliationSuggestion } from "@/features/statement-import/reconciliation"

/**
 * Post-import balance reconciliation: offers to set the account's stored
 * balance to the closing balance printed on the statement that was just
 * imported.
 *
 * Relationship to `features/accounts/components/reconciliation-prompt.tsx`:
 * that prompt reconciles against *transaction history* (recomputing what the
 * balance should be from the rows on file). This one reconciles against *the
 * bank's own printed figure*, which is the stronger source of truth and is
 * only available in the moment a statement has just been converted. They
 * answer different questions and neither replaces the other.
 *
 * Like that prompt, this applies the change through the existing
 * `updateAccount` Server Action rather than introducing a second write path
 * for `Account.balance` — see `docs/product/accounts-balance-auto-adjustment.md`
 * Criterion 8, whose "presented to the user for confirmation rather than
 * silently overwritten" rule applies just as much here.
 */

export interface StatementReconciliationPromptProps {
  suggestion: ReconciliationSuggestion
  /** Net effect of the rows just imported, shown so the arithmetic is
   * visible rather than asserted. */
  importedNet: number
  /** Number of rows actually inserted, per the importer's own summary. */
  importedCount: number
  skippedDuplicates: number
}

export function StatementReconciliationPrompt({
  suggestion,
  importedNet,
  importedCount,
  skippedDuplicates,
}: StatementReconciliationPromptProps) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const formatCurrency = useFormatCurrency()
  const [isApplying, setIsApplying] = React.useState(false)
  const [applied, setApplied] = React.useState(false)
  const [dismissed, setDismissed] = React.useState(false)

  if (dismissed) return null

  if (suggestion.isReconciled || applied) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5 text-sm dark:border-emerald-400/40">
        <CheckCircle2 className="size-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
        <p>
          <span className="font-medium">{suggestion.accountName}</span> matches the statement&apos;s
          closing balance of {formatCurrency(suggestion.statementBalance)}.
        </p>
      </div>
    )
  }

  async function handleApply() {
    setIsApplying(true)
    try {
      const result = await updateAccount({
        id: suggestion.accountId,
        balance: suggestion.statementBalance,
      })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success("Balance updated from the statement.")
      setApplied(true)
      queryClient.invalidateQueries({ queryKey: ["accounts"] })
      queryClient.invalidateQueries({ queryKey: ["transactions"] })
      router.refresh()
    } finally {
      setIsApplying(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed border-amber-500/50 bg-amber-500/10 px-3 py-2.5 text-sm dark:border-amber-400/40 dark:bg-amber-400/10">
      <div className="flex items-start gap-2">
        <Scale className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="grid gap-1">
          <p className="text-foreground">
            This statement closes at{" "}
            <span className="font-medium">{formatCurrency(suggestion.statementBalance)}</span>
            {suggestion.asOfDate ? ` as of ${suggestion.asOfDate}` : ""}, but{" "}
            <span className="font-medium">{suggestion.accountName}</span> now shows{" "}
            <span className="font-medium">{formatCurrency(suggestion.currentBalance)}</span> — a
            difference of {formatCurrency(Math.abs(suggestion.difference))}. Update it to match?
          </p>

          <p className="text-xs text-muted-foreground">
            Just imported: {importedCount} transaction{importedCount === 1 ? "" : "s"} totalling{" "}
            {formatCurrency(importedNet)}
            {skippedDuplicates > 0
              ? `, with ${skippedDuplicates} skipped as already on file`
              : ""}
            . {suggestion.provenance}.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 pl-6">
        <Button type="button" size="sm" onClick={handleApply} disabled={isApplying}>
          {isApplying ? "Updating..." : "Update balance"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setDismissed(true)}
          disabled={isApplying}
        >
          Not now
        </Button>
      </div>
    </div>
  )
}
