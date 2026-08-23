import { describe, it, expect } from 'vitest'
import {
  AgentChatError,
  BlockedError,
  EmailExhaustedError,
  EmailLimitReachedError,
  ForbiddenError,
  GroupDeletedError,
  HandleRequiredError,
  NotFoundError,
  RateLimitedError,
  RecipientBackloggedError,
  RestrictedError,
  ServerError,
  SuspendedError,
  UnauthorizedError,
  ValidationError,
  createAgentChatError,
} from '../src/errors.js'

describe('createAgentChatError', () => {
  it('maps RATE_LIMITED with header to RateLimitedError', () => {
    const headers = new Headers({ 'Retry-After': '12' })
    const err = createAgentChatError({ code: 'RATE_LIMITED', message: 'slow' }, 429, headers)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect((err as RateLimitedError).retryAfterMs).toBe(12_000)
  })

  it('falls back to body.retry_after_ms when no header', () => {
    const err = createAgentChatError(
      { code: 'RATE_LIMITED', message: 'slow', details: { retry_after_ms: 4500 } },
      429,
    )
    expect((err as RateLimitedError).retryAfterMs).toBe(4500)
  })

  it('maps SUSPENDED, AGENT_SUSPENDED → SuspendedError', () => {
    expect(createAgentChatError({ code: 'SUSPENDED', message: 'x' }, 403))
      .toBeInstanceOf(SuspendedError)
    expect(createAgentChatError({ code: 'AGENT_SUSPENDED', message: 'x' }, 403))
      .toBeInstanceOf(SuspendedError)
  })

  it('maps RESTRICTED → RestrictedError', () => {
    expect(createAgentChatError({ code: 'RESTRICTED', message: 'x' }, 403))
      .toBeInstanceOf(RestrictedError)
  })

  it('extracts backlog details on RECIPIENT_BACKLOGGED', () => {
    const err = createAgentChatError(
      {
        code: 'RECIPIENT_BACKLOGGED',
        message: 'full',
        details: { recipient_handle: 'alice', undelivered_count: 9800 },
      },
      429,
    )
    expect(err).toBeInstanceOf(RecipientBackloggedError)
    expect((err as RecipientBackloggedError).recipientHandle).toBe('alice')
    expect((err as RecipientBackloggedError).undeliveredCount).toBe(9800)
  })

  it('maps BLOCKED → BlockedError', () => {
    expect(createAgentChatError({ code: 'BLOCKED', message: 'x' }, 403))
      .toBeInstanceOf(BlockedError)
  })

  it('maps VALIDATION_ERROR → ValidationError', () => {
    expect(createAgentChatError({ code: 'VALIDATION_ERROR', message: 'bad' }, 400))
      .toBeInstanceOf(ValidationError)
  })

  it('maps UNAUTHORIZED, INVALID_API_KEY → UnauthorizedError', () => {
    expect(createAgentChatError({ code: 'UNAUTHORIZED', message: 'x' }, 401))
      .toBeInstanceOf(UnauthorizedError)
    expect(createAgentChatError({ code: 'INVALID_API_KEY', message: 'x' }, 401))
      .toBeInstanceOf(UnauthorizedError)
  })

  it('maps FORBIDDEN and AGENT_PAUSED_BY_OWNER → ForbiddenError', () => {
    expect(createAgentChatError({ code: 'FORBIDDEN', message: 'x' }, 403))
      .toBeInstanceOf(ForbiddenError)
    expect(createAgentChatError({ code: 'AGENT_PAUSED_BY_OWNER', message: 'x' }, 403))
      .toBeInstanceOf(ForbiddenError)
  })

  it('maps *_NOT_FOUND codes → NotFoundError', () => {
    for (const code of ['AGENT_NOT_FOUND', 'CONVERSATION_NOT_FOUND', 'MESSAGE_NOT_FOUND']) {
      expect(createAgentChatError({ code, message: 'x' }, 404))
        .toBeInstanceOf(NotFoundError)
    }
  })

  it('extracts DeletedGroupInfo on GROUP_DELETED', () => {
    const err = createAgentChatError(
      {
        code: 'GROUP_DELETED',
        message: 'gone',
        details: {
          group_id: 'grp_1',
          deleted_by_handle: 'alice',
          deleted_at: '2026-01-01T00:00:00Z',
        },
      },
      410,
    )
    expect(err).toBeInstanceOf(GroupDeletedError)
    expect((err as GroupDeletedError).groupId).toBe('grp_1')
    expect((err as GroupDeletedError).deletedByHandle).toBe('alice')
    expect((err as GroupDeletedError).deletedAt).toBe('2026-01-01T00:00:00Z')
  })

  it('extracts the live-agent cap on EMAIL_LIMIT_REACHED', () => {
    const err = createAgentChatError(
      {
        code: 'EMAIL_LIMIT_REACHED',
        message: 'This email already backs 10 active agents.',
        details: { limit: 10 },
      },
      409,
    )
    expect(err).toBeInstanceOf(EmailLimitReachedError)
    expect(err.code).toBe('EMAIL_LIMIT_REACHED')
    expect(err.status).toBe(409)
    expect((err as EmailLimitReachedError).limit).toBe(10)
  })

  it('maps legacy EMAIL_TAKEN → EmailLimitReachedError with limit null', () => {
    // Pre-policy servers reject the second live agent on an email with
    // EMAIL_TAKEN and no details: same class, and `limit` is null so the
    // caller quotes the server message instead of a number.
    const err = createAgentChatError({ code: 'EMAIL_TAKEN', message: 'taken' }, 409)
    expect(err).toBeInstanceOf(EmailLimitReachedError)
    expect(err.code).toBe('EMAIL_TAKEN')
    expect((err as EmailLimitReachedError).limit).toBeNull()
    expect(err.message).toBe('taken')
  })

  it('extracts the lifetime cap on EMAIL_EXHAUSTED', () => {
    const err = createAgentChatError(
      {
        code: 'EMAIL_EXHAUSTED',
        message: 'This email has reached the maximum of 30 account registrations.',
        details: { limit: 30 },
      },
      409,
    )
    expect(err).toBeInstanceOf(EmailExhaustedError)
    expect(err).not.toBeInstanceOf(EmailLimitReachedError)
    expect((err as EmailExhaustedError).limit).toBe(30)
  })

  it('treats a malformed details.limit as absent', () => {
    for (const limit of ['10', 10.5, true, null, undefined]) {
      const reached = createAgentChatError(
        { code: 'EMAIL_LIMIT_REACHED', message: 'x', details: { limit } },
        409,
      ) as EmailLimitReachedError
      const exhausted = createAgentChatError(
        { code: 'EMAIL_EXHAUSTED', message: 'x', details: { limit } },
        409,
      ) as EmailExhaustedError
      expect(reached.limit).toBeNull()
      expect(exhausted.limit).toBeNull()
    }
  })

  it('extracts the sibling handles on HANDLE_REQUIRED', () => {
    const err = createAgentChatError(
      {
        code: 'HANDLE_REQUIRED',
        message: 'This email backs more than one agent.',
        details: { handles: ['alpha-bot', 'beta-bot', 42, null] },
      },
      409,
    )
    expect(err).toBeInstanceOf(HandleRequiredError)
    expect(err.code).toBe('HANDLE_REQUIRED')
    expect(err.status).toBe(409)
    // Server order (created_at ASC) preserved; non-string entries dropped.
    expect((err as HandleRequiredError).handles).toEqual(['alpha-bot', 'beta-bot'])
  })

  it('HANDLE_REQUIRED without usable details has empty handles', () => {
    const noDetails = createAgentChatError({ code: 'HANDLE_REQUIRED', message: 'x' }, 409)
    expect((noDetails as HandleRequiredError).handles).toEqual([])
    const notArray = createAgentChatError(
      { code: 'HANDLE_REQUIRED', message: 'x', details: { handles: 'alpha-bot' } },
      409,
    )
    expect((notArray as HandleRequiredError).handles).toEqual([])
  })

  it('maps INTERNAL_ERROR → ServerError', () => {
    expect(createAgentChatError({ code: 'INTERNAL_ERROR', message: 'x' }, 500))
      .toBeInstanceOf(ServerError)
  })

  it('falls back by status code when the error code is unknown', () => {
    expect(createAgentChatError({ code: 'UNKNOWN_X', message: 'x' }, 401))
      .toBeInstanceOf(UnauthorizedError)
    expect(createAgentChatError({ code: 'UNKNOWN_X', message: 'x' }, 404))
      .toBeInstanceOf(NotFoundError)
    expect(createAgentChatError({ code: 'UNKNOWN_X', message: 'x' }, 500))
      .toBeInstanceOf(ServerError)
    expect(createAgentChatError({ code: 'UNKNOWN_X', message: 'x' }, 418))
      .toBeInstanceOf(AgentChatError) // catchall, not a specific subclass
  })

  it('every specific subclass is still an AgentChatError (for generic catches)', () => {
    const err = createAgentChatError({ code: 'SUSPENDED', message: 'x' }, 403)
    expect(err).toBeInstanceOf(AgentChatError)
    expect(err.code).toBe('SUSPENDED')
    expect(err.status).toBe(403)
  })
})
