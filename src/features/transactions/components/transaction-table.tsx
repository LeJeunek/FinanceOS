"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import type { ColumnDef } from "@tanstack/react-table"
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Scissors,
  Sparkles,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { ResponsiveDataTable } from "@/components/shared/data-table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn, formatDate } from "@/lib/utils"
import { useFormatCurrency } from "@/app/(dashboard)/currency-preference-provider"
import { useAccounts } from "@/features/accounts/hooks/use-accounts"
import type { Category } from "@/features/categories/types"
import { UNCATEGORIZED_CATEGORY_ID, type Transaction } from "@/features/transactions/types"
import type { TransactionSortField } from "@/features/transactions/server/validation"
import {
  useDeleteTransaction,
  useTransactions,
} from "@/features/transactions/hooks/use-transactions"
import { SuggestionBadge } from "@/features/transactions/components/suggestion-badge"
import { requestCategorySuggestion } from "@/features/transactions/server/actions"
import type { PendingCategorySuggestion } from "@/features/transactions/server/categorization"

/**
 * Transaction table: the assembled `DataTable` (columns, server-driven
 * sorting/pagination/filtering, row actions) for the Transactions page. Per
 * docs/product/transactions.md's acceptance criteria: sortable by date/
 * amount/merchant/category, filterable by account/category/date range,
 * free-text searchable, and paginated — all server-side, since
 * `useTransactions` hits a real paginated API rather than a client-side
 * array (see `hooks/use-transactions.ts`).
 *
 * `DataTable` (components/shared/data-table/data-table.tsx) has no
 * `manualSorting`/`onSortingChange` prop — only `manualPagination` is
 * exposed for server-driven paging. Rather than fighting its internal
 * (client-only) `getSortedRowModel`, sortable columns render their own
 * header buttons driven entirely by this component's own `sortBy`/`sortDir`
 * state (see `SortButton` below) and never touch TanStack Table's built-in
 * sorting state, so `DataTable` never re-sorts the already-server-sorted
 * page out from under us.
 */

const DEFAULT_PAGE_SIZE = 25
const SEARCH_DEBOUNCE_MS = 300
// Radix `Select` cannot use an empty string as an item value (it's reserved
// to mean "no selection"), so the "All accounts"/"All categories" options
// need their own non-empty sentinel, mapped back to `undefined` (meaning
// "no filter") before building the query.
const ALL_ACCOUNTS_VALUE = "__all-accounts__"
const ALL_CATEGORIES_VALUE = "__all-categories__"

export interface TransactionTableProps {
  /** Full category list (system + custom), owned by the Transactions page's
   * Server Component fetch — see app/(dashboard)/transactions/page.tsx's
   * JSDoc for why Categories has no client hook of its own. Used here only
   * for the category filter dropdown; each row's own category badge comes
   * from the joined `transaction.category` summary already returned by
   * `useTransactions`. */
  categories: Category[]
  /** Every currently-PENDING `CategorySuggestion` for this user (Phase 4a,
   * Server-Component-sourced — see page.tsx's JSDoc). Matched to a row by
   * `transactionId` below and rendered inline via `SuggestionBadge`. */
  pendingSuggestions: PendingCategorySuggestion[]
  /** `true` when the caller (transactions-client.tsx's "Review N
   * suggestions" button) wants this table instance to start filtered to
   * Uncategorized — only read on mount (the caller forces a remount via
   * `key` on every click, so this never needs to react to prop changes
   * itself). */
  jumpToUncategorized?: boolean
  /** Seeds the merchant/notes search filter on mount — how
   * `dashboard-shell.tsx`'s global TopNav search box (previously entirely
   * unwired) reaches this table's own search implementation via
   * `?search=` on `/transactions`. Only read on mount, the same convention
   * `jumpToUncategorized` already establishes. */
  initialSearch?: string
  onEdit: (transaction: Transaction) => void
  onSplit: (transaction: Transaction) => void
}

