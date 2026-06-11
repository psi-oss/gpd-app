// Pure /goal flag parsing — kept free of UI/context imports so it can be
// unit-tested directly (submit.ts pulls in solid router + app contexts).

// Parse durations like "30m", "2h", "1h30m", "120s", "1h30m45s"
export function parseDuration(raw: string): number | undefined {
  const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/)
  if (!match || (!match[1] && !match[2] && !match[3])) return undefined
  const h = match[1] ? parseInt(match[1], 10) : 0
  const m = match[2] ? parseInt(match[2], 10) : 0
  const s = match[3] ? parseInt(match[3], 10) : 0
  return h * 3600 + m * 60 + s
}

export type GoalFlags = { timeBudgetSeconds?: number; costBudgetUSD?: number }

// Extract --budget=$X / --time=Yh flags from anywhere in the objective text
// (leading, trailing, or interior). Returns the cleaned objective + parsed
// flags. Throws on malformed flag values.
export function parseGoalFlags(arg: string): { cleanArg: string; flags: GoalFlags } {
  const flags: GoalFlags = {}
  // Anchor on either start-of-string or whitespace so a flag that's the
  // first argument right after `/goal ` parses, not just one buried later
  // (e.g. `/goal --budget=$1.00 reproduce X` used to leave `--budget=$1.00`
  // glued to the objective and the cost budget unparsed).
  // Accept em-dash (—) and en-dash (–) as flag prefixes too: macOS smart-dash
  // substitution rewrites a typed `--` into `—` inside the WKWebView prompt
  // input, so `—budget=$50 —time=30m` arrived as objective text and neither
  // budget registered (field report 2026-06-11).
  const flagPattern = /(?:^|\s+)(?:--|[—–])(budget|time)=(\S+)/g
  // Extract values first by iterating matches on the ORIGINAL arg. The
  // strip step runs as a single independent pass below so partial
  // whitespace-normalization between iterations can't leave a later flag
  // unstripped (the previous loop edited cleanArg incrementally and the
  // \s+ prefix from match[0] disappeared after the first replace).
  for (const match of arg.matchAll(flagPattern)) {
    const [, key, raw] = match
    if (key === "budget") {
      const numeric = raw.replace(/^\$/, "")
      // parseFloat alone truncates partially-numeric values ("$1abc" → 1),
      // silently accepting garbage AND stripping it from the objective —
      // require the whole token to be a number.
      const usd = /^\d+(\.\d+)?$/.test(numeric) ? parseFloat(numeric) : NaN
      if (!Number.isFinite(usd) || usd <= 0) {
        throw new Error(`Invalid --budget=${raw}; expected $<positive number>`)
      }
      flags.costBudgetUSD = usd
    } else if (key === "time") {
      const seconds = parseDuration(raw)
      if (seconds === undefined || seconds <= 0) {
        throw new Error(`Invalid --time=${raw}; expected e.g. 30m, 2h, 1h30m, 120s`)
      }
      flags.timeBudgetSeconds = seconds
    }
  }
  const cleanArg = arg
    .replace(/(?:^|\s+)(?:--|[—–])(?:budget|time)=\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return { cleanArg, flags }
}
