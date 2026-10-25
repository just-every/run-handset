# Knowledge source retrieval

The native owner API at `/api/handset/knowledge` provides a preparatory source
retrieval door. Retrieval does not answer calls or send source text to a model.
Separate processing requires the HND-100 consent door below.

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
untrusted data and cannot authorize tools. Retrieval connects no model endpoint.

POST to a source's `refresh`, `revoke` or `erase` subpath with its exact local
`revision`. Refresh repeats the original consent phrase and needs a fresh
credential, or replacement text for uploads. Revoke confirms `revoke this
source`; erase confirms `erase this source`. Neither can be undone by a stale
refresh. Failed refresh clears cached text and exposes an unavailable state.
Revocation and erasure clear local text and prevent later refresh. The audit
retains opaque references and actions, not document contents or credentials.
This is source-cache deletion, not installation-wide erasure.

Interim source-access policy APPROVED (ct 25 Oct 14:15Z): only the active consenting native
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

Cache text is unavailable at the exact 15-minute retrieval boundary. Every
knowledge request clears expired text before reading; the existing minute
scheduler also clears it without a retrieval request. A delayed scheduled event
uses the current clock. Native owner version, role and status changes remove
text immediately in the same database operation. Source metadata and opaque
audit remain; retention cleanup never extends consent or creates a model grant.

## Explicit model-processing consent

HND-100 adds a separate native owner API under
`/api/handset/knowledge/processing`. It supports `summary` and
`spanish-translation` purposes. Retrieval and search still grant no processing,
customer contact, tool or external-action authority. Source instructions remain
untrusted data. HND-015 and HND-051 still require their own receptionist and
agent-assist qualification.

POST to its `consents` subpath with `sourceId`, the current local `revision`,
`purpose` and `confirm: "consent to model processing for this source and purpose"`.
Only the source's consenting owner at that current native version may consent.
A consent selects one exact source revision and purpose; it cannot authorize a
different source, another purpose or a later replacement. Other native owners
remain metadata-only and can withdraw consent.

POST to `runs` with `consentId` and the exact `purpose` to queue work without
sending text. POST an empty object to a run's `execute` subpath to execute it
once. Both operations require current source consent, current native owner
version and unexpired retrieval. Execution rechecks after admission and before
releasing buffered output. A response names its source ID, title, citation,
local and upstream revision and purpose. GET at the processing root lists
consents and runs; output is visible only to the current consenting owner.

Processing uses the existing production AI client, with explicit `AI_ENABLED`,
`AI_MODEL` and either direct provider configuration (`AI_API_KEY`, optional
`AI_BASE_URL`) or the separately configured Models service. Credentials remain
server bindings. The official-schema edge tests send one non-streaming chat
completion with `store: false`, no tools, the exact selected source and a fixed
purpose instruction. Responses have an eight-second request deadline, a
128 KiB bound and a bounded text result. Provider errors and malformed,
truncated or tool-bearing responses produce no output. There is no retry or
fallback; an interrupted running request remains uncertain and cannot execute
again. No paid live provider proof or speech qualification is claimed.

POST to a consent's `withdraw` subpath with
`confirm: "withdraw model processing consent"`. Withdrawal refuses queued and
future runs and clears every dependent stored output in the same transaction.
An already dispatched provider request cannot be recalled; its late response
cannot restore or release erased output. Source refresh, revocation, erasure,
cache expiry and native owner authority changes also withdraw dependent
consents and clear results atomically. Restart never revives them. Opaque
consent and run history survives; the audit retains no source text, output or
credentials. This is local derived-output erasure, not a provider-side deletion
receipt or complete installation erasure. HND-065 and HND-066 retain their
archive, retention and installation erasure obligations for these records.

Acceptance proof in `tests/handset-records.mjs`:

- “Model processing requires exact source and purpose consent and releases only
  source-labelled output under current owner authority” proves consent refusal,
  exact request and label, current authority and honest provider failure.
- “Processing withdrawal and native version changes erase derived output and
  fence queued and in-flight work through restart” proves withdrawal, source
  replacement and revocation, owner-version refusal, output erasure and restart.

The clause adds no screen; the existing source, capture, receptionist and
installation-custody UI obligations remain with their owning clauses.
