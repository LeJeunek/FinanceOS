import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * `pdf-parse` (used by `features/statement-import/server/pdf-text.ts` for
   * the PDF -> CSV converter) wraps `pdfjs-dist`, which resolves its worker
   * and standard-font files from real paths inside its own package at
   * runtime. Bundling it into the serverless function leaves those assets
   * behind, so the import throws and every request to
   * `/api/transactions/statement/extract` returns a 500 before the handler
   * runs — which is exactly what happened on the first production deploy,
   * despite the route working locally.
   *
   * Marking it external keeps the package intact in `node_modules` and lets
   * Next's file tracing ship its assets alongside the function.
   */
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
