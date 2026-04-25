export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND', 404);
  }
}

export class InvalidStateError extends AppError {
  constructor(message: string) {
    super(message, 'INVALID_STATE', 422);
  }
}

export class ExternalServiceError extends AppError {
  constructor(service: string, cause: string) {
    super(`${service} error: ${cause}`, 'EXTERNAL_SERVICE_ERROR', 502);
  }
}
