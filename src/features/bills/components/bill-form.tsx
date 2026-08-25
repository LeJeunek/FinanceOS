"use client"

/**
 * BillFormDialog — a single form used for both creating and editing a bill
 * (bills.md AC1/AC4), plus AddBillButton, a small trigger that opens it in
 * create mode. One component pair instead of two near-duplicate forms, per
 * the company's "avoid duplication" rule — mirrors
 * `features/accounts/components/account-form.tsx`'s exact
 * AccountFormDialog/AddAccountButton pattern.
 *
 * Controlled `open`/`onOpenChange` (not a built-in `DialogTrigger`) because
 * this dialog is opened from multiple places — a page-header "Add Bill"
 * button and (once built) a bill detail page's "Edit" action — same
 * rationale as account-form.tsx's identical choice.
 *
 * Calls the `createBill`/`updateBill` Server Actions directly (not a
 * TanStack Query mutation hook) and follows up with `router.refresh()` —
 * per docs/architecture/folder-tree.md's Phase 2 note, Bills only gets a
 * query hook for its `includeArchived` list-refetch case, not for ordinary
 * create/update/archive flows, which follow the Accounts pattern instead.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { PlusIcon } from "lucide-react"
import { toast } from "sonner"

import type { Bill, BillSchedule } from "@/features/bills/types"
import { createBill, updateBill } from "@/features/bills/server/actions"
import type {
  CreateBillInput,
  UpdateBillInput,
} from "@/features/bills/server/validation"
import type { Category } from "@/features/categories/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"

/** Human-readable labels for `BillSchedule` — the raw Prisma enum value is
 * never shown directly to the user. Exported so any other bills component
 * needing the same labels (none currently do) reuses this instead of
 * re-deriving its own copy — same precedent as account-card.tsx's
 * `ACCOUNT_TYPE_LABELS`. */
export const BILL_SCHEDULE_LABELS: Record<BillSchedule, string> = {
  WEEKLY: "Weekly",
  BIWEEKLY: "Biweekly",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUALLY: "Annually",
}

const BILL_SCHEDULE_VALUES = Object.keys(BILL_SCHEDULE_LABELS) as BillSchedule[]

const NONE_CATEGORY_VALUE = "__none__"

/** Ordinal suffix for a day of the month ("10th", "1st", "22nd"). */
function ordinal(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return `${day}th`
  switch (day % 10) {
    case 1:
      return `${day}st`
    case 2:
      return `${day}nd`
    case 3:
      return `${day}rd`
    default:
      return `${day}th`
  }
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]

/**
 * Plain-English restatement of what a due date means once a recurring
 * schedule is applied to it — "Repeats on the 10th of each month".
 *
 * The date field is an anchor, not a one-off date, which is not obvious from
 * a bare date input: a user wanting "the 10th of the month" has no way to
 * tell whether picking a date in September sets a day-of-month or a single
 * dated event. Saying it back to them removes the guess.
 */
