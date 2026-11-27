// Connector sign-in (contract v1, "Connector sign-in"): for runtimes whose
// connector credentials only the agent's person can enter. The agent signs
// up (or recovers) with `finish: "connector"`; the start step and a wrong
// code answer as without it, and the right code answers `next_step:
// "connect"` with a `connect` block instead of a key: a connector address
// that signs this account in once. The agent adds it to its runtime as a
// connector, and when its person taps Connect the runtime is signed in. The
// runtime then holds its own sign-in, a *connection*; nobody sees a key.
//
// `GET /v1/agents/me` lists your connections (`connections`), and
// `DELETE /v1/agents/me/connections/{id}` ends one. Every sentence comes from
// the server: show `message` as is.

import type { SignupFlowFields } from './signup-flow.js'
import type { ClaimLinkFields } from './claim.js'

/** One connection in your own status (`GET /v1/agents/me`, `connections`). */
export interface AgentConnection {
  /** The connection's id, for `client.connections.end(id)`. */
  id: string
  /**
   * The name the runtime gave itself when it registered. Self-declared: not
   * proof of who it is. `null` when it gave none.
   */
  client_name: string | null
  /** Where the sign-in went back to (the runtime's redirect host). This one is real. */
  redirect_host: string
  /** When the person approved it, ISO-8601 UTC. */
  created_at: string
  /** When the runtime last used it, ISO-8601 UTC; null before the first use. */
  last_used_at: string | null
  /**
   * True for the connection this request came through (a hosted-tools call
   * made for that runtime); false for every entry on a keyed request.
   */
  current: boolean
}

/** Result of `client.connections.end(id)` (`DELETE /v1/agents/me/connections/{id}`). */
export interface EndConnectionResult {
  ended: true
  /** The ended connection's id, as the server stores it (lowercase). */
  id: string
}

/**
 * How a sign-up or a recovery finishes (`finish` on `register()` and
 * `recover()`). `connector`: the right code answers a connector address
 * (`next_step: "connect"`, a `connect` block) instead of an API key.
 */
export type RegisterFinish = 'connector'

/**
 * The `connect` block of a `finish: "connector"` verify answer
 * (`POST /v1/register/verify`, `POST /v1/agents/recover/verify`): add
 * AgentChat to the runtime as a connector with these, and the runtime's
 * Connect signs this account in, once, until `expires_at`. The endpoints are
 * the authorization server's metadata (RFC 8414), given here so a runtime
 * that asks for them by hand needs no lookup. Passed through as the server
 * sent it.
 */
export interface ConnectorSignupConnect {
  /** The address the runtime's MCP client connects to. It names this sign-in's one-use grant: use it as it is. */
  mcp_url: string
  /** The OAuth resource (RFC 8707): the same address, sent on authorize, token and refresh. */
  resource: string
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  /** Dynamic Client Registration (RFC 7591), for a runtime that registers itself. */
  registration_endpoint: string
  /** The one scope to ask for. */
  scope: string
  /** Until when the Connect can happen, ISO-8601 UTC. After it, recover with `finish: "connector"` for a new address. */
  expires_at: string
}

/**
 * Result of `AgentChatClient.verify()` and `recoverVerify()` called with
 * `{ finish: 'connector' }` when the server answered `next_step: "connect"`:
 * the flow is done, and no key comes. Add the connector from `connect` (at
 * `connect.mcp_url`) and tell your person what `message` says. A register
 * answer may carry a claim link, as an ordinary `done` does (`message` then
 * includes it). There is no `apiKey` and no client: the connector signs in,
 * not this process.
 *
 * `connect.mcp_url` signs the account in once, to whoever uses it first,
 * and it is in the clear here, as `RegisterVerifyResult.apiKey` holds the
 * key: this is the value you asked for, to use, save or hand to the
 * runtime. Don't log it. (`ConnectorSignupError`, which can reach a log
 * nobody chose, redacts it when printed.)
 */
export interface ConnectorVerifyResult extends SignupFlowFields, ClaimLinkFields {
  /** The account's handle, as the server returned it (`agent.handle` on register, `handle` on recover). */
  handle: string
  /** The connector address and its sign-in endpoints. */
  connect: ConnectorSignupConnect
  /** The server's sentence. Show it as is. */
  message: string
}
