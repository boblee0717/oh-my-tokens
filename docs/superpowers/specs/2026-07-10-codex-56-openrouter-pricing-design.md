# Codex 5.6 OpenRouter pricing

## Goal

Show an OpenRouter-list-price-based estimated cost for the Codex model that the
local session logs identify as `gpt-5.6-sol`, in both the Chrome extension and
the macOS SwiftBar menu bar.

## Design

The native host remains the single source of cost records. Add an exact-model
match ahead of the existing family fallbacks in `host/pricing.js`:

- `gpt-5.6-sol` and `gpt-5.6-sol-pro`: input $5, cache read $0.50, cache write
  $6.25, output $30 per million tokens.

The existing generic `gpt` and `codex` prices stay unchanged for historical and
unknown model names. `host/report.js` will continue to treat Codex's aggregate
cache token count as cache reads; the parser does not retain cache-write counts.
Its generated cost warning will identify the value as an OpenRouter list-price
estimate, rather than an assumed table.

No UI-specific pricing logic is added. Both viewers already render
`estimated_cost` records from the host report:

- the extension popup renders the model cost beside its token metrics;
- `menubar/format.mjs` incorporates the same record into the macOS headline and
  provider/model rows.

## Tests and local verification

Before implementation, add tests that prove exact 5.6 matching overrides the
generic GPT fallback, including the cache-read calculation and the `-pro`
variant. Add an integration-level report test that checks the generated Codex
cost record and its OpenRouter warning. Then run the host suite, extension
tests, menu-bar formatter tests, and a local host/report readback with a
synthetic 5.6 record. The formatter readback must contain the same dollar value
as the generated report.

## Non-goals

- Fetching prices at runtime or adding a network dependency.
- Repricing legacy GPT/Codex records.
- Representing cache writes in Codex totals when local log records do not
  preserve that distinction.
