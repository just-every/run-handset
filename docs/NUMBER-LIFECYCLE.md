# Number acquisition and reviewed release

HND-001 remains PARTIAL. The owner uses `/app/numbers`; the equivalent direct API begins at `/api/handset/numbers`. No carrier credentials or live account were used in this round. Tests substitute only the carrier network edge around the real built Worker, native sessions and migrated D1.

The initial check found no assertion for any of the three original acceptance sentences. This implementation closes the repeated-purchase protection and the native reviewed-release, local-hold and stale-request behaviors at the official carrier-schema edge. It does not prove the original live acquisition, activation or carrier-recycling acceptance.

Search supports US and Canada, local and toll-free, area code, city and vanity pattern. The carrier supplies availability, capabilities and USD monthly pricing. The first month is charged upfront. Setup costs, taxes and usage are explicitly unknown in this API and require the owner's direct carrier contract. An expired, foreign-owner or changed-price quote cannot authorize acquisition. There is no live routing activation here.

Before a paid creation, an atomic transaction records the exact quote, request identity, assignment details, named current owner and opaque audit event. A unique request identity and unique number prevent concurrent allocation. Repeated requests return the existing state, including after restart. Changed input under one identity is refused. No uncertain creation is retried, including after a carrier error: explicit readback must match account, exact number and the server-selected purchase reference before ownership becomes confirmed. A successful creation response also requires independent matching ownership readback.

Release review names one exact number, its current revision, one owned replacement and its current revision. It retains the named owner's current authority and starts a cancellable local 24-hour hold. Execution requires that same current approver and revision, an elapsed hold, an unchanged owned replacement and fresh carrier readback. Active carrier routes, emergency or address assignments, active inbound sources and unresolved native port correction cases refuse release. Sources cannot be authorized after a release review or release reservation has protected the number. Only inventory assignment details move to the replacement; live routing reassignment is a separate unproved requirement. Intent and reassignment are recorded atomically before one carrier DELETE. A lost release response remains uncertain and requires carrier investigation; it never triggers a second DELETE.

Twilio documents Console recovery within ten days and a new billing cycle on recovery. Its number API does not expose the actual recycling hold. The console distinguishes that carrier recovery guidance from the local review hold; it promises no undo after release.

Conservative default ADOPTED pending CT: current installation owners alone approve exact purchases and exact release with a local 24-hour cancellable hold; no autonomous purchase, release, retry or routing activation; no unqualified recovery promise. This is interim. HND-105 retains the original scoped administrator and custom-role destination. HND-031 and HND-088 retain real carrier qualification, responsibility and direct-owner contracting obligations. HND-047 retains complete audit composition and restoration; the new native request families use its existing opaque append-only transaction path.

Original acceptance and remaining proof:

| Original acceptance point | Current public-door assertion | Remaining |
| --- | --- | --- |
| Through the numbers console at 1440 and 390, buy a 512 local number and an 833 toll-free number in under one minute; authorized PSTN calls to both ring within five minutes. | `tests/handset-console-browser.mjs` — numbers console at 1440; numbers console at 390. Both acquire the exact 512 and 833 numbers at the substituted carrier edge, with populated inventory, capability and USD review, uncertain readback and refusal states. | Authorized real purchase, independent charge evidence, measured acquisition and ringing on controlled receiving phones; complete setup costs and production carrier qualification. No timing or live activation claim. |
| Repeat a purchase request without a second charge or number. | `tests/handset-admin.mjs` — Number purchases reserve once across concurrent requests and preserve uncertain carrier outcomes through restart. Exact one paid POST and one inventory entry, same request identity, conflicting-input refusal, exact local and toll-free ownership after uncertain reconciliation and no retry after restart. | Real carrier charge qualification remains required; the network-edge protocol behavior is proved. |
| Release one after reviewed reassignment; check the carrier hold and refusal of a stale release. | `tests/handset-admin.mjs` — Exact-number release preserves a review hold, refuses stale approvals and reassigns once before carrier release. Named approval, exact replacement, early refusal, cancellation, stale revision, protected emergency and route refusal, explicit assignment and revision, exactly one DELETE. Browser journeys show local hold, stale refusal and released state at both widths. | Actual carrier release and recycling or recovery evidence; live routing reassignment. The API exposes no recycling deadline, so the local hold does not discharge the carrier-hold point. |

Permission and dependency refusals: `tests/handset-admin.mjs` — Number ownership and protected dependencies refuse unauthorized or unsafe carrier effects. Anonymous, foreign origin, member, withdrawn owner, active source and unresolved port paths are refused through public doors. Browser controls all have visible text; no icon-only control was introduced.

Executed mutation probes (temporary mutants were removed; failures were checked against the named assertion):

| Mutation | Assertion that failed | Result |
| --- | --- | --- |
| Issue a second carrier POST for one approved purchase | one paid creation for a concurrent repeated purchase | KILLED |
| Omit the replacement assignment update | explicit replacement revision and assignment assertions | KILLED |
| Ignore the local review deadline | cooling hold refuses early execution | KILLED |
| Accept a stale submitted release revision | stale revision cannot consume current approval | KILLED |

The mutation probes run on the final acquisition, release and administration test bytes; temporary mutants are restored and final candidate tests rebuild the unmutated source. The exact source comparison and execution logs travel with the run's reports. Browser evidence contains the real built screens at both widths, including empty, no results, quote, owned, uncertain, reviewed hold, early refusal, stale, released, failed provider and denied states.

Provider references: [number search](https://www.twilio.com/docs/phone-numbers/api/availablephonenumberlocal-resource), [toll-free search](https://www.twilio.com/docs/phone-numbers/api/availablephonenumber-tollfree-resource), [monthly pricing](https://www.twilio.com/docs/phone-numbers/pricing), [purchase and release](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource), [release and recovery](https://help.twilio.com/articles/223183028-Cancel-or-release-a-Twilio-number).