function SortButton({
  label,
  field,
  activeField,
  direction,
  onToggle,
  align = "start",
}: {
  label: string
  field: TransactionSortField
  activeField: TransactionSortField
  direction: "asc" | "desc"
  onToggle: (field: TransactionSortField) => void
  align?: "start" | "end"
}) {
  const isActive = activeField === field
  return (
    <div className={cn("flex items-center", align === "end" && "justify-end")}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2.5 h-7 gap-1.5 px-2.5"
        aria-label={`Sort by ${label}${isActive ? `, currently ${direction === "asc" ? "ascending" : "descending"}` : ""}`}
        onClick={() => onToggle(field)}
      >
        <span>{label}</span>
        {isActive ? (
          direction === "asc" ? (
            <ArrowUp className="size-3.5" aria-hidden="true" />
          ) : (
            <ArrowDown className="size-3.5" aria-hidden="true" />
          )
        ) : (
          <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
        )}
      </Button>
    </div>
  )
}

export function TransactionTable({
  categories,
  pendingSuggestions,
  jumpToUncategorized = false,
  initialSearch,
  onEdit,
  onSplit,
}: TransactionTableProps) {
  const formatCurrency = useFormatCurrency()
  const router = useRouter()
  const { data: accounts } = useAccounts()

  const [pageIndex, setPageIndex] = React.useState(0)
  const [pageSize, setPageSize] = React.useState(DEFAULT_PAGE_SIZE)
  const [accountId, setAccountId] = React.useState<string | undefined>(undefined)
  const [categoryId, setCategoryId] = React.useState<string | undefined>(
    jumpToUncategorized ? UNCATEGORIZED_CATEGORY_ID : undefined,
  )
  const [searchInput, setSearchInput] = React.useState(initialSearch ?? "")
  const [search, setSearch] = React.useState(initialSearch ?? "")
  const [dateFrom, setDateFrom] = React.useState("")
  const [dateTo, setDateTo] = React.useState("")
  // Kept as a single state object (rather than separate sortBy/sortDir
  // `useState`s) so `handleSortToggle` can read the *previous* field inside
  // one functional updater without a stale-closure bug — reading two
  // separate `useState` setters' previous values together isn't possible.
  //
  // Defaults to oldest-first when jumping in from "Review N suggestions":
  // `generateAutomaticSuggestionsForUser`'s eligibility query processes a
  // user's OLDEST Uncategorized transactions first (categorization.ts's own
  // `orderBy: { createdAt: "asc" }`), so with any backlog larger than one
  // batch, the newest-first default sort would bury every just-generated
  // suggestion on a later page — the table would look completely unfiltered
  // (every visible row still plain "Uncategorized", no inline badge) even
  // though the suggestions really were created, reading as "doesn't work"
  // rather than "scroll/page further." Oldest-first is what actually surfaces
  // them on page 1, matching the exact order they were generated in.
  const [sort, setSort] = React.useState<{
    field: TransactionSortField
    dir: "asc" | "desc"
  }>({ field: "date", dir: jumpToUncategorized ? "asc" : "desc" })
  const sortBy = sort.field
  const sortDir = sort.dir
  const [deletingTransaction, setDeletingTransaction] = React.useState<Transaction | null>(null)

  // Debounce free-text search so every keystroke doesn't trigger a fetch.
  React.useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  // Any filter/sort change invalidates the current page of results — jump
  // back to page 1 so the user isn't stranded on a page number that may no
  // longer exist under the new filter.
  React.useEffect(() => {
    setPageIndex(0)
  }, [accountId, categoryId, search, dateFrom, dateTo, sortBy, sortDir])

  const filters = React.useMemo(
    () => ({
      page: pageIndex + 1,
      pageSize,
      accountId,
      categoryId,
      search: search || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      sortBy,
      sortDir,
    }),
    [pageIndex, pageSize, accountId, categoryId, search, dateFrom, dateTo, sortBy, sortDir],
  )

  const { data, isLoading } = useTransactions(filters)
  const deleteTransaction = useDeleteTransaction()

  // Phase 4a: PENDING suggestions keyed by transactionId so each row can
  // look its own up in O(1) — `pendingSuggestions` is every one of this
  // user's PENDING rows (unfiltered, see page.tsx's JSDoc), not scoped to
  // the current page/filter, so this map is rebuilt only when the prop
  // itself changes, not on every page/filter change.
  const suggestionsByTransactionId = React.useMemo(() => {
    const map = new Map<string, PendingCategorySuggestion>()
    for (const suggestion of pendingSuggestions) {
      map.set(suggestion.transactionId, suggestion)
    }
    return map
  }, [pendingSuggestions])

  // Tracks which transaction(s) currently have an in-flight manual
  // "reconsider" request — disables that row's menu item so a slow request
  // can't be fired twice, distinct from `SuggestionBadge`'s own
  // accept/reject pending state (a different action, on an
  // already-generated suggestion).
  const [requestingSuggestionIds, setRequestingSuggestionIds] = React.useState<Set<string>>(
    () => new Set(),
  )

  /**
   * The manual "reconsider" action (ai-features.md AC6): requests a fresh
   * suggestion for any transaction, categorized or not. Never throws — every
   * outcome (ordinary request failure, e.g. rate-limited; or the AI
   * provider being `"unavailable"`) is surfaced as a toast so the rest of
   * the table keeps working regardless, per this feature's own fallback
   * contract.
   */
  const handleRequestSuggestion = React.useCallback(
    async (transaction: Transaction) => {
      setRequestingSuggestionIds((prev) => new Set(prev).add(transaction.id))
      try {
        const result = await requestCategorySuggestion({ transactionId: transaction.id })

        if (!result.success) {
          toast.error(result.error)
          return
        }
        if (result.data.status === "unavailable") {
          toast.error("Couldn't generate a suggestion right now — try again later.")
          return
        }

        toast.success(`Suggested category: ${result.data.data.categoryName}`)
        // Re-runs the Transactions page's Server Component read of
        // `getPendingSuggestions`, which is how the new suggestion reaches
        // this table's `pendingSuggestions` prop.
        router.refresh()
      } finally {
        setRequestingSuggestionIds((prev) => {
          const next = new Set(prev)
          next.delete(transaction.id)
          return next
        })
      }
    },
    [router],
  )

  const handleSortToggle = React.useCallback((field: TransactionSortField) => {
    setSort((prev) =>
      prev.field === field
        ? { field, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { field, dir: "asc" },
    )
  }, [])

  async function handleConfirmDelete() {
    if (!deletingTransaction) return
    try {
      await deleteTransaction.mutateAsync({ id: deletingTransaction.id })
      toast.success(`Deleted transaction "${deletingTransaction.merchant}".`)
      setDeletingTransaction(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete transaction.")
    }
  }

  const columns = React.useMemo<ColumnDef<Transaction>[]>(
    () => [
      {
        id: "date",
        accessorKey: "date",
        header: () => (
          <SortButton
            label="Date"
            field="date"
            activeField={sortBy}
            direction={sortDir}
            onToggle={handleSortToggle}
          />
        ),
        cell: ({ row }) => (
          <span className="whitespace-nowrap">{formatDate(row.original.date)}</span>
        ),
      },
      {
        id: "merchant",
        accessorKey: "merchant",
        header: () => (
          <SortButton
            label="Merchant"
            field="merchant"
            activeField={sortBy}
            direction={sortDir}
            onToggle={handleSortToggle}
          />
        ),
        cell: ({ row }) => <span className="font-medium">{row.original.merchant}</span>,
        // Phase 5a (phase-5a-technical-design.md §3.1): merchant + amount
        // are this table's card-list "primary" columns — the two figures a
        // user scanning their transactions on mobile needs at a glance.
        meta: { cardDisplay: "primary" },
      },
      {
        id: "category",
        header: () => (
          <SortButton
            label="Category"
            field="category"
            activeField={sortBy}
            direction={sortDir}
            onToggle={handleSortToggle}
          />
        ),
        cell: ({ row }) => {
          const category = row.original.category
          // Phase 4a: a PENDING suggestion can exist regardless of whether
          // this row already has a category — the automatic path only ever
          // targets Uncategorized rows, but the manual "reconsider" action
          // (ai-features.md AC6) is allowed on any transaction.
          const suggestion = suggestionsByTransactionId.get(row.original.id)
          return (
            <div className="flex flex-col items-start gap-1">
              <Badge variant="outline" className="gap-1.5">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: category?.color ?? "#94a3b8" }}
                  aria-hidden="true"
                />
                {category?.name ?? "Uncategorized"}
              </Badge>
              {suggestion && <SuggestionBadge suggestion={suggestion} />}
            </div>
          )
        },
      },
      {
        id: "amount",
        accessorKey: "amount",
        header: () => (
          <SortButton
            label="Amount"
            field="amount"
            activeField={sortBy}
            direction={sortDir}
            onToggle={handleSortToggle}
            align="end"
          />
        ),
        cell: ({ row }) => {
          const amount = row.original.amount
          return (
            <div
              className={cn(
                "text-right font-medium tabular-nums",
                // Accessibility fix (docs/testing/e2e/accessibility-run-report.md's
                // 2026-08-02 re-run, finding #1, axe `color-contrast`) —
                // see transaction-detail-client.tsx's identical fix/comment.
                amount < 0 ? "text-red-700 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400",
              )}
            >
              {amount < 0 ? "-" : "+"}
              {formatCurrency(Math.abs(amount))}
            </div>
          )
        },
        meta: { cardDisplay: "primary" },
      },
      {
        id: "account",
        header: "Account",
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: row.original.account.color }}
              aria-hidden="true"
            />
            {row.original.account.name}
          </span>
        ),
      },
      {
        id: "tags",
        header: "Tags",
        cell: ({ row }) => {
          const tags = row.original.tags
          if (tags.length === 0) {
            return <span className="text-muted-foreground">—</span>
          }
          return (
            <div className="flex flex-wrap gap-1">
              {tags.map((tag) => (
                <Badge key={tag.id} variant="secondary">
                  {tag.name}
                </Badge>
              ))}
            </div>
          )
        },
        // Phase 5b (Expandable Cards, phase-5b-technical-design.md §3.2):
        // tags and notes are real detail, but not what a user scanning their
        // mobile transaction list needs at a glance — merchant/amount
        // (already "primary") and category/account/date cover that; tags and
        // notes move behind this card's own expand affordance instead of
        // adding to an already-dense default card body. Unaffected in the
        // desktop `<table>` view — `meta.cardDisplay` is read only by
        // `DataTableCardList`.
        meta: { cardDisplay: "expandable" },
      },
      {
        id: "notes",
        header: "Notes",
        cell: ({ row }) => (
          <span className="line-clamp-1 max-w-48 text-muted-foreground">
            {row.original.notes || "—"}
          </span>
        ),
        meta: { cardDisplay: "expandable" },
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const transaction = row.original
          // Split children (parentTransactionId set) can't themselves be
          // split again (AC15) — split parents never reach this table at
          // all (`listTransactions`'s `EXCLUDE_SPLIT_PARENTS`), so this is
          // the only "already split" state a visible row can be in.
          const isSplitChild = transaction.parentTransactionId !== null
          // Phase 4a AC6: "reconsider" is only offered when this row has no
          // suggestion already awaiting review — once one exists, the
          // inline `SuggestionBadge` next to its category is the action
          // surface, so a second, redundant "Suggest a category" entry here
          // would just duplicate it.
          const hasPendingSuggestion = suggestionsByTransactionId.has(transaction.id)
          const isRequestingSuggestion = requestingSuggestionIds.has(transaction.id)
          return (
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    // Accessibility fix (Bug Hunter, Phase 5a review gate,
                    // data-table-row-action-buttons-below-44px-touch-target.md):
                    // `icon-sm` alone is 28x28px, below Responsive AC5's
                    // binding 44x44px minimum. This cell renders unchanged
                    // in both DataTable's table view and DataTableCardList's
                    // mobile card view (by design -- see
                    // phase-5a-technical-design.md §3.1), so the override
                    // must apply everywhere the cell renders, not just one
                    // breakpoint -- a `size-11` override widens the desktop
                    // table's action column slightly too, an accepted
                    // tradeoff over a more fragile invisible-hit-area trick.
                    className="size-11"
                    aria-label={`Actions for ${transaction.merchant}`}
                  >
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onEdit(transaction)}>
                    <Pencil className="size-4" aria-hidden="true" />
                    Edit
                  </DropdownMenuItem>
                  {/* Phase 2 addendum: receipts live on a dedicated detail
                     route, not this dialog — see
                     app/(dashboard)/transactions/[id]/page.tsx's JSDoc for
                     why (getTransactionDetail is Server-Component-callable
                     only, so a route is required to reach it). Works
                     identically for split line items (AC4) since
                     `transaction.id` is already that row's own id. */}
                  <DropdownMenuItem asChild>
                    <Link href={`/transactions/${transaction.id}`}>
                      <Paperclip className="size-4" aria-hidden="true" />
                      Receipts
                    </Link>
                  </DropdownMenuItem>
                  {!isSplitChild && (
                    <DropdownMenuItem onSelect={() => onSplit(transaction)}>
                      <Scissors className="size-4" aria-hidden="true" />
                      Split
                    </DropdownMenuItem>
                  )}
                  {!hasPendingSuggestion && (
                    <DropdownMenuItem
                      disabled={isRequestingSuggestion}
                      onSelect={(event) => {
                        // Radix closes the menu on select by default, which
                        // is fine here (the request runs in the background
                        // and reports via toast), but `preventDefault` keeps
                        // the menu open only long enough to reflect the
                        // disabled state if this fires again before the
                        // first request resolves.
                        event.preventDefault()
                        void handleRequestSuggestion(transaction)
                      }}
                    >
                      <Sparkles className="size-4" aria-hidden="true" />
                      {isRequestingSuggestion ? "Requesting..." : "Suggest a category"}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setDeletingTransaction(transaction)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        },
      },
    ],
    [
      sortBy,
      sortDir,
      handleSortToggle,
      onEdit,
      onSplit,
      suggestionsByTransactionId,
      requestingSuggestionIds,
      handleRequestSuggestion,
      formatCurrency,
    ],
  )

  const total = data?.total ?? 0
  const pageCount = total === 0 ? 0 : Math.ceil(total / pageSize)

  return (
    <>
      <ResponsiveDataTable
        columns={columns}
        data={data?.items ?? []}
        isLoading={isLoading}
        emptyMessage="No transactions found."
        manualPagination
        pageCount={pageCount}
        pageIndex={pageIndex}
        pageSize={pageSize}
        onPaginationChange={(newPageIndex, newPageSize) => {
          setPageIndex(newPageIndex)
          setPageSize(newPageSize)
        }}
        toolbar={() => (
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search merchant or notes..."
              aria-label="Search transactions"
              className="w-full max-w-56"
            />
            <Select
              value={accountId ?? ALL_ACCOUNTS_VALUE}
              onValueChange={(value) =>
                setAccountId(value === ALL_ACCOUNTS_VALUE ? undefined : value)
              }
            >
              <SelectTrigger aria-label="Filter by account">
                <SelectValue placeholder="All accounts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_ACCOUNTS_VALUE}>All accounts</SelectItem>
                {(accounts ?? []).map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={categoryId ?? ALL_CATEGORIES_VALUE}
              onValueChange={(value) =>
                setCategoryId(value === ALL_CATEGORIES_VALUE ? undefined : value)
              }
            >
              <SelectTrigger aria-label="Filter by category">
                <SelectValue placeholder="All categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_CATEGORIES_VALUE}>All categories</SelectItem>
                <SelectItem value={UNCATEGORIZED_CATEGORY_ID}>Uncategorized</SelectItem>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              aria-label="From date"
              className="w-36"
            />
            <Input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
              aria-label="To date"
              className="w-36"
            />
          </div>
        )}
      />

      <Dialog
        open={deletingTransaction !== null}
        onOpenChange={(open) => !open && setDeletingTransaction(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete transaction?</DialogTitle>
            <DialogDescription>
              {deletingTransaction &&
                `This will permanently delete "${deletingTransaction.merchant}" for ${formatCurrency(
                  Math.abs(deletingTransaction.amount),
                )} on ${formatDate(deletingTransaction.date)}. This cannot be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingTransaction(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={deleteTransaction.isPending}
            >
              {deleteTransaction.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
