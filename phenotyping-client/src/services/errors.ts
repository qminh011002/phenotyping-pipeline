// ApiError — thrown by all API functions on failure.
// Carries optional `code` extracted from the FastAPI `{detail: {code, message}}`
// shape used by auth endpoints (BE-020). Routes that return a plain string
// `detail` leave `code` as null and `detail` becomes the message.

export class ApiError extends Error {
  public readonly status: number;
  public readonly detail: string | null;
  public readonly code: string | null;

  constructor(status: number, detail: string | null, code: string | null = null) {
    super(detail ?? `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.code = code;
  }
}
