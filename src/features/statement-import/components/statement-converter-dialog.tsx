"use client"

import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Download, FileText, Loader2, ScanText, Upload } from "lucide-react"
import { toast } from "sonner"

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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Account } from "@/features/accounts/types"
import { buildAllowedCategories } from "@/features/statement-import/categories"
import { ReviewTable } from "@/features/statement-import/components/review-table"
import { StatementReconciliationPrompt } from "@/features/statement-import/components/statement-reconciliation-prompt"
import { buildCsvFileName, generateCsv } from "@/features/statement-import/csv"
import {
  STAGE_MESSAGES,
  useStatementConversion,
} from "@/features/statement-import/hooks/use-statement-conversion"
import {
  buildReconciliation,
  netAmountOf,
  type ReconciliationSuggestion,
} from "@/features/statement-import/reconciliation"
import type { TransactionImportSummary } from "@/features/transactions/types"
import type { ApiResult } from "@/lib/api-response"
import { cn } from "@/lib/utils"

/**
 * The PDF -> CSV converter dialog: upload, processing, review, export.
 *
 * This component is composition and presentation only. Every decision it
 * displays — which parser ran, what a row's amount means, whether a row is a
 * duplicate, whether the CSV is safe to export, what the account balance
 * should be — is computed by the pure modules in `features/statement-import`
 * and surfaced here. That is deliberate: the converter's logic is unit-tested
 * without rendering any of this (see `pipeline.test.ts`), and swapping the
 * PDF library or the category rules touches nothing in this file.
 *
 * Export is never automatic. The user reviews and corrects first, which is
 * the entire reason the review step exists — a bank statement's text layer is
 * not a reliable enough source to write straight into a ledger.
 */

export interface StatementConverterDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Non-archived accounts — same list the CSV import dialog uses. */
  accounts: Account[]
  /** The user's own category names (system + custom). */
  categoryNames: string[]
}

