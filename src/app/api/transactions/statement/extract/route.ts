import { NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"
import { fail } from "@/lib/api-response"
import { extractStatementText } from "@/features/statement-import/server/pdf-text"

/**
 * `POST /api/transactions/statement/extract` (multipart/form-data with a
 * `file` field) — returns the text content of a statement PDF.
 *
 * A Route Handler rather than a Server Action for the same reason
 * `POST /api/transactions/import` is one (see that route's JSDoc): the
 * payload is an uploaded file posted with plain `fetch`, not a form
 * submission.
 *
 * Deliberately narrow: this endpoint extracts text and nothing else. Parsing,
 * categorization, and review all happen client-side in
 * `features/statement-import`, and no transaction is created until the user
 * reviews the result and runs the existing CSV import. That means this route
 * writes nothing to the database and needs no account scoping — but it still
 * requires an authenticated session, since PDF parsing is unauthenticated
 * compute a public endpoint would happily burn on anyone's uploads.
 */
/** PDF parsing needs real Node APIs (`pdfjs-dist` is not Edge-compatible),
 * so this route is pinned to the Node runtime rather than relying on the
 * default. */
export const runtime = "nodejs"

/** A large multi-page statement can take longer than the default serverless
 * limit to parse. 60s is the ceiling on Vercel's Hobby plan. */
export const maxDuration = 60

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json(fail("UNAUTHENTICATED"), { status: 401 })
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json(fail("Expected a multipart/form-data request with a file"), {
      status: 400,
    })
  }

  const file = formData.get("file")
  if (!(file instanceof File)) {
    return NextResponse.json(fail("A PDF file is required"), { status: 400 })
  }

  let data: Uint8Array
  try {
    data = new Uint8Array(await file.arrayBuffer())
  } catch {
    return NextResponse.json(fail("Could not read the uploaded file"), { status: 400 })
  }

  const result = await extractStatementText(data, file.size)
  return NextResponse.json(result, { status: result.success ? 200 : 400 })
}
