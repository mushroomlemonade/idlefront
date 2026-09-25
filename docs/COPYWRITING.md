# IdleFront copy handoff

Customer-facing product prose is intentionally represented by literal copy
slots such as “Game subtitle”, “Page header”, and “Step instructions”. Replace
their values in `src/client/copy/PlaceholderCopy.ts`; do not scatter finished
marketing prose through components.

Keep the following text functional and accurate rather than rewriting it as
marketing copy:

- button labels, form labels, accessibility labels, and validation errors;
- live world, network, roster, countdown, and game status;
- OpenFront gameplay terminology used by the inherited simulation;
- generated player/world names and quick-chat phrases;
- copyright, source, license, attribution, warranty, and affiliation notices.

Legal copy is intentionally not stored in the placeholder module. In
particular, “© OpenFront and Contributors”, the independent-modification
disclosure, and the corresponding-source link must remain visible and true.
