// ApiError — thrown by all API functions on failure

export class ApiError extends Error {
  public readonly status: number;
  public readonly detail: string | null;

  constructor(status: number, detail: string | null) {
    super(detail ?? `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}
