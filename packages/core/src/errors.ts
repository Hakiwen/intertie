// Error codes and their HTTP statuses (spec/core.md §8).

export const ERROR_STATUS = {
  bad_request: 400,
  invalid_event: 400,
  bad_signature: 401,
  stale_signature: 401,
  replayed: 401,
  unknown_key: 401,
  bad_digest: 401,
  not_participant: 403,
  not_home: 403,
  bad_origin: 403,
  not_author: 403,
  unknown_channel: 404,
  invalid_invite: 404,
  not_found: 404,
  channel_closed: 409,
  id_conflict: 409,
  too_large: 413,
  rate_limited: 429,
  internal: 500,
  unreachable: 502,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class IntertieError extends Error {
  readonly code: ErrorCode | string;
  readonly status: number;
  constructor(code: ErrorCode | string, message?: string, status?: number) {
    super(message ?? code);
    this.code = code;
    this.status = status ?? (ERROR_STATUS as Record<string, number>)[code] ?? 500;
  }
  toJSON(): { error: { code: string; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}
