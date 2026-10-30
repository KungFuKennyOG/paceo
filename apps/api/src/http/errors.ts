/** Errors rendered as the contract ErrorBody: { error: { code, message, details? } }. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what = "Not found") => new AppError(404, "not_found", what);
export const unauthorized = () => new AppError(401, "unauthorized", "Sign in first.");
export const forbidden = (msg = "Not allowed.") => new AppError(403, "forbidden", msg);
export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
