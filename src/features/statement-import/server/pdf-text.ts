import type { PDFParse as PDFParseType } from "pdf-parse"

import { ok, fail, type ApiResult } from "@/lib/api-response"
import { ensurePdfDomGlobals } from "@/features/statement-import/server/pdf-dom-shim"

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
 * Sentinel error strings the client reacts to programmatically, following the
 * codebase's existing `fail("UNAUTHENTICATED")` convention rather than
 * inventing a second response shape. `features/statement-import/components/
 * statement-converter-dialog.tsx` maps these onto the password prompt.
 */
export const PASSWORD_REQUIRED = "PASSWORD_REQUIRED"
export const PASSWORD_INCORRECT = "PASSWORD_INCORRECT"
/** The PDF carries no text layer — it is a scan or photo of a statement.
 * The dialog turns this into the offer to read the pages visually. */
export const SCANNED_PDF = "SCANNED_PDF"

/** pdf-parse inserts a `-- N of M --` separator per page whether or not the
 * page contains anything, so those must be discounted before deciding a
 * document has no text. */
const PAGE_MARKER_PATTERN = /^--\s*\d+\s+of\s+\d+\s*--$/

/** Whether a document yielded any genuine text, as opposed to nothing but
 * pdf-parse's page furniture. */
export function hasRealText(text: string): boolean {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !PAGE_MARKER_PATTERN.test(line))
}

/**
 * Extracts text from statement PDF bytes.
 *
 * Returns a `fail` result (never throws) for every expected failure —
 * oversized file, corrupt/encrypted PDF, image-only scan — so the Route
 * Handler stays a thin wrapper and the user gets an actionable message
 * instead of a 500.
 *
 * **On error reporting.** An earlier version of this function collapsed every
 * thrown error into one "corrupted, password-protected, or not a PDF"
 * message. That was actively harmful: a password-protected statement (which
 * plenty of banks issue by default) is a completely different problem from a
 * damaged file, and the merged message made a routine, fixable situation look
 * like a bug in the converter. Each failure mode pdfjs distinguishes is now
 * reported distinctly, and anything genuinely unexpected carries its
 * underlying message so a real defect is diagnosable instead of disguised.
 */
export async function extractStatementText(
  data: Uint8Array,
  fileSizeBytes: number,
  password?: string,
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
    // Must precede the import: pdfjs reads these globals while its own
    // module body evaluates, and in a bundled serverless runtime its
    // self-polyfill cannot resolve them. See `pdf-dom-shim.ts`.
    ensurePdfDomGlobals()

    const { PDFParse } = await import("pdf-parse")

    // pdfjs takes ownership of the typed array it is handed and detaches the
    // underlying ArrayBuffer, leaving the caller's `data` zero-length once
    // this returns. Callers reasonably expect their own bytes to survive a
    // read — notably the scanned-PDF path, which tries text extraction first
    // and then re-sends the same document for visual transcription. Copying
    // here keeps that ownership entirely inside this module.
    const ownedData = data.slice()
    parser = new PDFParse(password ? { data: ownedData, password } : { data: ownedData })
    const result = await parser.getText()
    const text = result.text ?? ""

    if (!hasRealText(text)) {
      // An image-only PDF (a scan, or a "print to PDF" of a screenshot) has no
      // text layer at all, so no amount of parser work can read it.
      //
      // The emptiness test must ignore pdf-parse's own `-- 1 of 2 --` page
      // separators: it injects those regardless of page content, so a
      // two-page scan comes back as ~32 characters of pure furniture and a
      // naive `text.trim().length === 0` check passes. That bug is why a
      // scanned statement previously fell through to "no transactions found"
      // (or, once a later error fired, to a bogus "corrupted file" message)
      // instead of saying what was actually wrong.
      return fail(SCANNED_PDF)
    }

    if (text.length > MAX_EXTRACTED_CHARACTERS) {
      return fail("That PDF contains far more text than a statement — check the file and try again")
    }

    return ok({ text, pageCount: result.pages?.length ?? 0 })
  } catch (error) {
    return fail(describeExtractionFailure(error, password !== undefined))
  } finally {
    // pdf-parse holds a pdfjs worker open per instance; not destroying it
    // leaks a worker per upload for the lifetime of the server process.
    await parser?.destroy().catch(() => undefined)
  }
}

/**
 * Turns a thrown pdfjs error into a message that tells the user what to
 * actually do about it.
 *
 * pdfjs reports its expected failures as named exception classes carrying a
 * `name` property, which survives the bundler (unlike `instanceof` against
 * classes imported from a package that may be loaded more than once), so the
 * name is what is matched here.
 *
 * `PasswordException` covers two distinct cases that pdfjs separates by
 * `code`: no password was supplied for an encrypted file (1,
 * `NEED_PASSWORD`) and a supplied password was wrong (2, `INCORRECT_PASSWORD`).
 * Both map to sentinels the dialog turns into a password prompt.
 */
function describeExtractionFailure(error: unknown, passwordWasSupplied: boolean): string {
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : ""
  const message = error instanceof Error ? error.message : String(error)

  if (name === "PasswordException") {
    const code = typeof error === "object" && error !== null && "code" in error
      ? Number((error as { code: unknown }).code)
      : undefined
    // Fall back on whether a password was already tried when `code` is absent.
    if (code === 2 || (code === undefined && passwordWasSupplied)) return PASSWORD_INCORRECT
    return PASSWORD_REQUIRED
  }

  if (name === "InvalidPDFException") {
    return "This file is not a readable PDF. If you exported or renamed it, try downloading the original statement from your bank again."
  }

  if (name === "ResponseException" || name === "MissingPDFException") {
    return "The PDF could not be loaded in full — the upload may have been truncated. Try again."
  }

  // Anything else is unexpected. Log it so it lands in the server's runtime
  // logs, and surface the underlying message rather than a generic line that
  // would leave a genuine defect looking like a bad file.
  console.error("[statement-import] PDF extraction failed:", error)
  return `Could not read this PDF: ${message || "unknown error"}`
}
