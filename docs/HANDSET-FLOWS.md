# Native call-flow versions

HND-006 remains partial. Current native owners open **Queues → Call-flow settings**
at `/app/flows`. Build connected steps, configure hours and a timezone, choose
an existing sales queue and add dated holidays. Save creates an immutable draft.
The visual editor exposes step destinations, retained versions and native tests.
Every control has a visible text label.

The same current-owner API is `/api/handset/flows`. Definitions include name,
entry, IANA timezone, dated overrides and nodes. Node kinds are hours, menu,
queue, receptionist and end. Queue nodes name existing native queues. Cycles,
missing destinations, duplicate branches, unreachable nodes, empty branches and
unsupported emergency fields are refused before saving. A changed definition
always creates a new version; it cannot change an existing publication.

Test every native branch before exact-version approval. These graph traversals
are not audible or official carrier test calls. Publication and rollback require
`confirm: approve this exact tested flow version` and the current publication
revision. A named current owner is recorded atomically. Stale publication and
rollback are refused. Rollback retains both definitions and attributable history.
Neither publication nor rollback changes existing queue calls.

POST an explicit ISO timestamp with offset as `instant` to a version's `evaluate`
child. Hours nodes optionally define `hours.weekly` windows with ISO weekdays
(1 Monday through 7 Sunday), `startMinute` inclusive and `endMinute` exclusive.
Hours destinations are open first and closed second. Overnight hours use two
windows. Dated overrides select their entry before weekly hours using the flow's
local calendar date. IANA timezone evaluation handles repeated and skipped DST
hours from the explicit instant. Legacy versions without hours metadata remain
intact and refuse evaluation when an unconfigured hours node is visited.

Menus require explicit `choices` mapping node IDs to one of their destinations.
Queue nodes may configure `group` with `strategy` and ordered `members`.
Simultaneous selects all eligible members, sequential previews the first eligible
member, round robin rotates from the supplied cursor, and longest idle selects
the earliest supplied idle time. `groups` maps each queue node to complete member
eligibility, optional idle timestamps and an explicit round-robin cursor. The
result explains the path, local date, override and selected members. Caller
supplied eligibility is scenario input, never staffing or carrier authority.
The evaluator is a pure calculation and makes no live routing or outbound call.

The approved preparatory boundary grants no prompt, number assignment, carrier,
outbound or live-routing authority. HND-027 retains broader scoped flow
administration and greeting-only separation; HND-047 retains live-flow audit.

Remaining work includes caller-ID rules, complete live scheduling and US-holiday
calendars, speech and DTMF, live group progression, overflow and failover, number
assignments, qualified test calls, active-call version binding and safe transfer,
HND-087 prompt creation and pinned versions, and extension dialing under personal
rules. Record-by-phone and audible qualification require authorized carrier and
controlled receiving endpoints. This run uses no carrier key.
