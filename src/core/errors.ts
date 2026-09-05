import { ZodError } from 'zod';

import type { AppErrorCode, PublicAppError } from './types.js';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(code: AppErrorCode, message: string, fieldErrors?: Record<string, string[]>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.fieldErrors = fieldErrors;
  }

  get publicError(): PublicAppError {
    return {
      code: this.code,
      message: this.message,
      ...(this.fieldErrors ? { fieldErrors: this.fieldErrors } : {}),
    };
  }
}

export function validationError(error: ZodError): AppError {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = issue.path.join('.') || '_';
    (fieldErrors[field] ??= []).push(issue.message);
  }
  return new AppError('VALIDATION_ERROR', 'Invalid input', fieldErrors);
}
