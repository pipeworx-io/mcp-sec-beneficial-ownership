# @pipeworx/sec-beneficial-ownership

SEC Schedule 13D / 13G beneficial-ownership filings — who holds 5%+ of a public
company's stock, how (sole vs. shared voting/dispositive power), and — for
13D — why (Item 4 "Purpose of Transaction", the activist-investor signal).
Parses the structured XML SEC has required since its 2024 rule, and falls back
honestly (`structured: false`) on older plain-text filings instead of
returning nothing.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1721+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `sec_13d_filings(ticker_or_cik, form_type?, limit?)` — list an issuer's
  Schedule 13D/13G filings (and amendments), newest first. Each row flags
  whether it is structured XML or pre-2024 plain text.
- `sec_13d_filing(ticker_or_cik, accession_number)` — parse one filing: every
  reporting owner with percent of class, sole/shared voting power, sole/shared
  dispositive power, aggregate shares owned; for 13D, also Item 4's purpose
  text. Falls back to bounded plain text for pre-rule filings.
- `sec_13d_amendment_diff(ticker_or_cik, accession_number)` — given one 13D/A
  or 13G/A, find the same reporting group's prior filing in the chain and diff
  ownership %, voting/dispositive power (per owner), and (13D) whether the
  Item 4 purpose text changed.

## Auth

Keyless. SEC EDGAR is free, public, and requires no API key — only a
descriptive `User-Agent`, which this pack sends on every request per SEC's
developer guidelines.

## Data sources

- `https://data.sec.gov/submissions/CIK##########.json` — per-issuer filing
  index (form type, accession number, filing date, primary document name).
  Shared pattern with `mcps/edgar`.
- `https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/primary_doc.xml` —
  the filing's structured XML, for filings on or after SEC's 2024
  structured-data rule (`SCHEDULE 13D` / `SCHEDULE 13G` form types).
- `https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/{primary_document}` —
  the filing's plain HTML/text document, for pre-rule filings (`SC 13D` /
  `SC 13G` form types).
- `https://www.sec.gov/files/company_tickers.json` — ticker/company-name to
  CIK resolution, via the shared `resolveSecEntity` helper (also used by
  `mcps/edgar`) — one resolver for every SEC-keyed pack rather than a second
  implementation here.

### Traps worth knowing

- **The submissions index's `primaryDocument` field for a structured filing is
  a VIEWER path, not the raw document.** It reads like
  `xslSCHEDULE_13D_X01/primary_doc.xml` — fetching that exact URL returns
  rendered HTML (an XSLT transform applied server-side for browsers), not
  machine-readable XML, even though the filename ends in `.xml`. The actual
  structured XML always sits at `primary_doc.xml` directly in the accession's
  archive root, one directory up, regardless of which XSLT stylesheet variant
  (`X01`, `X02`, …) the viewer path names. This pack always fetches the root
  path for structured filings; `mcps/sec-form-d` relies on the same
  convention for Form D.
- **`SC 13D`/`SC 13G` (pre-rule, plain text) vs. `SCHEDULE 13D`/`SCHEDULE 13G`
  (post-rule, structured XML) are the SAME form, different eras.** SEC's
  2024 structured-data rule changed the submission type string, not just the
  document format. Filter logic in this pack normalizes both to one family
  (`13D` / `13G`) so a caller filtering by form type gets every era.
- **`previousAccessionNumber` (when present) points to the ORIGINAL filing in
  the amendment chain, not the immediately preceding amendment.** Confirmed
  live: three successive amendments by the same reporting group all carried
  the identical `previousAccessionNumber` (the 2024 original). It also is not
  universal — a later XSD revision (`X0202`, seen from at least one large
  institutional filer) omits it entirely. `sec_13d_amendment_diff` treats it
  as one signal of chain membership alongside reporting-owner-identity
  overlap, not as a direct pointer to "the prior filing."
- **A 13D/A or 13G/A only restates the Items that changed.** An amendment's
  `items1To7` (13D) or `items` (13G) block may simply omit `item2`, `item4`,
  etc. if that item's content is unchanged from the prior filing — this is
  not a parsing failure, it is how SEC's schema allows amendments to be
  filed. `sec_13d_filing` and `sec_13d_amendment_diff` return `null` for an
  absent item rather than inventing content.
- **Schedule 13G has no "purpose" field.** 13D's Item 4 is "Purpose of
  Transaction" (free text); 13G's Item 4 is "Ownership" (amount/percent/voting
  power, already covered by `reporting_owners`). `item4_purpose` is only ever
  populated for 13D; for 13G it is `null` with a `note` explaining why.
- **SEC egress is shared fleet-wide across every SEC/EDGAR pack (one outbound
  IP).** Every tool here reads a bounded, specific set of filings — never a
  bulk crawl of an issuer's history. `sec_13d_amendment_diff`'s backward scan
  for the prior filing is capped (`MAX_CHAIN_SCAN = 6` filing fetches).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "sec-beneficial-ownership": {
      "url": "https://gateway.pipeworx.io/sec-beneficial-ownership/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/sec-beneficial-ownership/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1721+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/sec_13d_filings \
  -H 'Content-Type: application/json' \
  -d '{"ticker_or_cik":"IMXI","form_type":"all","limit":10}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/sec_13d_filings`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "sec-beneficial-ownership": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-sec-beneficial-ownership"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-sec-beneficial-ownership
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Sec Beneficial Ownership data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
