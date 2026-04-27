/**
 * Format an agent identifier for display.
 *
 * Agents ship lowercase + hyphen-separated on disk (`gpd-roadmapper`,
 * `paper-writer`). Pure CSS `text-transform: capitalize` would render
 * them as `Gpd-Roadmapper` because WebKit/Blink treat hyphen-minus as
 * a word boundary, mangling GPD's three-letter acronym.
 *
 * This helper:
 *   - splits on `-`
 *   - upper-cases known acronym tokens (currently just `gpd`)
 *   - title-cases everything else
 *   - rejoins with `-`
 *
 * Examples:
 *   gpd-roadmapper        -> GPD-Roadmapper
 *   gpd-paper-writer      -> GPD-Paper-Writer
 *   plan                  -> Plan
 *   build-something-new   -> Build-Something-New
 *   GPD-roadmapper        -> GPD-Roadmapper  (idempotent on already-cased acronym)
 *   ""                    -> ""              (defensive — empty input)
 *
 * The acronym set is intentionally tiny. If we add more acronyms (PSI,
 * URL, etc.) extend ACRONYM_TOKENS, NOT the call sites. Keep set
 * lowercase since matching is done after .toLowerCase().
 */
const ACRONYM_TOKENS = new Set(["gpd"])

export function formatAgentTitle(name: string): string {
  if (!name) return name
  return name
    .split("-")
    .map((segment) => {
      if (!segment) return segment
      const lower = segment.toLowerCase()
      if (ACRONYM_TOKENS.has(lower)) return lower.toUpperCase()
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join("-")
}
