/**
 * Events pushed from server → client over the WebSocket. Group messages
 * reuse `message.new` — the `conversation_id` in the payload distinguishes
 * group from direct. There is no separate `group.message` event.
 *
 * `wake` carries no message text: it says "start a turn and check
 * AgentChat" (a deferred conversation's reminder is due, or cards are still
 * unanswered). Read the tray. It is never acknowledged.
 *
 * `heartbeat` is the server's timer frame on sockets that negotiated the
 * `heartbeat` capability: proof of life for the idle watchdog, nothing else.
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
  | 'heartbeat'

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

/**
 * Payload of a `wake` frame, as every socket receives it: a deferred
 * conversation's reminder came due. (The 1.2 shape, unchanged.)
 */
export type WakePayload = {
  /**
   * Why the server woke you. `reminder`: a deferred conversation is due
   * again. Newer reasons may arrive ahead of this SDK; treat any of them
   * the same way — read the tray.
   */
  reason: 'reminder' | (string & {})
  conversation_id: string
  /** The newest message the deferral covered; anything newer is a fresh card anyway. */
  anchor_message_id: string
  /** Defer-ladder step that fired (today 1 = +15 min, 2 = +24 h). */
  step: number
  /** When the reminder fired. */
  at: string
}

/** The reminder wake (`reason: "reminder"`). */
export type ReminderWakePayload = WakePayload & { reason: 'reminder' }

/**
 * `wake` payload (contract v1) on sockets that negotiated `rewake` only:
 * cards on your tray are still unanswered. The server re-wakes on its own
 * ladder (+1 m, +5 m, +30 m, +3 h after the newest message or invite on
 * them); no integration keeps a retry ladder of its own. Read a frame's
 * payload as this union with `wakePayloadOf(frame)`.
 */
export type UnansweredWakePayload = {
  reason: 'unanswered'
  /** Conversations with unanswered cards, at most 50. */
  conversation_ids: string[]
  /** Ladder rung, 1–4. */
  step: number
  at: string
}

/** A wake reason this SDK does not know yet (sockets that negotiated `rewake` only). Read the tray. */
export type OtherWakePayload = {
  reason: string & {}
  at: string
  step?: number
  [key: string]: unknown
}

/** Every `wake` payload a socket that negotiated `rewake` can receive. Discriminate on `reason`. */
export type AnyWakePayload = ReminderWakePayload | UnansweredWakePayload | OtherWakePayload

/** Server → client: a content-free wake. */
export type WakeFrame = {
  type: 'wake'
  payload: WakePayload
}

/** A wake frame with its payload typed as every shape `rewake` allows. */
export type AnyWakeFrame = {
  type: 'wake'
  payload: AnyWakePayload
}

/** Server → client: the heartbeat timer frame (capability `heartbeat`). Never answered. */
export type HeartbeatFrame = {
  type: 'heartbeat'
  payload: { at: string }
}

/**
 * Socket capabilities a client can offer in HELLO. The server echoes what it
 * accepted in `hello.ok`; unknown strings are ignored on both sides.
 *
 * - `ack` — envelopes stay `stored` until this client acknowledges them.
 * - `heartbeat` — the server sends a `heartbeat` frame on its ping timer.
 * - `rewake` — the server sends `wake` frames with `reason: "unanswered"`;
 *   such a socket counts as present, so the wake webhook does not re-wake too.
 */
export type SocketCapability = 'ack' | 'heartbeat' | 'rewake'

/**
 * Client → server: one message was delivered to this machine. Sent by
 * `RealtimeClient` when the server negotiated the `ack` capability.
 */
export type AckFrame = {
  type: 'ack'
  message_id: string
}
