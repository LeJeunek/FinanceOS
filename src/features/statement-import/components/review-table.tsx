"use client"

import * as React from "react"
import { AlertTriangle, Copy, Info } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { UNCATEGORIZED } from "@/features/statement-import/categories"
import type { DraftTransaction } from "@/features/statement-import/types"
import { cn } from "@/lib/utils"

/**
 * The converter's review step: every extracted transaction, inline-editable,
 * with anything uncertain made visually obvious.
 *
 * This component renders and emits edits — it computes nothing. Validation,
 * duplicate detection, and categorization all live in the pipeline, and the
 * parent's `useStatementConversion` hook re-runs the relevant ones after each
 * edit. That separation is what lets the conversion logic be tested without
 * rendering any of this.
 */

export interface ReviewTableProps {
  drafts: DraftTransaction[]
  includedIds: ReadonlySet<string>
  allowedCategories: readonly string[]
  onChange: (id: string, patch: Partial<DraftTransaction>) => void
  onIncludedChange: (id: string, included: boolean) => void
}

/** Row-level status shown in the last column, most severe first. */
function statusFor(draft: DraftTransaction): {
  label: string
  variant: "default" | "secondary" | "destructive" | "outline"
  detail: string
} | null {
  if (draft.errors.length > 0) {
    return {
      label: "Needs fixing",
      variant: "destructive",
      detail: draft.errors.map((error) => error.message).join(" · "),
    }
  }
  if (draft.duplicateOfId !== null) {
    return {
      label: "Possible duplicate",
      variant: "outline",
      detail: `Same date, merchant, and amount as an earlier row. Unselected by default — select it if both charges are real.`,
    }
  }
  if (draft.category === UNCATEGORIZED) {
    return {
      label: "Uncategorized",
      variant: "secondary",
      detail: "No rule matched this merchant. Pick a category, or import it as uncategorized.",
    }
  }
  if (draft.confidence === "weak") {
    return {
      label: "Check category",
      variant: "secondary",
      detail: "More than one rule could apply, or the match came from the notes rather than the merchant name.",
    }
  }
  if (draft.confidence === "manual") {
    return { label: "Edited", variant: "outline", detail: "You set this row's values." }
  }
  return null
}

function errorFor(draft: DraftTransaction, field: string): string | undefined {
  return draft.errors.find((error) => error.field === field)?.message
}

const CELL_INPUT = "h-8 border-transparent bg-transparent px-2 hover:border-input focus:border-input"
const INVALID_CELL = "border-destructive bg-destructive/5"

export function ReviewTable({
  drafts,
  includedIds,
  allowedCategories,
  onChange,
  onIncludedChange,
}: ReviewTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <span className="sr-only">Include</span>
          </TableHead>
          <TableHead className="w-32">Date</TableHead>
          <TableHead className="min-w-48">Merchant</TableHead>
          <TableHead className="w-28 text-right">Amount</TableHead>
          <TableHead className="w-44">Category</TableHead>
          <TableHead className="min-w-48">Notes</TableHead>
          <TableHead className="w-40">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {drafts.map((draft) => {
          const status = statusFor(draft)
          const included = includedIds.has(draft.id)
          const dateError = errorFor(draft, "date")
          const merchantError = errorFor(draft, "merchant")
          const amountError = errorFor(draft, "amount")

          return (
            <TableRow
              key={draft.id}
              className={cn(
                draft.errors.length > 0 && "bg-destructive/5",
                !included && "opacity-55",
              )}
            >
              <TableCell>
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={included}
                  onChange={(event) => onIncludedChange(draft.id, event.target.checked)}
                  aria-label={`Include ${draft.merchant || "this transaction"} in the export`}
                />
              </TableCell>

              <TableCell>
                <Input
                  value={draft.date}
                  placeholder="yyyy-mm-dd"
                  aria-label="Date"
                  aria-invalid={dateError !== undefined}
                  title={dateError}
                  className={cn(CELL_INPUT, dateError && INVALID_CELL)}
                  onChange={(event) => onChange(draft.id, { date: event.target.value })}
                />
              </TableCell>

              <TableCell>
                <Input
                  value={draft.merchant}
                  placeholder="Merchant"
                  aria-label="Merchant"
                  aria-invalid={merchantError !== undefined}
                  title={merchantError ?? `Statement text: ${draft.source.rawDescription || "(none)"}`}
                  className={cn(CELL_INPUT, merchantError && INVALID_CELL)}
                  onChange={(event) => onChange(draft.id, { merchant: event.target.value })}
                />
              </TableCell>

              <TableCell>
                <Input
                  // Text, not number: a partially-typed "-" or "." must not be
                  // silently coerced to an empty value mid-keystroke.
                  value={draft.amount === null ? "" : String(draft.amount)}
                  placeholder={draft.source.rawAmount}
                  aria-label="Amount"
                  aria-invalid={amountError !== undefined}
                  title={amountError ?? `Statement printed: ${draft.source.rawAmount}`}
                  className={cn(
                    CELL_INPUT,
                    "text-right tabular-nums",
                    amountError && INVALID_CELL,
                    draft.amount !== null && draft.amount < 0
                      ? "text-foreground"
                      : "text-emerald-700 dark:text-emerald-400",
                  )}
                  onChange={(event) => {
                    const raw = event.target.value.trim()
                    const parsed = Number(raw)
                    onChange(draft.id, {
                      amount: raw.length === 0 || Number.isNaN(parsed) ? null : parsed,
                    })
                  }}
                />
              </TableCell>

              <TableCell>
                <Select
                  value={draft.category}
                  onValueChange={(value) =>
                    onChange(draft.id, { category: value, confidence: "manual" })
                  }
                >
                  <SelectTrigger className="h-8 w-full border-transparent bg-transparent hover:border-input">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {allowedCategories.map((category) => (
                      <SelectItem key={category} value={category}>
                        {category}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>

              <TableCell>
                <Input
                  value={draft.notes}
                  aria-label="Notes"
                  className={cn(CELL_INPUT, "text-muted-foreground")}
                  onChange={(event) => onChange(draft.id, { notes: event.target.value })}
                />
              </TableCell>

              <TableCell>
                <div className="flex flex-wrap items-center gap-1">
                  {status && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant={status.variant} className="cursor-help">
                          {status.variant === "destructive" && (
                            <AlertTriangle className="size-3" aria-hidden="true" />
                          )}
                          {draft.duplicateOfId !== null && (
                            <Copy className="size-3" aria-hidden="true" />
                          )}
                          {status.label}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-72">{status.detail}</TooltipContent>
                    </Tooltip>
                  )}

                  {draft.assumptions.length > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="ghost" className="cursor-help text-muted-foreground">
                          <Info className="size-3" aria-hidden="true" />
                          {draft.assumptions.length}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-80">
                        <ul className="list-disc space-y-1 pl-4">
                          {draft.assumptions.map((assumption, index) => (
                            <li key={index}>{assumption}</li>
                          ))}
                        </ul>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
