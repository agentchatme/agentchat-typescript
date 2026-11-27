import { describe, expectTypeOf, it } from 'vitest'
import {
  AgentChatClient,
  type RecoverVerifyResult,
  type RegisterVerifyResult,
  type StaticCallOptions,
  type VerifyOptions,
} from '../src/index.js'
import type { ConnectorVerifyResult } from '../src/types/index.js'

// Type-level only (vitest typecheck): which result each way of calling
// verify / recoverVerify names. Nothing here runs.

describe('verify / recoverVerify overloads', () => {
  it('ReturnType names the ordinary result', () => {
    expectTypeOf<Awaited<ReturnType<typeof AgentChatClient.verify>>>().toEqualTypeOf<RegisterVerifyResult>()
    expectTypeOf<Awaited<ReturnType<typeof AgentChatClient.recoverVerify>>>().toEqualTypeOf<RecoverVerifyResult>()
  })

  it('no options, StaticCallOptions, and options typed any: the ordinary result', () => {
    const anyOptions = {} as any // eslint-disable-line @typescript-eslint/no-explicit-any
    const plain = {} as StaticCallOptions
    expectTypeOf(AgentChatClient.verify('p', '1')).resolves.toEqualTypeOf<RegisterVerifyResult>()
    expectTypeOf(AgentChatClient.verify('p', '1', plain)).resolves.toEqualTypeOf<RegisterVerifyResult>()
    expectTypeOf(AgentChatClient.verify('p', '1', { timeoutMs: 5 })).resolves.toEqualTypeOf<RegisterVerifyResult>()
    expectTypeOf(AgentChatClient.verify('p', '1', anyOptions)).resolves.toEqualTypeOf<RegisterVerifyResult>()
    expectTypeOf(AgentChatClient.recoverVerify('p', '1')).resolves.toEqualTypeOf<RecoverVerifyResult>()
    expectTypeOf(AgentChatClient.recoverVerify('p', '1', plain)).resolves.toEqualTypeOf<RecoverVerifyResult>()
    expectTypeOf(AgentChatClient.recoverVerify('p', '1', anyOptions)).resolves.toEqualTypeOf<RecoverVerifyResult>()
  })

  it("finish: 'connector', or VerifyOptions: the ordinary result or the connector result", () => {
    const options = {} as VerifyOptions
    expectTypeOf(AgentChatClient.verify('p', '1', { finish: 'connector' })).resolves.toEqualTypeOf<
      RegisterVerifyResult | ConnectorVerifyResult
    >()
    expectTypeOf(AgentChatClient.verify('p', '1', options)).resolves.toEqualTypeOf<
      RegisterVerifyResult | ConnectorVerifyResult
    >()
    expectTypeOf(AgentChatClient.recoverVerify('p', '1', { finish: 'connector' })).resolves.toEqualTypeOf<
      RecoverVerifyResult | ConnectorVerifyResult
    >()
    expectTypeOf(AgentChatClient.recoverVerify('p', '1', options)).resolves.toEqualTypeOf<
      RecoverVerifyResult | ConnectorVerifyResult
    >()
  })

  it("'connect' in result tells the two apart", () => {
    type Either = RegisterVerifyResult | ConnectorVerifyResult
    expectTypeOf<Extract<Either, { connect: unknown }>>().toEqualTypeOf<ConnectorVerifyResult>()
    expectTypeOf<Exclude<Either, { connect: unknown }>>().toEqualTypeOf<RegisterVerifyResult>()
  })
})
