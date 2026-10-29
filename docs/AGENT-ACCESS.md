# Agent access

Handset currently offers scoped application case reads, unpublished comment
drafts and preparation of reviewed work at `/api/handset/application` and
`/api/handset/v1`. The existing MCP endpoint is
`/api/handset/application/mcp`. Its seven tools are `case.read`, `comment.draft`,
`call.paid`, `message.send`, `campaign.launch`, `number.release` and
`flow.publish`. Preparing work does not establish a provider effect. Paid,
attestation, recording and live-flow work retains its existing native gates.

The shared Base agent runtime is copied at `src/modules/agent-door`, with
its immutable origin in `base-copies.json`. Copying it and applying its schema
does not activate `/mcp`, `/agents` or the signed agent-policy receiver. A
company agent must not treat the target registry in CONTRACT.md as currently
available. No shared-door specialist journey is declared yet.

Signed Business settings at `/api/rer/business-settings` can bind Business
person IDs to existing native operators. The receiver uses `RER_BUSINESS_TRUST`
and the native account invitation and reconciliation service. It stores the
Business display name; existing app branding is not connected to that value.
An unconfigured installation does not accept settings. The
Business owner binds to the native setup owner; a managed Business admin maps
to native admin, and a member maps to native member. Established bindings use
operator IDs across email changes. Conflicting existing accounts are not
adopted. Native person status and admission remain authoritative.

The native people adapter is `src/handset/agents/people.ts`. Policy membership
comes from the signed Business mapping: owner is owner, team admin is editor,
and team member has no policy role. A native admin promotion alone confers no
Business editor authority. Unknown and inactive people cannot sponsor calls.

Shared-door queued effects require an authenticated consent binding retained
with the native job and rechecked at execution. The copied runtime's
`ToolContext` does not expose that consent or an execution handle from which
the adapter can obtain it. Its embedded `invoke` entry also has no consent
input. Until the runtime supplies that binding, the copied runtime is not
mounted for native tools. Caller arguments, an agent ID or a matching email
cannot supply the missing authority. Existing STOP, recipient permission,
hours, approval, budget, uncertainty and native grant checks continue to apply.

No provider cost or shared-door spend enforcement is offered. A future shared
journey must declare `spend: {none: true}` until reservations are supported.
Device, screen, connector, reviewed import and installation credentials retain
their own purposes and do not authorize a company agent.
