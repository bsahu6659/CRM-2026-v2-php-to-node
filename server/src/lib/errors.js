/**
 * Application errors carry an HTTP status and a machine-readable code, so the
 * single error-handling middleware can turn any of them into the same
 * { error: { code, message } } envelope the client already understands.
 *
 * Anything that is NOT an AppError is a bug, and is deliberately reported as a
 * generic 500 so a stack trace never reaches the browser.
 */
export class AppError extends Error {
  constructor(status, errorCode, message, details = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.errorCode = errorCode;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message = 'Bad request', details = null) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const validationError = (details, message = 'Validation failed') =>
  new AppError(422, 'VALIDATION_ERROR', message, details);

export const unauthenticated = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHENTICATED', message);

export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Resource not found') =>
  new AppError(404, 'NOT_FOUND', message);

export const conflict = (message = 'Conflict', details = null) =>
  new AppError(409, 'CONFLICT', message, details);

export const tooMany = (message = 'Too many requests') =>
  new AppError(429, 'RATE_LIMITED', message);

export const serverError = (message = 'Something went wrong. Please try again.') =>
  new AppError(500, 'INTERNAL_ERROR', message);
