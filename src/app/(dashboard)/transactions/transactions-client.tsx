"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { FileText, Plus, Settings2, Sparkles, Upload } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { useAccounts } from "@/features/accounts/hooks/use-accounts"
import type { Category } from "@/features/categories/types"
import { CategoryManagerDialog } from "@/features/transactions/components/category-manager-dialog"
import { StatementConverterDialog } from "@/features/statement-import/components/statement-converter-dialog"
import { ImportDialog } from "@/features/transactions/components/import-dialog"
import { SplitDialog } from "@/features/transactions/components/split-dialog"
import { TransactionForm } from "@/features/transactions/components/transaction-form"
import { TransactionTable } from "@/features/transactions/components/transaction-table"
import type { PendingCategorySuggestion } from "@/features/transactions/server/categorization"
import { requestBulkCategorySuggestions } from "@/features/transactions/server/actions"
import type { Transaction } from "@/features/transactions/types"

/**
 * Client-side composition root for the Transactions page: header actions
 * (Add/Import/Manage Categories), the table, and every dialog it can open.
 * Owns the "which dialog is open, for which transaction" state so
 * `TransactionTable` itself can stay focused on the table/filters (it only
 * ever emits `onEdit`/`onSplit` callbacks upward, and manages its own
 * inline delete-confirmation directly since that doesn't need a separate
 * dialog component or lifted state).
 *
 * `categories`/`categoryUsageCounts` are fetched server-side in `page.tsx`
 * (see that file's JSDoc for why) and threaded down as props; accounts are
 * fetched here via `useAccounts()`, the existing Accounts feature's client
 * hook (default: non-archived only), and passed to every dialog that needs
 * an account picker.
 *
 * **Phase 4a addition:** `pendingSuggestions` (also Server-Component-sourced,
 * same reasoning as `categories`) is threaded straight through to
 * `TransactionTable`, which renders each one inline on its own row (see that
 * file's JSDoc). The one piece of cross-component wiring owned here is the
 * "Review suggestions" header button (ai-features.md AC7's "review across a
 * batch without navigating to each transaction individually"): rather than
 * building a second, separate review surface with its own incomplete data
 * (`getPendingSuggestions` doesn't join in merchant/amount — see that
 * function's own JSDoc on why), clicking it jumps the existing, already
 * filterable/paginated table straight to the "Uncategorized" category
 * filter, where every pending suggestion is already visible inline. `key`
 * is bumped on each click to force `TransactionTable` to remount with that
 * filter applied even if the user had since changed it away.
 */

export interface TransactionsClientProps {
  categories: Category[]
  categoryUsageCounts: Record<string, number>
  pendingSuggestions: PendingCategorySuggestion[]
}

type FormState = { mode: "create" } | { mode: "edit"; transaction: Transaction } | null

