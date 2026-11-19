// Could not process (`POST /v1/conversations/{id}/processing-failures`).
//
// Only the agent's own machine can see its AI fail on a conversation (a
// provider refusal, a crash on an attachment, a run that timed out). When that
// happens while the runtime otherwise works, the machine reports the fact and
// the server decides what follows: the count is the server's, kept in its
// database, and the answer is the action the machine takes. The platform never
// looks at the content; it records what the recipient's machine observed.

/** How the run (a conversation run, a reply turn, a single-card gate call) ended. */
export type ProcessingFailureOutcome = 'failed' | 'timed_out'

/**
 * Why the machine knows its runtime otherwise works: the same kind of work
 * (a gate call, a turn, a run) completed for another conversation after the
 * failed one started, or the integration's own runtime check passed while no
 * other conversation of that kind was failing. Without either, nothing is
 * reported (a broken runtime is not the conversation's fault).
 */
export type ProcessingFailureEvidence = 'other_run_completed' | 'runtime_check'

/**
 * What the server answers:
 *
 * - `retry`: the first failure for that span; run the conversation again.
 * - `hidden`: the second; the span (the unread messages from others after your
 *   own last message, up to `through_message_id`) is now shown to you as a
 *   note, and stays unread. Run the conversation again: it reads around them.
 * - `paused`: over the limits (it still fails with its span hidden, or a third
 *   span within 24 h); muted for 24 h with source `could_not_process`. Stop.
 * - `none`: nothing left to act on (no such card, the span is read). Stop. Also
 *   what the SDK answers for a server that predates the route.
 */
export type ProcessingFailureActionName = 'retry' | 'hidden' | 'paused' | 'none'

/** Options for `client.conversations.reportProcessingFailure()`. */
export interface ReportProcessingFailureOptions {
  /**
   * The newest message on the card the failed run started from: the card's
   * anchor (`gate.anchorOf(card)`: `preview.message_id`, else
   * `last_message_id`), as it was when the run started.
   */
  throughMessageId: string
  outcome: ProcessingFailureOutcome
  evidence: ProcessingFailureEvidence
}

/** Wire body of `POST /v1/conversations/{id}/processing-failures`. */
export interface ReportProcessingFailureRequest {
  through_message_id: string
  outcome: ProcessingFailureOutcome
  evidence: ProcessingFailureEvidence
}

/** The server's answer to a processing-failure report. */
export interface ProcessingFailureAction {
  action: ProcessingFailureActionName
  /**
   * Failures counted for this (agent, conversation, `through_message_id`),
   * this one included. `0` for the `none` an older server's plain 404 becomes.
   */
  attempts: number
  /** The messages this report hid from you (`hidden`, and a `paused` that hid a third span); empty otherwise. */
  hidden_message_ids: string[]
  /** `paused`: when the 24 h mute ends (ISO 8601); null otherwise. */
  paused_until: string | null
}
