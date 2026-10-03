// Client-side checks that mirror the backend's upload rules, so people get an
// instant, specific message. The server re-validates everything; this is UX only.

export const ALLOWED_EXTENSIONS = [
  ".pdf", ".docx", ".pptx", ".xlsx", ".xls",
  ".txt", ".md", ".csv", ".html", ".htm", ".json",
  ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff",
];
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function validateSourceFile(file: File): string | null {
  const dot = file.name.lastIndexOf(".");
  const extension = dot === -1 ? "" : file.name.slice(dot).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    return `"${file.name}" can't be used: ${extension || "files without an extension"} isn't supported. Upload ${ALLOWED_EXTENSIONS.join(", ")}.`;
  }
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > MAX_FILE_BYTES) {
    return `"${file.name}" is too large (limit ${MAX_FILE_BYTES / 1024 / 1024} MB).`;
  }
  return null;
}

/** Turns the api.ts error sentinels into something a person can act on. */
export function describeUploadError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : "";
  if (message === "CONNECTION_FAILED") return "Couldn't reach the server. Check your connection and try again.";
  if (message === "UNAUTHORIZED") return "Your session has expired. Please sign in again.";
  return message || fallback;
}

export const STAGE_LABELS: Record<string, string> = {
  queued: "Queued",
  extracting: "Reading file",
  chunking: "Splitting into passages",
  embedding: "Indexing",
  storing: "Saving",
};