export function TransactionsClient({
  categories,
  categoryUsageCounts,
  pendingSuggestions,
}: TransactionsClientProps) {
  const router = useRouter()
  const { data: accounts = [] } = useAccounts()

  const [formState, setFormState] = React.useState<FormState>(null)
  const [splittingTransaction, setSplittingTransaction] = React.useState<Transaction | null>(null)
  const [isImportOpen, setIsImportOpen] = React.useState(false)
  const [isConverterOpen, setIsConverterOpen] = React.useState(false)
  const [isCategoryManagerOpen, setIsCategoryManagerOpen] = React.useState(false)
  const [uncategorizedJumpCount, setUncategorizedJumpCount] = React.useState(0)
  const [isBulkSuggesting, setIsBulkSuggesting] = React.useState(false)

  /**
   * Bulk "suggest categories for all Uncategorized transactions" — calls
   * `requestBulkCategorySuggestions`, which delegates to the same batch
   * generation logic the categorization cron already runs on a schedule (see
   * that Server Action's own doc comment). Never throws — every outcome
   * (rate-limited, zero eligible transactions, or N suggestions generated)
   * is surfaced as a toast, matching `TransactionTable`'s own
   * `handleRequestSuggestion` fallback contract for the single-transaction
   * "reconsider" action.
   */
  const handleBulkSuggest = React.useCallback(async () => {
    setIsBulkSuggesting(true)
    try {
      const result = await requestBulkCategorySuggestions()
      if (!result.success) {
        toast.error(result.error)
        return
      }

      if (result.data.suggested > 0) {
        toast.success(
          `Suggested categories for ${result.data.suggested} of ${result.data.processed} uncategorized transactions.`,
        )
      } else if (result.data.processed > 0) {
        toast.success(
          `Checked ${result.data.processed} uncategorized transaction${result.data.processed === 1 ? "" : "s"} — no confident category match found.`,
        )
      } else if (pendingSuggestions.length === 0) {
        toast.success("No uncategorized transactions need a suggestion right now.")
      }
      // Otherwise: nothing new to generate (every currently-Uncategorized
      // transaction already has a PENDING suggestion — e.g. from the cron
      // job running on its own schedule), but suggestions DO already exist.
      // A toast alone is easy to miss and reads as "the button did nothing"
      // — jumping straight to the review view below is what actually
      // surfaces them, matching what "Suggest categories" implicitly
      // promises regardless of whether this exact click is what generated
      // them.

      // Re-runs page.tsx's `getPendingSuggestions` read, which is how any
      // newly-generated suggestions reach `TransactionTable`'s
      // `pendingSuggestions` prop.
      router.refresh()

      if (result.data.suggested > 0 || pendingSuggestions.length > 0) {
        setUncategorizedJumpCount((count) => count + 1)
      }
    } finally {
      setIsBulkSuggesting(false)
    }
  }, [router, pendingSuggestions.length])

  // Categories/usage counts are Server-Component-sourced (no client hook
  // exists for this feature) — `router.refresh()` re-runs page.tsx's fetch,
  // which is how CategoryManagerDialog's mutations (and its on-open
  // refresh) propagate back down as fresh props.
  const refreshCategories = React.useCallback(() => {
    router.refresh()
  }, [router])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold text-foreground">Transactions</h1>
          <p className="text-sm text-muted-foreground">
            Track, categorize, and search every transaction across your accounts.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pendingSuggestions.length > 0 && (
            <Button
              variant="outline"
              onClick={() => setUncategorizedJumpCount((count) => count + 1)}
            >
              <Sparkles className="size-4" aria-hidden="true" />
              Review {pendingSuggestions.length} suggestion
              {pendingSuggestions.length === 1 ? "" : "s"}
            </Button>
          )}
          <Button variant="outline" onClick={handleBulkSuggest} disabled={isBulkSuggesting}>
            <Sparkles className="size-4" aria-hidden="true" />
            {isBulkSuggesting ? "Suggesting..." : "Suggest categories"}
          </Button>
          <Button variant="outline" onClick={() => setIsCategoryManagerOpen(true)}>
            <Settings2 className="size-4" aria-hidden="true" />
            Manage categories
          </Button>
          <Button variant="outline" onClick={() => setIsConverterOpen(true)}>
            <FileText className="size-4" aria-hidden="true" />
            PDF to CSV
          </Button>
          <Button variant="outline" onClick={() => setIsImportOpen(true)}>
            <Upload className="size-4" aria-hidden="true" />
            Import CSV
          </Button>
          <Button onClick={() => setFormState({ mode: "create" })}>
            <Plus className="size-4" aria-hidden="true" />
            Add transaction
          </Button>
        </div>
      </div>

      <TransactionTable
        key={uncategorizedJumpCount}
        categories={categories}
        pendingSuggestions={pendingSuggestions}
        jumpToUncategorized={uncategorizedJumpCount > 0}
        onEdit={(transaction) => setFormState({ mode: "edit", transaction })}
        onSplit={(transaction) => setSplittingTransaction(transaction)}
      />

      <TransactionForm
        open={formState !== null}
        onOpenChange={(open) => !open && setFormState(null)}
        transaction={formState?.mode === "edit" ? formState.transaction : null}
        accounts={accounts}
        categories={categories}
      />

      <SplitDialog
        open={splittingTransaction !== null}
        onOpenChange={(open) => !open && setSplittingTransaction(null)}
        transaction={splittingTransaction}
        categories={categories}
      />

      <ImportDialog open={isImportOpen} onOpenChange={setIsImportOpen} accounts={accounts} />

      <StatementConverterDialog
        open={isConverterOpen}
        onOpenChange={setIsConverterOpen}
        accounts={accounts}
        categoryNames={categories.map((category) => category.name)}
      />

      <CategoryManagerDialog
        open={isCategoryManagerOpen}
        onOpenChange={setIsCategoryManagerOpen}
        categories={categories}
        categoryUsageCounts={categoryUsageCounts}
        onCategoriesChanged={refreshCategories}
      />
    </div>
  )
}
