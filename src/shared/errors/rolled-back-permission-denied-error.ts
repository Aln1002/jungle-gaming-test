export class RolledBackPermissionDeniedError extends Error {
  constructor(cause: unknown) {
    super('Database permission denied and transaction rolled back', { cause });
  }
}