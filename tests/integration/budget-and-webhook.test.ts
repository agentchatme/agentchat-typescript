import { describe, expect, it } from 'vitest'
import { connectBudgetDelayMs, CONNECT_BUDGET_DEFAULT_DELAY_MS, CONNECT_BUDGET_MAX_DELAY_MS, CONNECT_BUDGET_MIN_DELAY_MS } from '../../src/connect-budget.js'
import { verifyWakeWebhook, WakeWebhookVerificationError } from '../../src/wake-webhook-verify.js'
import { json } from './fixtures.js'

// ─── conformance/v1/connect-budget.cases.json ───────────────────────────────

interface BudgetDoc {
  default_delay_ms: number
  min_delay_ms: number
  max_delay_ms: number
  cases: Array<{
    name: string
    event:
      | { kind: 'close'; code: number; reason: string }
      | { kind: 'upgrade'; status: number; retry_after: string | null; now?: string }
    expect: { delay_ms: number | null; blocked: boolean }
  }>
}

const budget = json<BudgetDoc>('connect-budget.cases.json')

describe('conformance — connect-budget.cases.json (delay rule)', () => {
  it('uses the bounds this SDK uses', () => {
    expect(budget.default_delay_ms).toBe(CONNECT_BUDGET_DEFAULT_DELAY_MS)
    expect(budget.min_delay_ms).toBe(CONNECT_BUDGET_MIN_DELAY_MS)
    expect(budget.max_delay_ms).toBe(CONNECT_BUDGET_MAX_DELAY_MS)
  })

  it.each(budget.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const event = c.event
    const delay =
      event.kind === 'close'
        ? connectBudgetDelayMs({ kind: 'close', code: event.code, reason: event.reason })
        : connectBudgetDelayMs({
            kind: 'upgrade',
            status: event.status,
            retryAfter: event.retry_after,
            ...(event.now ? { now: Date.parse(event.now) } : {}),
          })
    expect(delay).toBe(c.expect.delay_ms)
  })
})

// ─── conformance/v1/wake-webhook.cases.json ─────────────────────────────────

interface WebhookDoc {
  body: string
  payload: Record<string, unknown>
  secret: string
  standard_webhooks_secret: string
  now: number
  tolerance_s: number
  reasons: string[]
  cases: Array<{
    name: string
    dialect: 'agentchat' | 'hermes' | 'standard-webhooks'
    headers: Record<string, string>
    body?: string
    secret?: string
    expect: { ok: true } | { ok: false; reason: string }
  }>
}

const webhook = json<WebhookDoc>('wake-webhook.cases.json')

describe('conformance — wake-webhook.cases.json', () => {
  it('the body is the payload, and the payload is a v1 wake', () => {
    expect(JSON.parse(webhook.body)).toEqual(webhook.payload)
    expect(webhook.payload).toMatchObject({ type: 'agentchat.wake', version: 1 })
  })

  it.each(webhook.cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const secret = c.secret ?? (c.dialect === 'standard-webhooks' ? webhook.standard_webhooks_secret : webhook.secret)
    const run = () =>
      verifyWakeWebhook({
        dialect: c.dialect,
        body: c.body ?? webhook.body,
        headers: c.headers,
        secret,
        toleranceSeconds: webhook.tolerance_s,
        now: () => webhook.now * 1000,
      })
    if (c.expect.ok) {
      expect(await run()).toEqual(JSON.parse(c.body ?? webhook.body))
    } else {
      const error = await run().then(
        () => null,
        (err: unknown) => err,
      )
      expect(error).toBeInstanceOf(WakeWebhookVerificationError)
      expect((error as WakeWebhookVerificationError).reason).toBe(c.expect.reason)
      expect(webhook.reasons).toContain(c.expect.reason)
    }
  })

  it('takes a fetch Headers object and raw bytes', async () => {
    const c = webhook.cases.find((x) => x.name === 'hermes-signed')!
    const payload = await verifyWakeWebhook({
      dialect: 'hermes',
      body: new TextEncoder().encode(webhook.body),
      headers: new Headers(c.headers),
      secret: webhook.secret,
      now: () => webhook.now * 1000,
    })
    expect(payload.handle).toBe('@relay-bot')
  })

  it('never puts the secret in an error message', async () => {
    const error = (await verifyWakeWebhook({
      dialect: 'agentchat',
      body: webhook.body,
      headers: { authorization: 'Bearer wrong-secret-0123456789' },
      secret: webhook.secret,
    }).catch((err: unknown) => err)) as Error
    expect(error.message).not.toContain(webhook.secret)
    expect(error.message).not.toContain('wrong-secret')
  })
})
