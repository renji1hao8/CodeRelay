export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function httpError(status: number, message: string): HttpError {
  return new HttpError(status, message);
}
