"use client"

/**
 * OccurrenceHistoryTable — a bill's full occurrence/payment history
 * (bills.md AC10), composing the generic `DataTable`
 * (`components/shared/data-table`) per folder-tree.md's note that this
 * component "composes components/shared/data-table" — the one bills
 * component with enough columns/volume (a long-lived bill can accumulate
 * many occurrences) to justify DataTable's built-in sorting/pagination,
 * unlike `bill-list.tsx`'s plain table.
 *
 * Renders the paid-on-time-vs-paid-late distinction (AC10) via a dedicated
 * column driven by `BillOccurrence.wasPaidLate`, kept visually separate from
 * the Upcoming/Due Today/Late/Paid status column — those are two different,
 * orthogonal facts (see `types.ts`'s JSDoc on `OccurrenceStatus`).
 */

import { useState } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"

import type { BillOccurrence } from "@/features/bills/types"
import { deleteOccurrence, unmarkOccurrencePaid } from "@/features/bills/server/actions"
import { OccurrenceStatusBadge } from "@/features/bills/components/occurrence-status-badge"
import { MarkPaidDialog, type MarkPaidOccurrenceSummary } from "@/features/bills/components/mark-paid-dialog"
import { formatDate } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ResponsiveDataTable, DataTableColumnHeader } from "@/components/shared/data-table"
import { useFormatCurrency } from "@/app/(dashboard)/currency-preference-provider"

export interface OccurrenceHistoryTableProps {
  billId: string
  billName: string
  expectedAmount: number
  occurrences: BillOccurrence[]
}

export function OccurrenceHistoryTable({
  billName,
  expectedAmount,
  occurrences,
}: OccurrenceHistoryTableProps) {
  const formatCurrency = useFormatCurrency()
  const router = useRouter()
  const [markPaidTarget, setMarkPaidTarget] = useState<MarkPaidOccurrenceSummary | null>(null)
  const [unmarkingId, setUnmarkingId] = useState<string | null>(null)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  async function handleUnmark(occurrenceId: string) {
    setUnmarkingId(occurrenceId)
    const result = await unmarkOccurrencePaid({ occurrenceId })
    setUnmarkingId(null)

    if (!result.success) {
      toast.error(result.error)
      return
    }

    toast.success("Occurrence un-marked as paid.")
    router.refresh()
  }

  async function handleDelete(occurrenceId: string) {
    setDeletingId(occurrenceId)
    const result = await deleteOccurrence({ occurrenceId })
    setDeletingId(null)
    setConfirmingDeleteId(null)

    if (!result.success) {
      toast.error(result.error)
      return
    }

    toast.success("Occurrence deleted.")
    router.refresh()
  }

  const columns: ColumnDef<BillOccurrence>[] = [
    {
      accessorKey: "dueDate",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Due date" />,
      cell: ({ row }) => formatDate(row.original.dueDate),
      sortingFn: "datetime",
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <OccurrenceStatusBadge status={row.original.status} />,
      // Phase 5a (phase-5a-technical-design.md §3.1): status + paid amount
      // are this table's card-list "primary" columns — the dispatch's own
      // named choice for both occurrence-history tables.
      meta: { cardDisplay: "primary" },
    },
    {
      id: "paidAmount",
      header: "Paid amount",
      cell: ({ row }) =>
        row.original.paidAmount !== null ? formatCurrency(row.original.paidAmount) : "—",
      meta: { cardDisplay: "primary" },
    },
    {
      id: "paidDate",
      header: "Paid date",
      cell: ({ row }) => (row.original.paidDate ? formatDate(row.original.paidDate) : "—"),
    },
    {
      id: "paidVia",
      header: "Paid via",
      cell: ({ row }) =>
        row.original.transactionId ? "Linked transaction" : row.original.paidAmount !== null ? "Manual entry" : "—",
      // Phase 5b (Expandable Cards, phase-5b-technical-design.md §3.2): status
      // + paid amount (already "primary") are what a user scanning this
      // bill's payment history on mobile needs at a glance — how it was paid
      // and whether it was on time are real, but secondary follow-up detail,
      // so both move behind this card's own expand affordance.
      meta: { cardDisplay: "expandable" },
    },
    {
      id: "onTime",
      header: "On time?",
      cell: ({ row }) => {
        const { wasPaidLate } = row.original
        if (wasPaidLate === null) return "—"
        return wasPaidLate ? (
          <Badge
            variant="outline"
            className="border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-400"
          >
            Paid late
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-400"
          >
            On time
          </Badge>
        )
      },
      meta: { cardDisplay: "expandable" },
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => {
        const occurrence = row.original

        // Inline "Confirm delete?" state (this codebase has no AlertDialog
        // primitive yet — mirrors goals/components/contribution-history-
        // list.tsx's identical inline-confirm pattern) replaces the ordinary
        // action buttons for whichever row is currently being deleted.
        if (confirmingDeleteId === occurrence.id) {
          return (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Delete?</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-11"
                onClick={() => setConfirmingDeleteId(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                className="h-11"
                disabled={deletingId === occurrence.id}
                onClick={() => handleDelete(occurrence.id)}
              >
                {deletingId === occurrence.id ? "Deleting..." : "Confirm delete"}
              </Button>
            </div>
          )
        }

        // Accessibility fix (Bug Hunter, Phase 5a review gate,
        // data-table-row-action-buttons-below-44px-touch-target.md): `sm`
        // alone is 28px tall, below Responsive AC5's binding 44px minimum
        // (width is already comfortably >44px for both labels, so only
        // height needs the override). Renders unchanged in both DataTable's
        // table view and DataTableCardList's mobile card view by design.
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            {occurrence.status === "PAID" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-11"
                disabled={unmarkingId === occurrence.id}
                onClick={() => handleUnmark(occurrence.id)}
              >
                {unmarkingId === occurrence.id ? "Un-marking..." : "Unmark paid"}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-11"
                onClick={() =>
                  setMarkPaidTarget({
                    id: occurrence.id,
                    billName,
                    dueDate: occurrence.dueDate,
                    expectedAmount,
                  })
                }
              >
                Mark paid
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-11"
              aria-label={`Delete occurrence due ${formatDate(occurrence.dueDate)}`}
              onClick={() => setConfirmingDeleteId(occurrence.id)}
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </div>
        )
      },
    },
  ]

  return (
    <>
      <ResponsiveDataTable
        columns={columns}
        data={occurrences}
        emptyMessage="No occurrences yet."
      />

      <MarkPaidDialog
        open={markPaidTarget !== null}
        onOpenChange={(open) => !open && setMarkPaidTarget(null)}
        occurrence={markPaidTarget}
      />
    </>
  )
}
