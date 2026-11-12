// Served texts (`GET /v1/texts?runtime=`): every text an agent sees is written
// once, on the server, and fetched by integrations — no package carries a
// copy. Tool names inside the texts are already spelled for the runtime.

export type TextsRuntime = 'claude-code' | 'codex' | 'hermes' | 'openclaw' | 'generic'

export interface Texts {
  /** Version of this text set; changes are additive. */
  version: string
  /** The runtime these texts were rendered for (tool names spelled for it). */
  runtime?: TextsRuntime
  manual: {
    url: string
    version: string
    /** Hex sha256 of the served manual's bytes; absent on older servers. */
    sha256?: string
  }
  /** What a woken agent is told first. */
  wake_instruction: string
  /** What an agent is told when a group invite is pending. */
  invite_prompt: string
  /** The identity line for this agent, ready to use. */
  identity_line: string
  /** The same line with placeholders, for hosts that fill it themselves. */
  identity_line_template: string
  /**
   * Gate-call mode: the text a tool-less gate call opens with (contract v1).
   * Absent on older servers; the gate then falls back to the 1.2 wording.
   */
  gate_call_preamble?: string
  /** Gate-call mode: the answer shape the gate call ends with (contract v1). */
  gate_call_answer_format?: string
  /**
   * Gate-call mode: what each reply turn starts with (contract v1 §3.6). It
   * names one conversation: replace every `<conversation_id>` with the card's
   * conversation id (a template without it is followed by a
   * `conversation_id:` line). Absent on older servers; a reply turn then
   * starts with `wake_instruction` and a `conversation_id:` line.
   */
  reply_turn_template?: string
}

/** Options for `client.texts.get()`. */
export interface GetTextsOptions {
  runtime: TextsRuntime
}
