"""Inject a cleaned Privacy Policy from /tmp/privacy.txt (or any path) into
both authoritative locations:

  1. ``infra/legal/PRIVACY-v<version>.md`` — the lawyer-blessed source. The
     desktop release CI (``gpd-release.yml`` tos-guard step) hashes this
     file and aborts the build if it diverges from the SHA constant in
     tos-content.tsx, so they MUST land together.
  2. ``packages/app/src/components/tos-content.tsx`` — replaces the
     ``PRIVACY_TEXT`` template literal AND the ``PRIVACY_TEXT_SHA256``
     constant in lockstep so every desktop POST to ``/gpd/tos-accept``
     carries a hash that matches the text the user saw.

Why a script (vs. hand-editing the .md and the .tsx separately):
  * SHA256 has to be recomputed AFTER template-literal escaping (the same
    string that lives between backticks in tos-content.tsx). Doing this by
    hand is the #1 way the constants drift out of sync with the markdown.
  * The tsx is line-prefixed by a CI regex (``[^\\`]+``); the source must
    not contain bare backticks. Easy to forget when pasting from a Word
    doc; the script aborts cleanly instead of producing an unparseable
    .tsx.

Usage:
    python3 scripts/inject-privacy-text.py <version> [<source-path>]

    # Default reads /tmp/privacy.txt; explicit override OK:
    python3 scripts/inject-privacy-text.py 1.0
    python3 scripts/inject-privacy-text.py 1.0 /path/to/draft.txt

Behaviour:
    * Cleans curly quotes (U+2018/U+2019/U+201C/U+201D), em/en dashes
      (U+2013/U+2014), non-breaking spaces (U+00A0), zero-width chars
      (U+200B/U+200C/U+200D/U+FEFF) → ASCII equivalents. Word-doc paste
      hygiene; the desktop SHA chain is sensitive to invisible bytes.
    * Strips trailing whitespace per line; collapses ≥3 consecutive
      blank lines down to 2 (markdown paragraph break).
    * Refuses to run if the cleaned text contains a bare backtick — the
      CI regex in scripts/check-tos-hashes.py uses ``[^\\`]+`` and would
      truncate the literal at the first backtick.

Mirrors inject-tos-text.py's update-pattern; intentionally ONLY touches
PRIVACY_* constants so it can run independently of TOS edits.
"""
from __future__ import annotations

import hashlib
import pathlib
import re
import sys


REPO = pathlib.Path(__file__).resolve().parent.parent
TSX = REPO / "packages/app/src/components/tos-content.tsx"
DEFAULT_SOURCE = pathlib.Path("/tmp/privacy.txt")


# Smart quotes + typographic chars routinely arrive in pasted-from-Word
# drafts. Normalising them keeps the SHA chain stable (a stray U+2019
# changes the hash) and avoids rendering surprises in the desktop modal
# (which runs through a webview that mostly handles them but occasionally
# does not, depending on the system font fallback).
_REPLACEMENTS = {
    "‘": "'",   # left single quote
    "’": "'",   # right single quote / apostrophe
    "‚": "'",   # single low-9 quote
    "‛": "'",   # single high-reversed-9 quote
    "“": '"',   # left double quote
    "”": '"',   # right double quote
    "„": '"',   # double low-9 quote
    "–": "-",   # en dash
    "—": "--",  # em dash
    " ": " ",   # non-breaking space
    " ": " ",   # thin space
    "​": "",    # zero-width space
    "‌": "",    # zero-width non-joiner
    "‍": "",    # zero-width joiner
    "﻿": "",    # BOM / zero-width no-break space
    "…": "...", # horizontal ellipsis
}


def clean(raw: str) -> str:
    """Normalise unicode oddities + collapse extra blank lines."""
    out = raw
    for src, dst in _REPLACEMENTS.items():
        out = out.replace(src, dst)
    # Per-line right-trim. Avoid touching leading whitespace; some
    # legal docs use indentation as a list-marker substitute.
    lines = [line.rstrip() for line in out.splitlines()]
    out = "\n".join(lines)
    # Collapse ≥3 consecutive blank lines down to a single paragraph
    # break (2 newlines → 1 blank line). Keeps the .md compact without
    # accidentally joining real paragraphs.
    out = re.sub(r"\n{3,}", "\n\n", out)
    # Strip leading blank lines; ensure exactly one trailing newline.
    out = out.lstrip("\n").rstrip() + "\n"
    return out


