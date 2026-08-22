import type {
  ExtractedStatement,
  StatementTextExtractor,
} from "@/features/statement-import/extraction/types"
import type { ApiResult } from "@/lib/api-response"

/**
 * Browser-side `StatementTextExtractor` — posts the PDF to
 * `POST /api/transactions/statement/extract` and returns the text it gets
 * back.
 *
 * The extraction itself runs on the server (see `server/pdf-text.ts` for
 * why: `pdf-parse` is already a proven dependency here, and keeping the
 * pdfjs worker out of the client bundle keeps the transactions page's
 * JavaScript unchanged in size for the vast majority of users who never open
 * this dialog).
 *
 * Failures are thrown as ordinary `Error`s carrying the server's own
 * user-facing message, so the dialog can render `error.message` directly
 * rather than mapping status codes to copy of its own.
 */
export class HttpStatementTextExtractor implements StatementTextExtractor {
  async extract(file: File): Promise<ExtractedStatement> {
    const formData = new FormData()
    formData.set("file", file)

    let response: Response
    try {
      response = await fetch("/api/transactions/statement/extract", {
        method: "POST",
        body: formData,
      })
    } catch {
      throw new Error("Could not reach the server. Please try again.")
    }

    let result: ApiResult<ExtractedStatement>
    try {
      result = (await response.json()) as ApiResult<ExtractedStatement>
    } catch {
      throw new Error("The server returned an unreadable response. Please try again.")
    }

    if (!result.success) {
      throw new Error(result.error)
    }
    return result.data
  }
}

/** The extractor the converter UI uses. Swapping implementations (a
 * client-side parser, an OCR-backed one) is a change to this one line. */
export const statementTextExtractor: StatementTextExtractor = new HttpStatementTextExtractor()
