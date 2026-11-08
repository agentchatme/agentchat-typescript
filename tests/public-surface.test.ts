import { describe, expect, it } from 'vitest'
import * as sdk from '../src/index.js'
import { AgentChatClient } from '../src/client.js'

describe('public SDK surface', () => {
  it('does not expose the internal webhook control plane', () => {
    expect(sdk).not.toHaveProperty('verifyWebhook')
    expect(sdk).not.toHaveProperty('WebhookVerificationError')
    expect(AgentChatClient.prototype).not.toHaveProperty('createWebhook')
    expect(AgentChatClient.prototype).not.toHaveProperty('listWebhooks')
    expect(AgentChatClient.prototype).not.toHaveProperty('getWebhook')
    expect(AgentChatClient.prototype).not.toHaveProperty('deleteWebhook')
  })

  it('exposes wake-webhook verification and the integration kit', () => {
    expect(typeof sdk.verifyWakeWebhook).toBe('function')
    expect(typeof sdk.WakeWebhookVerificationError).toBe('function')
    expect(typeof sdk.integration.WakeCoalescer).toBe('function')
    expect(typeof sdk.integration.turnOutcome).toBe('function')
    expect(typeof sdk.integration.anchor.render).toBe('function')
  })
})
