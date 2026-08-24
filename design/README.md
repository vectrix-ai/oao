# OAO design references

These standalone HTML artifacts are used to review and iterate on the product
design before approved decisions are implemented in the console.

- [`style-guide.html`](./style-guide.html) documents the **current** design
  system: the August 2026 neo-brutalist rebrand (white ground, ink hardware,
  red/yellow/blue with fixed jobs, Space Grotesk / Inter / Space Mono, zero
  radius, hard offset shadows). It defines two volumes: the full-strength
  **poster tier** for marketing surfaces, and the subtler **product tier**
  (1–1.5px borders, 2px shadows, 1px presses) that the console uses so the
  app stays easy on the eyes. Its tokens are kept in sync with the reference
  implementation in `vectrix-ai/oao-landing-page` (`src/styles/global.css`);
  the landing repo's `ConsoleSession.astro` is the design target for the
  console's session view (rendered there at poster weight — build it at
  product weight in the console).
- [`design.html`](./design.html) is the interactive component-system prototype
  from the **old green system**. It is outdated and carries a banner saying
  so — use it only as an inventory of which components and screens exist,
  never as a visual reference, until it is rebuilt in the new system.
- [`style-guide-assets/`](./style-guide-assets/) contains the local logo
  assets used by both documents.

The files in this directory are design references. They are not bundled into
the production console.
