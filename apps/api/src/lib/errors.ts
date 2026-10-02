// Application errors carry an HTTP status and a stable machine code; the
// error handler renders them as RFC 9457 problem+json.

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: {
      errors?: Array<{ path: string; message: string }>;
      headers?: Record<string, string>;
    },
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const forbidden = (msg = 'You do not have permission to do that') =>
  new AppError(403, 'forbidden', msg);
export const unauthorized = (msg = 'Sign in required') => new AppError(401, 'unauthorized', msg);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);
export const badRequest = (code: string, msg: string) => new AppError(400, code, msg);
export const unavailable = (code: string, msg: string) => new AppError(503, code, msg);
