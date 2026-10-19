/** Error description safe for logs: class name, code and HTTP status only. The message can carry user text. */
export function errorInfo(error: unknown): string {
  if (typeof error !== "object" || error === null) return typeof error;
  const { code, status } = error as { code?: unknown; status?: unknown };
  return [
    error instanceof Error ? error.name : "object",
    typeof code === "string" || typeof code === "number" ? `code=${code}` : "",
    typeof status === "number" ? `status=${status}` : "",
  ].filter(Boolean).join(" ");
}
