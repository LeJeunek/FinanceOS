"use client"

import * as React from "react"

import { statementTextExtractor } from "@/features/statement-import/extraction/http-extractor"
import { convertStatementText, revalidate, summarize } from "@/features/statement-import/pipeline"
import type {
  ConversionResult,
  ConversionSummary,
  DraftTransaction,
} from "@/features/statement-import/types"

/**
 * State for one PDF -> CSV conversion, kept out of the dialog component.
 *
 * The dialog renders; this hook owns the workflow (extract -> convert ->
 * review edits -> selection) and delegates every actual computation to the
 * pure modules in `features/statement-import`. Nothing here knows what a
 * statement looks like, and nothing in the pipeline knows React exists.
 */

export type ConversionStage =
  | "idle"
  | "reading"
  | "extracting"
  | "categorizing"
  | "validating"
  | "review"
  | "error"

export const STAGE_MESSAGES: Record<ConversionStage, string> = {
  idle: "",
  reading: "Reading PDF...",
  extracting: "Extracting transactions...",
  categorizing: "Categorizing transactions...",
  validating: "Validating transactions...",
  review: "",
  error: "",
}

export interface UseStatementConversionOptions {
  /** The user's real category names, so classification and validation use
   * their actual categories rather than only the 11 system ones. */
  allowedCategories: readonly string[]
}

export interface UseStatementConversion {
  stage: ConversionStage
  error: string | null
  result: ConversionResult | null
  drafts: DraftTransaction[]
  summary: ConversionSummary
  /** Ids of rows the user has chosen to export/import. */
  includedIds: ReadonlySet<string>
  includedDrafts: DraftTransaction[]
  /** True when a selected row still has a validation error. */
  hasBlockingErrors: boolean
  convert: (file: File) => Promise<void>
  updateDraft: (id: string, patch: Partial<DraftTransaction>) => void
  setIncluded: (id: string, included: boolean) => void
  reset: () => void
}

const EMPTY_SUMMARY: ConversionSummary = {
  total: 0,
  needsReview: 0,
  categorized: 0,
  uncategorized: 0,
  duplicates: 0,
  invalid: 0,
}

/** Rows start selected unless they are flagged duplicates — the one default
 * that would otherwise cost the user a click on every single row. Duplicates
 * stay unselected but visible, so nothing is dropped without the user seeing
 * it. */
function defaultSelection(drafts: readonly DraftTransaction[]): Set<string> {
  return new Set(
    drafts.filter((draft) => draft.duplicateOfId === null).map((draft) => draft.id),
  )
}

export function useStatementConversion(
  options: UseStatementConversionOptions,
): UseStatementConversion {
  const { allowedCategories } = options

  const [stage, setStage] = React.useState<ConversionStage>("idle")
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<ConversionResult | null>(null)
  const [drafts, setDrafts] = React.useState<DraftTransaction[]>([])
  const [includedIds, setIncludedIds] = React.useState<ReadonlySet<string>>(new Set())

  const convert = React.useCallback(
    async (file: File) => {
      setError(null)
      setResult(null)
      setDrafts([])
      setIncludedIds(new Set())
      setStage("reading")

      let text: string
      try {
        const extracted = await statementTextExtractor.extract(file)
        text = extracted.text
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not read that PDF")
        setStage("error")
        return
      }

      // Parsing, categorization, and validation are synchronous and fast;
      // the stages are still reported so a large statement never looks
      // frozen, and so the user can see which step failed if one does.
      setStage("extracting")
      const converted = convertStatementText(text, { allowedCategories })

      setStage("categorizing")
      setStage("validating")

      setResult(converted)
      setDrafts(converted.transactions)
      setIncludedIds(defaultSelection(converted.transactions))
      setStage("review")
    },
    [allowedCategories],
  )

  const updateDraft = React.useCallback(
    (id: string, patch: Partial<DraftTransaction>) => {
      setDrafts((current) =>
        revalidate(
          current.map((draft) =>
            draft.id === id ? { ...draft, ...patch, isEdited: true } : draft,
          ),
          { allowedCategories },
        ),
      )
    },
    [allowedCategories],
  )

  const setIncluded = React.useCallback((id: string, included: boolean) => {
    setIncludedIds((current) => {
      const next = new Set(current)
      if (included) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const reset = React.useCallback(() => {
    setStage("idle")
    setError(null)
    setResult(null)
    setDrafts([])
    setIncludedIds(new Set())
  }, [])

  const summary = React.useMemo(
    () => (drafts.length > 0 ? summarize(drafts) : EMPTY_SUMMARY),
    [drafts],
  )

  const includedDrafts = React.useMemo(
    () => drafts.filter((draft) => includedIds.has(draft.id)),
    [drafts, includedIds],
  )

  const hasBlockingErrors = React.useMemo(
    () => includedDrafts.some((draft) => draft.errors.length > 0),
    [includedDrafts],
  )

  return {
    stage,
    error,
    result,
    drafts,
    summary,
    includedIds,
    includedDrafts,
    hasBlockingErrors,
    convert,
    updateDraft,
    setIncluded,
    reset,
  }
}