def escape_for_template_literal(raw: str) -> str:
    # Order matters: backslash first so subsequent escapes don't double-up.
    return raw.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")


def main(argv: list[str]) -> int:
    if len(argv) not in (2, 3):
        print(f"usage: {argv[0]} <version> [<source-path>]", file=sys.stderr)
        return 2
    version = argv[1]
    source = pathlib.Path(argv[2]) if len(argv) == 3 else DEFAULT_SOURCE

    if not source.exists():
        print(f"ERROR: source {source} not found", file=sys.stderr)
        return 2

    raw = source.read_text(encoding="utf-8")
    cleaned = clean(raw)

    if "`" in cleaned:
        print(
            "ERROR: cleaned text contains a backtick. CI regex in "
            "scripts/check-tos-hashes.py uses [^`]+ and will stop at the "
            "first backtick. Remove it from the source before re-running.",
            file=sys.stderr,
        )
        return 1

    # 1. Write canonical markdown source. Same versioned filename pattern
    #    as TOS-v<version>.md so tos-guard's pair lookup finds both.
    md_path = REPO / f"infra/legal/PRIVACY-v{version}.md"
    md_path.write_text(cleaned, encoding="utf-8")
    print(f"wrote {md_path.relative_to(REPO)} ({len(cleaned)} chars, {cleaned.count(chr(10))} lines)")

    # 2. Compute SHA256 of the template-literal-escaped form. This MUST
    #    match what scripts/check-tos-hashes.py recomputes from the .md
    #    by escaping the same way (see check-tos-hashes.py for the
    #    canonical algorithm).
    escaped = escape_for_template_literal(cleaned)
    sha256 = hashlib.sha256(escaped.encode("utf-8")).hexdigest()

    # 3. Replace PRIVACY_TEXT template literal in the tsx. The regex
    #    picks the first ``export const PRIVACY_TEXT = ` ... ` `` block.
    #    DOTALL so the literal can span lines.
    src = TSX.read_text(encoding="utf-8")
    privacy_pattern = re.compile(
        r"export const PRIVACY_TEXT = `[^`]*`",
        flags=re.DOTALL,
    )
    new_privacy_literal = f"export const PRIVACY_TEXT = `{escaped}`"
    if not privacy_pattern.search(src):
        print("ERROR: PRIVACY_TEXT template literal not found in tos-content.tsx", file=sys.stderr)
        return 1
    src = privacy_pattern.sub(new_privacy_literal, src, count=1)

    # 4. Update PRIVACY_TEXT_SHA256. Two-line declaration in the source
    #    so the regex tolerates the optional newline between `=` and the
    #    string (prettier wraps at 100 cols).
    sha_pattern = re.compile(
        r'export const PRIVACY_TEXT_SHA256 =\s*\n?\s*"[0-9a-f]{64}"'
    )
    new_sha_literal = f'export const PRIVACY_TEXT_SHA256 =\n  "{sha256}"'
    if not sha_pattern.search(src):
        print("ERROR: PRIVACY_TEXT_SHA256 declaration not found", file=sys.stderr)
        return 1
    src = sha_pattern.sub(new_sha_literal, src, count=1)

    TSX.write_text(src, encoding="utf-8")

    print(f"updated {TSX.relative_to(REPO)}")
    print(f"  PRIVACY version       = {version} (filename only — no constant in tsx)")
    print(f"  PRIVACY_TEXT_SHA256   = {sha256}")
    print()
    print(
        "next steps:\n"
        "  python3 scripts/check-tos-hashes.py    # verify both .md/.tsx pairs hash-match\n"
        "  bun turbo typecheck                     # ensure tsx still compiles\n"
        "  git diff infra/legal/PRIVACY-v" + version + ".md packages/app/src/components/tos-content.tsx"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
