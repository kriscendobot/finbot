# references/

Read-only shelves of roles and skills imported from other gardens or harnesses. The liaison browses this directory when a user prompt has no obvious fit in finbot's active library; if a referenced role or skill fits, the liaison proposes adoption (translate the file into finbot's `roles/` or `skills/`, rename, commit on `main`).

References are not auto-loaded by subagents. Only the liaison reads them, and only on demand.

## Bootstrap state

The bootstrap state of this directory is empty. Candidate shelves to import:

- `references/garden/`: a snapshot of [kriskowal/garden](https://github.com/kriskowal/garden)'s roles and skills. Finbot pattern-borrowed from the garden, so many of its roles (fixer, weaver, shepherd, conductor, designer, scout, etc.) may apply when finbot starts building real software components.
- `references/endo/`: a snapshot of relevant Endo packages' documentation (especially the CapTP, Exo, pass-style, patterns, eventual-send, ses, compartment-mapper, daemon READMEs). The cap-attenuation design already cites these directly; a local snapshot would be a hedge against upstream changes.
- `references/ymax/`: a snapshot of relevant Agoric portfolio-contract / ymax-planner / portfolio-api files. The ymax-integration design already cites these; a local snapshot would similarly hedge.

Importing a shelf:

1. The liaison decides which subset of an external repo to mirror.
2. A scout-shaped dispatch clones the subset into `references/<source>/`.
3. The shelf is read-only; finbot's own evolution does not modify it.
