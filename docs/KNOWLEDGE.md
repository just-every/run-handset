# Knowledge source retrieval

The native owner API at `/api/handset/knowledge` provides a preparatory source
retrieval door. It does not answer calls or send source text to a model.

An owner can connect one Notion page, one Confluence Cloud page or one Google
Docs file per source. Reads use their public API schemas. Notion supports flat
text blocks only; nested blocks, pagination and unsupported blocks refuse the
whole source. Confluence supports plain storage markup, refusing macros and
embedded content. Google Docs uses the Drive text export. Notion and Drive
recheck the version after extraction to refuse a mixed snapshot. Credentials
are supplied for each connect or refresh, used only in authorization headers to
fixed API hosts, and never retained. Redirects are refused. Each response has an
eight-second deadline and a 128 KiB streamed limit. No links are crawled.

POST to the root with `provider`, `title`, `externalId`, `credential` and
`confirm: "authorize this source for owner retrieval"`. Confluence additionally
requires the selected `cloudId`. Alternatively use `provider: "upload"`,
`mediaType` and `content` for UTF-8 plain text or Markdown. Binary content,
unsupported formats, empty content, unsafe control characters and oversized
input are refused. Uploads use JSON text intake; this is not a browser file picker.

GET lists source references, local and upstream revisions, citation, state,
refresh time and expiry without document text or credentials. POST to
`/api/handset/knowledge/search` with `query` and an explicit `sourceIds` array
returns matching current source text and its citation. This is bounded literal
retrieval, not semantic search or an authoritative answer. Source text remains
untrusted data and cannot authorize tools. No model endpoint is connected.

POST to a source's `refresh`, `revoke` or `erase` subpath with its exact local
`revision`. Refresh repeats the original consent phrase and needs a fresh
credential, or replacement text for uploads. Revoke confirms `revoke this
source`; erase confirms `erase this source`. Neither can be undone by a stale
refresh. Failed refresh clears cached text and exposes an unavailable state.
Revocation and erasure clear local text and prevent later refresh. The audit
retains opaque references and actions, not document contents or credentials.
This is source-cache deletion, not installation-wide erasure.

Conservative default ADOPTED pending ct: only the active consenting native
owner can retrieve text; explicit source consent and the current owner version
are required, cached text expires after 15 minutes, and no model processing,
customer contact or external action is authorized. Other owners can inspect
source metadata and revoke or erase the source. Owner version changes require
a new source consent. HND-015 and HND-051 inherit current source permission at
retrieval and model release; HND-065 and HND-066 inherit source-cache retention,
archive exclusion or transformation and erasure obligations.

Remaining HND-043 work: Slate and Chest adapters using their actual supported
transport and authority, verified business website paths and protected crawl,
full format extraction and OCR, automatic upstream permission and freshness
invalidation, retention and installation erasure composition, human-owned
clarification for uncertain or conflicting sources, authorized receptionist
retrieval and cited call answers with actual model-request inspection, and the
complete owner source UI with its 1440 and 390 browser journeys. The current
15-minute cache does not promise immediate upstream revocation detection;
refresh or local revocation removes access sooner. No complete acceptance
journey or live voice qualification is claimed by this preparatory API.
