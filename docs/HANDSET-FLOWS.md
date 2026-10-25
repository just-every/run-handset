# Native call-flow versions

HND-006 is partial. The owner-only native API at `/api/handset/flows` stores
immutable definitions and separate publication pointers. It does not route calls,
record prompts, synthesize speech or make a carrier request.

POST a `definition` with a name, entry node, IANA timezone, dated overrides and
nodes. Nodes have an ID, kind and explicit next destinations. Supported kinds
are hours, menu, queue, receptionist and end. A queue node names an existing
native queue. Menu and hours nodes need at least two branches; terminal nodes
have none. Unknown fields, unsupported emergency routing, cycles, missing
destinations, duplicate destinations and unreachable nodes are refused. Dated
overrides identify local calendar dates and existing entries; they are stored,
not yet evaluated as real DST-aware routing schedules.

A revision supplies `flowId` and `previousVersionId` from the latest version.
Stale drafts are refused. Existing versions never change their definition.
POST a complete node-ID `path` to the version's `test` child. Every edge must
appear in a complete path before the version becomes tested. These are native
graph traversals, never audible or official carrier test calls.

POST `revision` and `confirm: approve this exact tested flow version` to the
version's `publish` child. The named current owner is recorded atomically with
the exact tested version; the previous publication becomes retired. The same
confirmation and current publication revision on a retired version's `rollback`
child restores it in one request, preserving both definitions and audit history.
This only changes native configuration. Existing queue calls are not changed;
active-call flow-version binding and safe transfer remain unimplemented.

Conservative default ADOPTED pending ct: only current native owners author,
read, test or approve this preparatory configuration; no carrier, prompt, number
assignment or outbound effect is authorized. HND-027 inherits broader scoped
administration and HND-047 inherits live-flow audit composition.

Remaining HND-006 work includes the visual builder, complete scheduling and
routing predicates, speech and DTMF menus, group strategies, number assignments,
qualified test calls, live version binding and safe rollback, HND-087 prompt
creation and pinned versions, and extension dialing under personal rules.
Record-by-phone and audible carrier qualification require authorized carrier
and receiving endpoints, which this task does not hold. No new account is used.
