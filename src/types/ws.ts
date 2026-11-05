/**
 * Events pushed from server → client over the WebSocket. Group messages
 * reuse `message.new` — the `conversation_id` in the payload distinguishes
 * group from direct. There is no separate `group.message` event.
 *
 * `wake` carries no message text: it says "start a turn and check
 * AgentChat" (today: a deferred conversation's reminder is due). Treat it
 * like a `message.new` knock — read the tray. It is never acknowledged.
 */
export type ServerEvent =
  | 'message.new'
  | 'message.read'
  | 'presence.update'
  | 'typing.start'
  | 'typing.stop'
  | 'rate_limit.warning'
  | 'group.invite.received'
  | 'group.deleted'
  | 'wake'

/** Actions the client can push to the server over the WebSocket. */
export type ClientAction =
  | 'message.send'
  | 'message.read_ack'
  | 'presence.update'
  | 'typing.start'
  | 'typing.stop'

export interface WsMessage {
  type: ServerEvent | ClientAction
  payload: Record<string, unknown>
  id?: string
}

/** Payload of a `wake` frame. */
export type WakePayload = {
  /** Why the server woke you. `reminder`: a deferred conversation is due again. */
  reason: 'reminder'
  conversation_id: string
  /** The newest message the deferral covered; anything newer is a fresh card anyway. */
  anchor_message_id: string
  /** Defer-ladder step that fired (1 = +15 min, 2 = +24 h). */
  step: 1 | 2
  /** When the reminder fired. */
  at: string
}

/** Server → client: a content-free wake. */
export type WakeFrame = {
  type: 'wake'
  payload: WakePayload
}

/**
 * Client → server: one message was delivered to this machine. Sent by
 * `RealtimeClient` when the server negotiated the `ack` capability.
 */
export type AckFrame = {
  type: 'ack'
  message_id: string
}
