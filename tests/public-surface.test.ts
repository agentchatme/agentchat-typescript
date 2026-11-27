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

  it('exposes the identity block\'s strict reading and its follow', () => {
    expect(typeof sdk.integration.anchor.owner).toBe('function')
    expect(typeof sdk.integration.anchor.decide).toBe('function')
    expect(typeof sdk.integration.anchor.follow).toBe('function')
    expect(sdk.integration.anchor.FOLLOW_ATTEMPTS).toBe(3)
    expect(sdk.integration.anchor.EARLIER_IDENTITY_LINES).toHaveLength(3)
    // The file mechanics stay internal: the kit's public file helpers are unchanged.
    expect(sdk.integration).not.toHaveProperty('replaceIfUnchanged')
    expect(sdk.integration).not.toHaveProperty('readForReplace')
  })

  it('exposes the wake check beside the wake webhook, and its error codes', () => {
    const client = new AgentChatClient({ apiKey: 'k', fetch: (() => Promise.reject(new Error('unused'))) as typeof fetch })
    expect(typeof client.wakeCheck.set).toBe('function')
    expect(typeof client.wakeCheck.clear).toBe('function')
    expect(sdk.ErrorCode.WAKE_DESTINATION_EXISTS).toBe('WAKE_DESTINATION_EXISTS')
    expect(sdk.ErrorCode.WAKE_CHECK_UNAVAILABLE).toBe('WAKE_CHECK_UNAVAILABLE')
  })

  it('exposes connections, connector sign-in and its error codes', () => {
    const client = new AgentChatClient({ apiKey: 'k', fetch: (() => Promise.reject(new Error('unused'))) as typeof fetch })
    expect(typeof client.connections.end).toBe('function')
    expect(typeof sdk.ConnectorSignupError).toBe('function')
    expect(new sdk.ConnectorSignupError(
      {
        handle: 'my-agent',
        connect: {
          mcp_url: 'https://api.agentchat.test/mcp/connector/acg_x',
          resource: 'https://api.agentchat.test/mcp/connector/acg_x',
          issuer: 'https://api.agentchat.test',
          authorization_endpoint: 'https://api.agentchat.test/oauth/authorize',
          token_endpoint: 'https://api.agentchat.test/oauth/token',
          registration_endpoint: 'https://api.agentchat.test/oauth/register',
          scope: 'agentchat',
          expires_at: '2026-11-17T10:04:00.000Z',
        },
        message: 'x',
      },
      201,
    )).toBeInstanceOf(sdk.AgentChatError)
    expect(sdk.ErrorCode.CONNECTION_NOT_FOUND).toBe('CONNECTION_NOT_FOUND')
    expect(sdk.ErrorCode.CONNECTOR_SIGN_IN_UNAVAILABLE).toBe('CONNECTOR_SIGN_IN_UNAVAILABLE')
  })

  it('no longer exposes the connector sign-up status call or FINISH_ON_PAGE (gone from the server)', () => {
    expect(AgentChatClient).not.toHaveProperty('registerStatus')
    expect(sdk.ErrorCode).not.toHaveProperty('FINISH_ON_PAGE')
  })
})
