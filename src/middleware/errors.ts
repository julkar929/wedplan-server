import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'API endpoint not found.', code: 'NOT_FOUND' });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues[0]?.message || 'Invalid request payload.', code: 'VALIDATION_ERROR' });
    return;
  }
  if (err?.code === 11000) {
    res.status(409).json({ error: 'This record already exists.', code: 'CONFLICT' });
    return;
  }
  const status = err?.status || err?.statusCode;
  if (status === 413) {
    res.status(413).json({ error: 'Request body is too large.', code: 'PAYLOAD_TOO_LARGE' });
    return;
  }
  if (status === 400 && err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Malformed JSON request body.', code: 'BAD_REQUEST' });
    return;
  }
  console.error('[API Error]', err);
  res.status(500).json({ error: 'An unexpected server error occurred. Please try again.', code: 'INTERNAL' });
}
