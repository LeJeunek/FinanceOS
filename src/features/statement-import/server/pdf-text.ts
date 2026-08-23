import type { PDFParse as PDFParseType } from "pdf-parse"

import { ok, fail, type ApiResult } from "@/lib/api-response"

/**
 * Server-side PDF text extraction, backing
 * `POST /api/transactions/statement/extract`.
 *
 * `pdf-parse` was already a dependency of this repo (it backed the one-off
 * `scripts/convert-statement-pdf.ts`) and is proven against the statements
 * this feature targets, so it stays the implementation — promoted from a
 * devDependency to a runtime one now that app code, not just a script, calls
 * it. Everything about it is confined to this file: the rest of the
 * converter only knows the `StatementTextExtractor` contract in
 * `extraction/types.ts`.
 *
 * Extraction is the *only* thing that happens here. No parsing, no
 * categorization, no database access — this module takes bytes and returns
 * text, which is what keeps the pipeline swappable and this file trivially
 * replaceable.
 */

/**
 * Matches the CSV importer's 5 MB ceiling
 * (`features/transactions/server/import.ts`), doubled: a PDF carries page
 * imagery and embedded fonts a CSV does not, so the same number of
 * transactions occupies substantially more bytes. Still bounded well below
 * anything that would threaten a request timeout.
 */
export const MAX_STATEMENT_FILE_SIZE_BYTES = 10 * 1024 * 1024

/**
 * Guards against a text-extraction result too large to be a statement (a
 * scanned book, a mis-uploaded document). 2 million characters is roughly a
 * 700-page statement — far beyond any real one, while leaving multi-year
 * exports comfortable headroom.
 */
const MAX_EXTRACTED_CHARACTERS = 2_000_000

export interface ExtractedStatementText {
  text: string
  pageCount: number
}

/**
 * Extracts text from statement PDF bytes.
 *
 * Returns a `fail` result (never throws) for every expected failure —
 * oversized file, corrupt/encrypted PDF, image-only scan — so the Route
 * Handler stays a thin wrapper and the user gets an actionable message
 * instead of a 500.
 */
export async function extractStatementText(
  data: Uint8Array,
  fileSizeBytes: number,
): Promise<ApiResult<ExtractedStatementText>> {
  if (fileSizeBytes > MAX_STATEMENT_FILE_SIZE_BYTES) {
    const maxMb = (MAX_STATEMENT_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0)
    return fail(`That PDF is too large — the maximum statement size is ${maxMb} MB`)
  }

  let parser: PDFParseType | undefined
  try {
    // Imported here rather than at module scope on purpose. `pdfjs-dist`
    // (which pdf-parse wraps) does real work at import time and can fail in a
    // serverless runtime; a top-level import turns that into a 500 on the
    // whole route — before the auth check, and outside this try/catch, so the
    // caller gets Next's HTML error page instead of a usable message. Loading
    // it inside the guarded path means a failure degrades into the same clean
    // `fail(...)` result as a corrupt PDF. Paired with
    // `serverExternalPackages: ["pdf-parse"]` in next.config.ts, which is what
    // actually keeps its worker/font assets reachable in the deployed bundle.
    const { PDFParse } = await import("pdf-parse")
    parser = new PDFParse({ data })
    const result = await parser.getText()
    const text = result.text ?? ""

    if (text.trim().length === 0) {
      // A PDF that yields no text is almost always a scan or a photo. Saying
      // so is far more useful than "no transactions found", which would send
      // the user looking for a parsing bug that isn't there.
      return fail(
        "No text could be read from this PDF. If it is a scanned or photographed statement, download the original PDF from your bank instead — this converter cannot read images.",
      )
    }

    if (text.length > MAX_EXTRACTED_CHARACTERS) {
      return fail("That PDF contains far more text than a statement — check the file and try again")
    }

    return ok({ text, pageCount: result.pages?.length ?? 0 })
  } catch {
    return fail(
      "Could not read this PDF — it may be corrupted, password-protected, or not a PDF at all",
    )
  } finally {
    // pdf-parse holds a pdfjs worker open per instance; not destroying it
    // leaks a worker per upload for the lifetime of the server process.
    await parser?.destroy().catch(() => undefined)
  }
}
