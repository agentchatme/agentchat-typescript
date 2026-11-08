import { describe, expect, it } from 'vitest'
import { connectBudgetDelayMs, CONNECT_BUDGET_MAX_DELAY_MS, CONNECT_BUDGET_MIN_DELAY_MS } from '../../src/connect-budget.js'
import { verifyWakeWebhook, WakeWebhookVerificationError } from '../../src/wake-webhook-verify.js'
import { createHmac } from 'node:crypto'
import type { WakeWebhookPayload } from '../../src/types/index.js'
import { json } from './fixtures.js'

// ─── conformance/v1/connect-budget.cases.json ───────────────────────────────

interface BudgetDoc {
  min_delay_ms: number
  max_delay_ms: number
  rules: Record<string, string>
  cases: Array<{
    name: string
    event: { kind: 'close'; code: number; reason: string }
    expect: { delay_ms: number | null; blocked: boolean }
  }>
}

const budget = json<BudgetDoc>('connect-budget.cases.json')

describe('conformance — connect-budget.cases.json (delay rule)', () => {
  it('uses the bounds this SDK uses; every case is a close', () => {
    expect(budget.min_delay_ms).toBe(CONNECT_BUDGET_MIN_DELAY_MS)
    expect(budget.max_delay_ms).toBe(CONNECT_BUDGET_MAX_DELAY_MS)
    expect(Object.keys(budget.rules).sort()).toEqual(['bounds', 'close_1013', 'jitter', 'state'])
    for (const c of budget.cases) expect(c.event.kind).toBe('close')
  })

  it.each(budget.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(connectBudgetDelayMs({ code: c.event.code, reason: c.event.reason })).toBe(c.expect.delay_ms)
  })
})

// ─── conformance/v1/wake-webhook.cases.json ─────────────────────────────────

interface WebhookDoc {
  body: string
  payload: Record<string, unknown>
  secret: string
  standard_webhooks_secret_base64: string
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
// Built at run time: no secret-shaped literal is committed (secret scanners read `whsec_…` as a live key).
const standardWebhooksSecret = ['whsec', webhook.standard_webhooks_secret_base64].join('_')

describe('conformance — wake-webhook.cases.json', () => {
  it('the body is the payload, and the payload is a v1 wake', () => {
    expect(JSON.parse(webhook.body)).toEqual(webhook.payload)
    expect(webhook.payload).toMatchObject({ type: 'agentchat.wake', version: 1 })
  })

  it.each(webhook.cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const secret = c.secret ?? (c.dialect === 'standard-webhooks' ? standardWebhooksSecret : webhook.secret)
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

  it('accepts the whsec_ form of a standard-webhooks secret (its base64 body is the key)', async () => {
    const c = webhook.cases.find((x) => x.name === 'standard-webhooks-signed')!
    expect(standardWebhooksSecret.startsWith('whsec_')).toBe(true)
    await expect(
      verifyWakeWebhook({
        dialect: 'standard-webhooks',
        body: webhook.body,
        headers: c.headers,
        secret: standardWebhooksSecret,
        now: () => webhook.now * 1000,
      }),
    ).resolves.toMatchObject({ type: 'agentchat.wake' })
    // The same base64 text used raw (no whsec_ prefix) is a different key.
    await expect(
      verifyWakeWebhook({
        dialect: 'standard-webhooks',
        body: webhook.body,
        headers: c.headers,
        secret: webhook.standard_webhooks_secret_base64,
        now: () => webhook.now * 1000,
      }),
    ).rejects.toMatchObject({ reason: 'bad_signature' })
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
    expect(payload.handle).toBe('@example-relay')
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

// ─── conformance/v1/wake-webhook-payload.v1.json ────────────────────────────

const payloads = json<{ version: number; payloads: Record<string, WakeWebhookPayload> }>('wake-webhook-payload.v1.json')

describe('conformance — wake-webhook-payload.v1.json', () => {
  it('one v1 payload per reason; step only on unanswered', () => {
    expect(Object.keys(payloads.payloads).sort()).toEqual(['invite', 'messages', 'reminder', 'test', 'unanswered'])
    for (const [reason, payload] of Object.entries(payloads.payloads)) {
      expect(payload).toMatchObject({ type: 'agentchat.wake', version: 1, reason })
      expect('step' in payload).toBe(reason === 'unanswered')
    }
  })

  it.each(Object.entries(payloads.payloads))('%s: verifies in every receiver dialect with reason and step present', async (_reason, payload) => {
    const body = JSON.stringify(payload)
    const now = Math.floor(Date.parse('2026-11-08T09:00:05.000Z') / 1000)
    const swKey = Buffer.from(webhook.standard_webhooks_secret_base64, 'base64')
    const id = `${payload.delivery_id}:1`
    const cases: Array<[Parameters<typeof verifyWakeWebhook>[0]['dialect'], Record<string, string>, string]> = [
      ['agentchat', { authorization: `Bearer ${webhook.secret}` }, webhook.secret],
      [
        'hermes',
        {
          'x-webhook-timestamp': String(now),
          'x-webhook-signature-v2': createHmac('sha256', webhook.secret).update(`${now}.${body}`).digest('hex'),
        },
        webhook.secret,
      ],
      [
        'standard-webhooks',
        {
          'webhook-id': id,
          'webhook-timestamp': String(now),
          'webhook-signature': `v1,${createHmac('sha256', swKey).update(`${id}.${now}.${body}`).digest('base64')}`,
        },
        standardWebhooksSecret,
      ],
    ]
    for (const [dialect, headers, secret] of cases) {
      const verified = await verifyWakeWebhook({ dialect, body, headers, secret, now: () => now * 1000 })
      expect(verified).toEqual(payload)
    }
  })
})
