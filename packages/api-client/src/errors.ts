import type { ProblemDetails } from '@botss/shared-types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly problem: ProblemDetails,
  ) {
    super(problem.title);
    this.name = 'ApiError';
  }
  get detail(): string | undefined {
    return this.problem.detail;
  }
  get fieldErrors(): Record<string, string[]> | undefined {
    return this.problem.errors;
  }
}

export class ValidationError extends ApiError {
  constructor(problem: ProblemDetails) {
    super(400, problem);
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends ApiError {
  constructor(problem: ProblemDetails) {
    super(401, problem);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends ApiError {
  constructor(problem: ProblemDetails) {
    super(403, problem);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends ApiError {
  constructor(problem: ProblemDetails) {
    super(404, problem);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends ApiError {
  constructor(problem: ProblemDetails) {
    super(409, problem);
    this.name = 'ConflictError';
  }
}

export function fromProblem(status: number, problem: ProblemDetails): ApiError {
  switch (status) {
    case 400:
      return new ValidationError(problem);
    case 401:
      return new UnauthorizedError(problem);
    case 403:
      return new ForbiddenError(problem);
    case 404:
      return new NotFoundError(problem);
    case 409:
      return new ConflictError(problem);
    default:
      return new ApiError(status, problem);
  }
}
