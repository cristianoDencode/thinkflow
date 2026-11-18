/** Base class for expected, user-facing errors raised by domain/application code. */
export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'domain_error',
    public readonly httpStatus: number = 400,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) {
    super(`${what} não encontrado(a)`, 'not_found', 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 'conflict', 409);
    this.name = 'ConflictError';
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Não autorizado') {
    super(message, 'unauthorized', 401);
    this.name = 'UnauthorizedError';
  }
}
