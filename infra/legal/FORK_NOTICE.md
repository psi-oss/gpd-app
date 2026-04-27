# Notice for downstream forks

The legal documents in this directory — `TOS-v1.0.md` (End User License
Agreement) and `PRIVACY-v1.0.md` (Privacy Policy) — are **PSI's
product-specific texts** approved by PSI's legal counsel for the
PSI-operated GPD product.

## Why you cannot reuse them verbatim

A downstream fork running its own GPD-derived product:

- Has a different legal entity (not Physical Superintelligence PBC).
- Operates under different brand and contact addresses.
- Likely collects different data through different infrastructure.
- Has different retention timelines, processors, and incident-response
  obligations.
- May be governed by different jurisdictions, with different statutory
  duties around consent, withdrawal, and data subject rights.

Reusing PSI's EULA + Privacy Policy as-is would either misrepresent your
product (the user "agreed" to terms that name PSI's entity and reference
PSI's infrastructure) or expose you to legal claims you weren't intending
to assume.

## What forks should do

Draft your own EULA + Privacy Policy with your own counsel. Mirror the
chain-of-custody pattern used here (release-time SHA verification,
audit-DB acceptance rows keyed on the SHA of the user-shipped text) but
substitute your text + your hashes.

PSI maintains these files in this repo because the PSI-published GPD
desktop builds reference them; the SHA constants in
`packages/app/src/components/tos-content.tsx` MUST byte-match the
markdown here, and the release CI guard at
`.github/workflows/gpd-release.yml` blocks any tag where they've
diverged.

## Why this notice lives in a separate file

The `.md` files above are referenced by SHA in production code and in
the audit-DB row written when a user accepts the TOS. Adding any
character to those `.md` files (including a comment line) changes their
SHA and invalidates the chain of custody. Maintainer-facing notes
therefore live HERE, not at the top of the legal text.
