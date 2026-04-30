// File-preview markdown commonly carries custom XML-like containers
// (e.g. GPD plan files use <objective> / <task> / <verify> / <done>).
// Marked passes those through as raw HTML; DOMPurify (USE_PROFILES.html)
// then strips the unknown wrappers and concatenates their children's
// text, smushing nested structure into one wall-of-text paragraph.
// Pre-escaping `<tag>` to `&lt;tag&gt;` for tags outside the standard
// HTML / MathML allowlist makes the markup render as visible literal
// text while keeping marked's paragraph + line-break handling intact.
//
// Important: only escape OUTSIDE fenced and inline code so legitimate
// code samples that contain "<task>" still render as code.

const STANDARD_TAGS = new Set([
  // HTML5
  "a","abbr","address","area","article","aside","audio","b","bdi","bdo",
  "blockquote","body","br","button","canvas","caption","cite","code","col",
  "colgroup","data","datalist","dd","del","details","dfn","dialog","div","dl",
  "dt","em","embed","fieldset","figcaption","figure","footer","form","h1","h2",
  "h3","h4","h5","h6","head","header","hgroup","hr","html","i","iframe","img",
  "input","ins","kbd","label","legend","li","main","map","mark","menu","meta",
  "meter","nav","noscript","object","ol","optgroup","option","output","p",
  "param","picture","pre","progress","q","rb","rp","rt","rtc","ruby","s",
  "samp","script","section","select","slot","small","source","span","strong",
  "style","sub","summary","sup","svg","table","tbody","td","template",
  "textarea","tfoot","th","thead","time","title","tr","track","u","ul","var",
  "video","wbr",
  // MathML — DOMPurify keeps these because USE_PROFILES.mathMl is on.
  "math","mrow","mi","mo","mn","ms","mtext","mfrac","msup","msub","msubsup",
  "mover","munder","munderover","msqrt","mroot","mtable","mtr","mtd","mspace",
  "mfenced","semantics","annotation","annotation-xml",
])

// Splits the input into alternating non-code / code chunks. Odd indices
// are code (preserved verbatim); even indices are everything else and
// get the unknown-tag escape pass.
const CODE_SEGMENT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g

const TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g

function escapeOutsideCode(segment: string): string {
  return segment.replace(TAG, (match, name: string) => {
    if (STANDARD_TAGS.has(name.toLowerCase())) return match
    return match.replace(/</g, "&lt;").replace(/>/g, "&gt;")
  })
}

export function escapeUnknownTags(text: string): string {
  if (!text) return text
  const parts = text.split(CODE_SEGMENT)
  return parts
    .map((part, index) => (index % 2 === 1 ? part : escapeOutsideCode(part)))
    .join("")
}
