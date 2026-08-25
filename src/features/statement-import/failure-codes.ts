/**
 * Extraction failure sentinels, shared by the server extractor and the client
 * dialog.
 *
 * These live in their own dependency-free module for a specific reason: they
 * were originally declared in `server/pdf-text.ts`, which meant the
 * `"use client"` conversion hook imported a module that also pulls in the
 * pdfjs shim and a dynamic `import("pdf-parse")`. That module cannot
 * meaningfully evaluate in a browser bundle, so the constants arrived
 * `undefined`, every `message === SENTINEL` comparison failed, and the user
 * was shown the raw sentinel string instead of the intended prompt.
 *
 * Anything both sides need belongs here, and this file must never import
 * anything server-only.
 *
 * Following the codebase's existing `fail("UNAUTHENTICATED")` convention:
 * these are ordinary `ApiResult` error strings, not a second response shape.
 */

/** The PDF is encrypted and no password was supplied. */
export const PASSWORD_REQUIRED = "PASSWORD_REQUIRED"

/** A password was supplied and the PDF rejected it. */
export const PASSWORD_INCORRECT = "PASSWORD_INCORRECT"

/** The PDF has no text layer — it is a scan or a photo of a statement. */
export const SCANNED_PDF = "SCANNED_PDF"

/**
 * The PDF library could not be loaded in this runtime. Nothing to do with the
 * user's file, and deliberately distinct from `SCANNED_PDF` so the converter
 * never tells someone their perfectly good text PDF is a scan.
 */
export const TEXT_EXTRACTION_UNAVAILABLE = "TEXT_EXTRACTION_UNAVAILABLE"

/**
 * Separator between a sentinel and its optional diagnostic detail.
 *
 * A bare sentinel tells the UI what to do; the detail tells a developer what
 * actually went wrong. Carrying both in the one `error` string keeps the
 * shared `ApiResult` shape intact while making an environment failure
 * diagnosable from the client instead of only from server logs.
 */
const DETAIL_SEPARATOR = ": "

/** Builds a sentinel, optionally carrying diagnostic detail. */
export function withDetail(code: string, detail?: string): string {
  return detail ? `${code}${DETAIL_SEPARATOR}${detail}` : code
}

/** Whether an error string is the given sentinel, with or without detail. */
export function isFailureCode(message: string, code: string): boolean {
  return message === code || message.startsWith(code + DETAIL_SEPARATOR)
}

/** The diagnostic detail attached to a sentinel, if any. */
export function failureDetail(message: string, code: string): string | null {
  return message.startsWith(code + DETAIL_SEPARATOR)
    ? message.slice(code.length + DETAIL_SEPARATOR.length)
    : null
}
