export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = 'BAD_REQUEST'
  ) {
    super(message);
  }
}
export class ValidationError extends AppError {
  constructor(m: string) { super(m, 400, 'VALIDATION_ERROR'); }
}
export class UnauthorizedError extends AppError {
  constructor(m = 'Authentication is required.') { super(m, 401, 'UNAUTHORIZED'); }
}
export class ForbiddenError extends AppError {
  constructor(m = 'You do not have permission to perform this action.') { super(m, 403, 'FORBIDDEN'); }
}
export class NotFoundError extends AppError {
  constructor(m = 'The requested record could not be found.') { super(m, 404, 'NOT_FOUND'); }
}
export class ConflictError extends AppError {
  constructor(m: string) { super(m, 409, 'CONFLICT'); }
}
export class ServiceUnavailableError extends AppError {
  constructor(m: string) { super(m, 503, 'SERVICE_UNAVAILABLE'); }
}