function describeRecurrence(dueDate: string, schedule: BillSchedule): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return null
  const date = new Date(`${dueDate}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return null

  const day = date.getUTCDate()

  switch (schedule) {
    case "WEEKLY":
      return `Repeats every ${WEEKDAYS[date.getUTCDay()]}.`
    case "BIWEEKLY":
      return `Repeats every other ${WEEKDAYS[date.getUTCDay()]}.`
    case "MONTHLY":
      return day > 28
        ? `Repeats on the ${ordinal(day)} of each month, moving to the last day in shorter months.`
        : `Repeats on the ${ordinal(day)} of each month.`
    case "QUARTERLY":
      return `Repeats every three months, on the ${ordinal(day)}.`
    case "ANNUALLY":
      return `Repeats once a year, on this date.`
    default:
      return null
  }
}

/** Client-side form schema. Deliberately separate from
 * `server/validation.ts`'s `CreateBillSchema`/`UpdateBillSchema` — those
 * operate on the *post-transform* shape (`dueDate` as a `Date`), while
 * react-hook-form needs the pre-transform `"yyyy-mm-dd"` string a native
 * `<input type="date">` produces, matching `transaction-form.tsx`'s
 * identical split between its own local Zod schema and the server's. */
const BillFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120, "Name must be 120 characters or fewer"),
  expectedAmount: z
    .number({ error: "Expected amount must be a number" })
    .finite("Expected amount must be a finite number")
    .positive("Expected amount must be greater than zero"),
  dueDate: z.string().min(1, "Due date is required"),
  schedule: z.enum(BILL_SCHEDULE_VALUES as [BillSchedule, ...BillSchedule[]]),
  categoryId: z.string(),
})

type BillFormValues = z.infer<typeof BillFormSchema>

function toDateInputValue(date: Date | string): string {
  const value = typeof date === "string" ? new Date(date) : date
  return value.toISOString().slice(0, 10)
}

function buildDefaultValues(bill: Bill | null | undefined): BillFormValues {
  if (!bill) {
    return {
      name: "",
      expectedAmount: 0,
      dueDate: toDateInputValue(new Date()),
      schedule: "MONTHLY",
      categoryId: NONE_CATEGORY_VALUE,
    }
  }
  return {
    name: bill.name,
    expectedAmount: bill.expectedAmount,
    dueDate: toDateInputValue(bill.dueDate),
    schedule: bill.schedule,
    categoryId: bill.categoryId ?? NONE_CATEGORY_VALUE,
  }
}

export interface BillFormDialogProps {
  /** Present = edit mode, null/undefined = create mode. */
  bill?: Bill | null
  categories: Category[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful create/update, in addition to this
   * component's own `router.refresh()` — lets a caller close a parent
   * dropdown or navigate, mirroring how `account-card.tsx` composes
   * `AccountFormDialog`. Optional since the page-level "Add Bill" trigger
   * has nothing extra to do beyond the refresh. */
  onSaved?: (bill: Bill) => void
}

export function BillFormDialog({
  bill,
  categories,
  open,
  onOpenChange,
  onSaved,
}: BillFormDialogProps) {
  const router = useRouter()
  const isEditMode = bill !== undefined && bill !== null

  const form = useForm<BillFormValues>({
    resolver: zodResolver(BillFormSchema),
    defaultValues: buildDefaultValues(bill),
  })

  // Re-syncs whenever the dialog opens (create vs. edit, or a different
  // bill entirely) — this single dialog instance is reused across every
  // trigger, same rationale as account-form.tsx's identical effect.
  useEffect(() => {
    if (open) {
      form.reset(buildDefaultValues(bill))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bill])

  async function onSubmit(values: BillFormValues) {
    const categoryId = values.categoryId === NONE_CATEGORY_VALUE ? "" : values.categoryId

    // Both Server Actions re-validate `dueDate` from scratch via their own
    // `dateOnlySchema` (server/validation.ts), which accepts the
    // pre-transform `"yyyy-mm-dd"` string this form collects — the cast
    // bridges the gap between that runtime-accepted shape and the
    // post-transform `Date` the *type* declares, identical to
    // transaction-form.tsx's `as unknown as UpdateTransactionInput` note.
    const result = isEditMode
      ? await updateBill({
          id: bill.id,
          name: values.name,
          expectedAmount: values.expectedAmount,
          dueDate: values.dueDate,
          schedule: values.schedule,
          categoryId,
        } as unknown as UpdateBillInput)
      : await createBill({
          name: values.name,
          expectedAmount: values.expectedAmount,
          dueDate: values.dueDate,
          schedule: values.schedule,
          categoryId,
        } as unknown as CreateBillInput)

    if (!result.success) {
      toast.error(result.error)
      return
    }

    toast.success(isEditMode ? "Bill updated" : "Bill created")
    onOpenChange(false)
    onSaved?.(result.data)
    // Re-runs the Server Component page's getBills()/getBillById() call —
    // see app/(dashboard)/bills/page.tsx and [billId]/page.tsx.
    router.refresh()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditMode ? "Edit bill" : "Add bill"}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? "Update this bill's details. Changes to amount or schedule only affect future occurrences."
              : "Set up a recurring bill to track its due dates and paid status."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Netflix, Mortgage" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="expectedAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Expected amount</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={Number.isNaN(field.value) ? "" : field.value}
                        onChange={(event) => field.onChange(event.target.valueAsNumber)}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="dueDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{isEditMode ? "Next due date" : "First due date"}</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    {describeRecurrence(field.value, form.watch("schedule")) && (
                      <FormDescription>
                        {describeRecurrence(field.value, form.watch("schedule"))}
                        {isEditMode ? " Changing it reschedules upcoming occurrences; paid ones are left alone." : ""}
                      </FormDescription>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="schedule"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Recurring schedule</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select a schedule" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {BILL_SCHEDULE_VALUES.map((schedule) => (
                        <SelectItem key={schedule} value={schedule}>
                          {BILL_SCHEDULE_LABELS[schedule]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="categoryId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="No category" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE_CATEGORY_VALUE}>No category</SelectItem>
                      {categories.map((category) => (
                        <SelectItem key={category.id} value={category.id}>
                          {category.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {isEditMode ? "Save changes" : "Add bill"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

export interface AddBillButtonProps {
  categories: Category[]
  /** Override the trigger label, e.g. for the zero-bills empty state. */
  label?: string
}

/** Self-contained "Add Bill" trigger: owns its own open state so a Server
 * Component page can render it without itself needing to be a Client
 * Component — mirrors account-form.tsx's `AddAccountButton`. */
export function AddBillButton({ categories, label = "Add bill" }: AddBillButtonProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <PlusIcon />
        {label}
      </Button>
      <BillFormDialog open={open} onOpenChange={setOpen} categories={categories} />
    </>
  )
}
