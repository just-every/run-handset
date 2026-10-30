# Agent access

Handset serves one shared agent door at `/mcp`. The existing
`/api/handset/application/mcp` and `/api/handset/v1/mcp` addresses are aliases of
that door. Discovery negotiates MCP 2026-07-28 and 2025-11-25; canonical OAuth
resource metadata names `/mcp`. `/api/rer/agent-policy` accepts signed Business
policy. Native people decide approvals, inspect activity and pause agents at
`/agents`. These routes run before ordinary app session and setup redirects.

The runtime is recorded from Base `e881e6f66ce7cd737d17dbeb945995aab83c30d8`;
the project CLI is released `@runeditrun/rer` 0.2.94. The declared capabilities
are **tools, policy, pause, audit and idempotency**. Events, resources, prompts
and subscriptions are explicitly undeclared and return typed refusals. The
larger target registry and resource catalogue in CONTRACT.md remain targets.

## Current jobs

| Tool | Native action | Class |
| --- | --- | --- |
| `handset.cases.read` | Read one case selected in the native application grant (`case.read`) | sensitive |
| `handset.comments.draft` | Save an unpublished native comment draft (`comment.draft`) | standard |
| `handset.calls.prepare` | Prepare exactly reviewed paid-call work (`call.paid`) | standard |
| `handset.messages.prepare` | Prepare exactly reviewed message work (`message.send`) | standard |
| `handset.campaigns.prepare` | Prepare exactly reviewed campaign work (`campaign.launch`) | standard |
| `handset.numbers.prepare_release` | Prepare exactly reviewed release work (`number.release`) | standard |
| `handset.flows.prepare_publish` | Prepare exactly reviewed publication work (`flow.publish`) | standard |
| `handset.workspace.snapshot` | Inspect the sponsor's native case, draft and held-job counts | standard |

Preparation changes only internal held work. It does not place calls, send
messages, launch campaigns, release numbers or publish flows. Its result retains
`held_adapter_unqualified` and `effectOccurred: false`. A native exact approval
or bounded standing policy remains necessary independently of company policy.
No outbound provider is reachable through these tools, so their conformance
journey declares no network edge. There is no provider cost registration or
shared spend reservation; the journey declares `spend: {none: true}`.

Tools require a selected native `grantId`; cases and proposed states must lie
within that grant's current selections, budget and native policy revision.
Business consent does not create a grant. A grant belongs to its native sponsor;
another person's knowledge of its ID provides no access. Native grant and
person version fences remain inside native transactions. Company policy,
Pause, agent and consent revocation are fenced again with native commits.
Drafts and native audit retain `<agent> for <person>`, and held jobs retain the
originating consent, sponsor, agent, scopes, client, operation and public key.

The trusted `HandsetAgentJobs` Worker service persists an invocation before it
drains it through the same public `door.invoke` boundary. It has no HTTP enqueue
route. Missing or running work cannot be blindly resent; retained replay goes
through current door admission. The earlier application execute endpoint cannot
execute shared-door held work without its authenticated originating identity.

## People and credentials

The native operator store remains authoritative. Signed Business settings bind
`owner_id` to the native setup owner and team IDs to the existing invited native
operators. Business admin maps to native admin and Business editor; member maps
to native member with no policy role. A local native promotion does not create a
Business policy membership. Unknown and inactive sponsors are refused, and a
changed token email cannot move an existing binding or inherit another account.

Explicit native application credentials retain their read/draft/send selections
and map to their original sponsor ID. Their client IDs are namespaced separately
from Business clients. Current scopes can narrow a credential, never widen it;
failed recognizable Business tokens never become local credentials. The owner
bootstrap uses the manifest's native setup-token lifecycle. Verification consumes
real native invitations and suspends a Business-bound member through native
person routes. No installation allow-list is currently configured, so the
excluded-allow-list probe is not claimed.

Device calling, personal sign-in, Teams connection, reviewed import and owner
installation/backup keep their existing separate doors and credentials. The
front-office specialist can inspect selected case context, draft a callback note
and prepare reviewed work. It must report the held state and ask the native
person for unavailable delivery or human-only provider work. It cannot promise
a call, delivery, payment, appointment, publication or customer outcome from a
preparation receipt. Broader native UI jobs and target specialist journeys remain
outside this current scoped agent registry.
