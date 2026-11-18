/** Embedded shell IPC types. */
export interface ShellSessionInfo {
  sessionId: string
  prompt: string
  /** The read-only guard is active in this session. */
  readOnly: boolean
  /** An existing session for this tab (the tab was shown again). */
  resumed: boolean
}

export interface ShellEvalResult {
  ok: boolean
  /** ANSI-coloured text to print ('' for nothing). */
  output: string
  prompt: string
  /** Whether the read-only guard is active (it follows the connection's setting). */
  readOnly: boolean
}
