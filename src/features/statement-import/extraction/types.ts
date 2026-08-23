/**
 * The PDF text-extraction contract.
 *
 * The rest of the converter depends on this interface, never on a specific
 * PDF library. Everything downstream consumes plain text, so swapping the
 * implementation — a different library, client-side extraction, or an OCR
 * pass for scanned statements — means writing one new file that satisfies
 * this shape and changing the one line that constructs it. No parser,
 * classifier, or CSV code changes.
 *
 * The current implementation is `extraction/http-extractor.ts` (browser),
 * which delegates to `server/pdf-text.ts` (Node, `pdf-parse`) through
 * `POST /api/transactions/statement/extract`.
 */

export interface ExtractedStatement {
  /** The PDF's full text content, newline-separated in reading order. */
  text: string
  /** Number of pages the document reported, for the review header. */
  pageCount: number
}

export interface StatementTextExtractor {
  /**
   * Extracts text from one statement PDF.
   *
   * Implementations reject rather than returning empty text when the
   * document cannot be read at all, so the caller can distinguish "this PDF
   * is unreadable" from "this PDF has no transactions in it" — two problems
   * with completely different fixes for the user.
   */
  extract(file: File): Promise<ExtractedStatement>
}
