/**
 * dsh-dcp's producer-owned message source kinds.
 *
 * dsh 0.1.7 removed the shared `kind: 'plugin'` catch-all: MessageSourceMap is
 * now merge-extensible and every producer declares its own `kind` in its own
 * module (see `MessageSourceMap` in @deepseek-ai/dsh-llm/message and the
 * bundled `webhook` producer for the canonical shape). Session-log V4 admission
 * refuses retired `'plugin'` wrappers, so the declarations below are what lets
 * dsh-dcp's transcript rows persist.
 *
 * Legacy rows: session-format V3→V4 migrates unknown third-party plugin names
 * to `plugin:<name>` kinds, so pre-migration dsh-dcp notice rows replay as
 * `plugin:dsh-dcp` — lib/summarizer.js skips both spellings.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** dsh-dcp transcript row: a one-line compaction/model-switch account. */
    'dsh-dcp': {
      readonly kind: 'dsh-dcp'
      readonly form: 'notice'
      /** The bounded one-line account, via `boundContextSummary`. */
      readonly summary: string
    }
  }
}

/** Module marker: keeps the block above an augmentation (merging), not an ambient module declaration (shadowing). */
export {}
