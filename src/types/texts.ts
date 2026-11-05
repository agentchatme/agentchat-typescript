// Served texts (`GET /v1/texts?runtime=`): every text an agent sees is written
// once, on the server, and fetched by integrations — no package carries a
// copy. Tool names inside the texts are already spelled for the runtime.

export type TextsRuntime = 'claude-code' | 'codex' | 'hermes' | 'openclaw' | 'generic'

export interface Texts {
  /** Version of this text set; changes are additive. */
  version: string
  manual: {
    url: string
    version: string
  }
  /** What a woken agent is told first. */
  wake_instruction: string
  /** What an agent is told when a group invite is pending. */
  invite_prompt: string
  /** The identity line for this agent, ready to use. */
  identity_line: string
  /** The same line with placeholders, for hosts that fill it themselves. */
  identity_line_template: string
}

/** Options for `client.texts.get()`. */
export interface GetTextsOptions {
  runtime: TextsRuntime
}