export function StatementConverterDialog({
  open,
  onOpenChange,
  accounts,
  categoryNames,
}: StatementConverterDialogProps) {
  const queryClient = useQueryClient()

  const allowedCategories = React.useMemo(
    () => buildAllowedCategories(categoryNames),
    [categoryNames],
  )

  const conversion = useStatementConversion({ allowedCategories })

  const [fileName, setFileName] = React.useState<string>("statement")
  const [accountId, setAccountId] = React.useState("")
  const [isDragging, setIsDragging] = React.useState(false)
  const [overrideErrors, setOverrideErrors] = React.useState(false)
  const [isImporting, setIsImporting] = React.useState(false)
  const [importSummary, setImportSummary] = React.useState<TransactionImportSummary | null>(null)
  const [reconciliation, setReconciliation] = React.useState<ReconciliationSuggestion | null>(null)
  const [importedNet, setImportedNet] = React.useState(0)
  const [pendingFile, setPendingFile] = React.useState<File | null>(null)
  const [pdfPassword, setPdfPassword] = React.useState("")
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // Pulled out of the `conversion` object so the reset effect below depends
  // on this one stable callback rather than the whole hook result (which is a
  // new object on every render, and would re-run the effect endlessly).
  const { reset: resetConversion } = conversion

  React.useEffect(() => {
    if (open) {
      resetConversion()
      setFileName("statement")
      setAccountId("")
      setOverrideErrors(false)
      setImportSummary(null)
      setReconciliation(null)
      setImportedNet(0)
      setPendingFile(null)
      setPdfPassword("")
    }
  }, [open, resetConversion])

  const selectedAccount = accounts.find((account) => account.id === accountId)

  async function handleFile(file: File | null | undefined) {
    if (!file) return
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      toast.error("That is not a PDF. Choose the statement PDF your bank provides.")
      return
    }
    setFileName(file.name)
    setPendingFile(file)
    setPdfPassword("")
    setImportSummary(null)
    setReconciliation(null)
    await conversion.convert(file)
  }

  function handleExportCsv() {
    const csv = generateCsv(conversion.includedDrafts)
    const latestDate = conversion.includedDrafts
      .map((draft) => draft.date)
      .filter((date) => date.length > 0)
      .sort()
      .at(-1)

    // A Blob download rather than a server round-trip: the CSV is already
    // fully computed in the browser, so sending it up only to send it back
    // would add latency and put the statement's contents through the network
    // for no reason.
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = buildCsvFileName(fileName, latestDate ?? null)
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)

    toast.success(
      `Exported ${conversion.includedDrafts.length} transaction${conversion.includedDrafts.length === 1 ? "" : "s"}.`,
    )
  }

  /**
   * Imports straight into FinanceOS by posting the very same CSV bytes the
   * Export button produces to the existing `POST /api/transactions/import`
   * endpoint. No second import path is introduced: duplicate checking against
   * transactions already on file, category matching, and the account's
   * balance adjustment all remain that endpoint's job.
   */
  async function handleImport() {
    if (!accountId) return
    setIsImporting(true)
    try {
      const csv = generateCsv(conversion.includedDrafts)
      const file = new File([csv], `${fileName}.csv`, { type: "text/csv" })

      const formData = new FormData()
      formData.set("file", file)
      formData.set("accountId", accountId)

      const response = await fetch("/api/transactions/import", {
        method: "POST",
        body: formData,
      })
      const result = (await response.json()) as ApiResult<TransactionImportSummary>

      if (!result.success) {
        toast.error(result.error)
        return
      }

      setImportSummary(result.data)
      setImportedNet(netAmountOf(conversion.includedDrafts))
      queryClient.invalidateQueries({ queryKey: ["transactions"] })
      queryClient.invalidateQueries({ queryKey: ["accounts"] })

      if (result.data.imported > 0) {
        toast.success(
          `Imported ${result.data.imported} transaction${result.data.imported === 1 ? "" : "s"}.`,
        )
      }

      // The account's stored balance has just been moved by the import, so
      // the reconciliation comparison is built from the post-import figure.
      if (selectedAccount && conversion.result?.endingBalance) {
        const postImportBalance =
          selectedAccount.type === "CREDIT_CARD"
            ? selectedAccount.balance - netAmountOf(conversion.includedDrafts)
            : selectedAccount.balance + netAmountOf(conversion.includedDrafts)

        setReconciliation(
          buildReconciliation(
            {
              id: selectedAccount.id,
              name: selectedAccount.name,
              type: selectedAccount.type,
              balance: postImportBalance,
            },
            conversion.result.endingBalance,
          ),
        )
      }
    } catch {
      toast.error("Could not reach the server. Please try again.")
    } finally {
      setIsImporting(false)
    }
  }

  const isProcessing =
    conversion.stage === "reading" ||
    conversion.stage === "extracting" ||
    conversion.stage === "categorizing" ||
    conversion.stage === "validating"

  const inReview = conversion.stage === "review"
  const canExport =
    inReview &&
    conversion.includedDrafts.length > 0 &&
    (!conversion.hasBlockingErrors || overrideErrors)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn("sm:max-w-md", inReview && "sm:max-w-[min(96vw,1200px)]")}
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>Convert a statement PDF</DialogTitle>
          <DialogDescription>
            {inReview
              ? "Review the extracted transactions and correct anything that looks wrong before exporting or importing."
              : "Upload a bank or credit-card statement. Transactions are extracted, categorized, and shown for review — nothing is imported until you say so."}
          </DialogDescription>
        </DialogHeader>

        {/* ---------------- Step 1: upload ---------------- */}
        {conversion.stage === "idle" && (
          <div className="grid gap-4">
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  fileInputRef.current?.click()
                }
              }}
              onDragOver={(event) => {
                event.preventDefault()
                setIsDragging(true)
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setIsDragging(false)
                void handleFile(event.dataTransfer.files?.[0])
              }}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors",
                isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25",
              )}
            >
              <FileText className="size-8 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm font-medium">Drop your statement PDF here</p>
              <p className="text-xs text-muted-foreground">or click to choose a file</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(event) => void handleFile(event.target.files?.[0])}
            />
          </div>
        )}

        {/* ---------------- Step 2: processing ---------------- */}
        {isProcessing && (
          <div className="flex items-center gap-3 rounded-lg border px-4 py-6">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            <p className="text-sm" role="status">
              {STAGE_MESSAGES[conversion.stage]}
            </p>
          </div>
        )}

        {/* ------- Encrypted statement: ask for the PDF's password ------- */}
        {conversion.stage === "password" && (
          <div className="grid gap-3">
            <p className="text-sm">
              <span className="font-medium">{fileName}</span> is password-protected.
              {conversion.passwordWasWrong
                ? " That password was not accepted — try again."
                : " Enter the password your bank uses for this statement."}
            </p>
            <form
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (pendingFile && pdfPassword) {
                  void conversion.convert(pendingFile, { password: pdfPassword })
                }
              }}
            >
              <Label htmlFor="pdf-password">PDF password</Label>
              <Input
                id="pdf-password"
                type="password"
                autoComplete="off"
                value={pdfPassword}
                onChange={(event) => setPdfPassword(event.target.value)}
                aria-invalid={conversion.passwordWasWrong}
                className="max-w-72"
              />
              <p className="text-xs text-muted-foreground">
                Used only to open this file. It is never saved.
              </p>
              <div className="flex gap-2">
                <Button type="submit" disabled={!pdfPassword}>
                  Unlock
                </Button>
                <Button type="button" variant="ghost" onClick={conversion.reset}>
                  Choose another file
                </Button>
              </div>
            </form>
          </div>
        )}

        {/* ------- Image-only statement: offer to read it visually ------- */}
        {conversion.stage === "scanned" && (
          <div className="grid gap-3">
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
              <p className="font-medium">This statement is a scan, not a text PDF.</p>
              <p className="mt-1 text-muted-foreground">
                <span className="font-medium text-foreground">{fileName}</span> contains page
                images with no text layer, so it cannot be read directly. The pages can be read
                visually instead — this sends the statement to the same AI provider this app
                already uses for category suggestions. You will still review and correct every
                row before anything is imported.
              </p>
              <p className="mt-1 text-muted-foreground">
                Prefer not to? Download the original PDF from your bank&apos;s online banking
                instead — those have a text layer and are read locally.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => {
                  if (pendingFile) void conversion.convert(pendingFile, { vision: true })
                }}
              >
                <ScanText className="size-4" aria-hidden="true" />
                Read this scan
              </Button>
              <Button type="button" variant="ghost" onClick={conversion.reset}>
                Choose another file
              </Button>
            </div>
          </div>
        )}

        {conversion.stage === "error" && (
          <div className="grid gap-3">
            <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
              {conversion.error}
            </p>
            <Button type="button" variant="outline" onClick={conversion.reset}>
              Try another file
            </Button>
          </div>
        )}

        {/* ---------------- Step 3: review ---------------- */}
        {inReview && (
          <div className="grid min-h-0 gap-3">
            {conversion.drafts.length === 0 ? (
              <div className="grid gap-3">
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
                  No transactions were found in <span className="font-medium">{fileName}</span>.
                  {conversion.result?.parserId === "none"
                    ? " This layout was not recognized — if the PDF is a scan or photo, download the original from your bank instead."
                    : " The statement was recognized but contained no transaction rows."}
                </p>
                <Button type="button" variant="outline" onClick={conversion.reset}>
                  Try another file
                </Button>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="secondary">{conversion.summary.total} detected</Badge>
                  <Badge variant={conversion.summary.needsReview > 0 ? "default" : "outline"}>
                    {conversion.summary.needsReview} need review
                  </Badge>
                  <Badge variant="outline">{conversion.summary.categorized} categorized</Badge>
                  <Badge variant="outline">{conversion.summary.uncategorized} uncategorized</Badge>
                  <Badge variant="outline">
                    {conversion.summary.duplicates} possible duplicate
                    {conversion.summary.duplicates === 1 ? "" : "s"}
                  </Badge>
                  {conversion.summary.invalid > 0 && (
                    <Badge variant="destructive">{conversion.summary.invalid} invalid</Badge>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {fileName} · read as {conversion.result?.parserLabel}
                  </span>
                </div>

                {conversion.result && conversion.result.unparsedLines.length > 0 && (
                  <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                    {conversion.result.unparsedLines.length} line
                    {conversion.result.unparsedLines.length === 1 ? "" : "s"} looked like a
                    transaction but could not be read, so {conversion.result.unparsedLines.length === 1 ? "it is" : "they are"} not in the table
                    below. Check the statement for anything missing.
                  </p>
                )}

                <ScrollArea className="h-[52vh] rounded-md border">
                  <ReviewTable
                    drafts={conversion.drafts}
                    includedIds={conversion.includedIds}
                    allowedCategories={allowedCategories}
                    onChange={conversion.updateDraft}
                    onIncludedChange={conversion.setIncluded}
                  />
                </ScrollArea>

                {conversion.hasBlockingErrors && (
                  <label className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-destructive"
                      checked={overrideErrors}
                      onChange={(event) => setOverrideErrors(event.target.checked)}
                    />
                    <span>
                      {conversion.summary.invalid} selected row
                      {conversion.summary.invalid === 1 ? " has" : "s have"} validation errors.
                      Export anyway — I&apos;ll fix them in the CSV.
                    </span>
                  </label>
                )}

                <div className="grid gap-1.5">
                  <Label htmlFor="converter-account">Import into account (optional)</Label>
                  <Select value={accountId} onValueChange={setAccountId}>
                    <SelectTrigger id="converter-account" className="w-full sm:w-72">
                      <SelectValue placeholder="Select an account" />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {importSummary && (
                  <div className="grid gap-2 rounded-md border px-3 py-2.5 text-sm">
                    <p>
                      <span className="font-medium">{importSummary.imported}</span> imported,{" "}
                      <span className="font-medium">{importSummary.skippedDuplicates}</span>{" "}
                      already on file, {importSummary.errors.length} error
                      {importSummary.errors.length === 1 ? "" : "s"}.
                    </p>
                    {importSummary.errors.length > 0 && (
                      <ScrollArea className="h-24 rounded border">
                        <ul className="divide-y">
                          {importSummary.errors.map((rowError, index) => (
                            <li key={index} className="px-2 py-1.5 text-xs text-muted-foreground">
                              Row {rowError.row}: {rowError.message}
                            </li>
                          ))}
                        </ul>
                      </ScrollArea>
                    )}
                  </div>
                )}

                {reconciliation && (
                  <StatementReconciliationPrompt
                    suggestion={reconciliation}
                    importedNet={importedNet}
                    importedCount={importSummary?.imported ?? 0}
                    skippedDuplicates={importSummary?.skippedDuplicates ?? 0}
                  />
                )}
              </>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {importSummary ? "Done" : "Cancel"}
          </Button>

          {inReview && conversion.drafts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={handleExportCsv} disabled={!canExport}>
                <Download className="size-4" aria-hidden="true" />
                Export CSV ({conversion.includedDrafts.length})
              </Button>
              <Button
                type="button"
                onClick={handleImport}
                disabled={!canExport || !accountId || isImporting || importSummary !== null}
              >
                <Upload className="size-4" aria-hidden="true" />
                {isImporting ? "Importing..." : "Import into FinanceOS"}
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
