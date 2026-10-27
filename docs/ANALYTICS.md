# Historical customer-call reports

The existing Queue reports console now combines two clearly separate source populations:
reviewed queue observations retain HND-086 formulas, while native customer calls
are grouped once per canonical call. Enter `*` as Queue ID for all native calls;
a specific queue selects calls with a visit to that queue. Interval ends are excluded.
The native API and customer-call CSV use the same current-owner authorization as
the console. Scheduled reports bind the formula revision and exact owner recipient;
a revoked owner or changed owner version prevents delivery.

Local hours include their UTC offset, keeping both fall-back hours distinct.
Person means current case owner, rather than claiming unqualified agent attribution.
Completed or in-progress provider legs count as answered; this does not establish
independently received staff audio. A canonical terminal no-answer, busy, failed
or canceled call is missed only when no leg is answered. Other and unknown states
remain in volume, with their exclusion from answered and missed counts shown.
Root calls, transfer legs and endpoint offers never inflate canonical call volume.
CSV contains one row per selected root call, with local hour, timezone, reporting team, reporting location and capture time.
The JSON API and immutable historical and scheduled reports retain raw denominators,
source IDs and the full snapshot. Native observations contribute to the source hash.

First-call resolution uses the configured repeat-contact window (168 hours by
default, 1 to 720 permitted). Identity is the exact verified source, caller number
and business number. First contacts follow a full quiet window; subsequent contacts
are excluded from the first-contact denominator. A full observation window must
have elapsed before a first contact is eligible. Unknown identities and immature
windows are explicitly excluded. A resolution requires an independently read-back
same-case booking within the window and no subsequent contact within that window.
Manual closure and AI sentiment never establish a successful outcome. This is a
booking-specific outcome basis, not a claim about all business resolution types.

Recovery counts reconcile unique customer cases, with confirmed counts requiring
both resolved recovery state and the matching confirmed booking step in that case.
CSAT uses actual stored customer ratings only. Its response rate denominator is
eligible delivered invitations; its mean denominator is responses. No response and
AI sentiment have no rating. Outcomes are current as of the displayed capture time;
historical snapshots retain the captured values.

Reporting teams and locations are explicit owner-maintained business-number
assignments, separate from staff membership. Numbers without an assignment use
Unassigned. Changes append an audited revision. Each captured source call retains
the assignment revision; historical reports keep their captured labels.

Follow a group or outcome link to intersect customer-call filters. The source
list, CSV, API, recovery cases and survey denominator use those same selected calls.
FCR still examines surrounding contacts outside the selected subset, so filtering
out a repeat cannot turn a first contact into a successful resolution. Recovery
case totals deduplicate multiple needs in the same customer case. Reviewed queue
formulas and agent timelines retain the complete configured queue interval and
are labeled separately from filtered native calls.

Custom dashboards save an exact formula revision, customer-call filters, grouping
dimensions and displayed group measures. Current owner authority is checked at
every read, export, save and delete. A stale edit preserves the submitted draft
and requires explicit comparison before replacing the latest revision. Reporting
assignment conflicts keep the submitted team and location beside the current
values for explicit reconciliation. If another session deletes a dashboard,
the refused save keeps its name, filters, groups and measures and offers an
explicit save as a new dashboard; the deleted identity remains deleted. Scheduling
binds the exact reviewed dashboard definition; subsequent edits or deletion do not
rewrite an approved scheduled definition or a retained report. Owner authority and
recipient are checked again before release, and a revoked owner receives no report.

The known-week journey reconciles two independent source populations through
public doors. Signed provider ingress supplies canonical customer calls with the
DST split, a transfer leg, failed recording metadata, unresolved repeat work and a
confirmed booking read back at the receiving network edge. A separate reviewed
queue dataset supplies queue transfer and overflow legs, callback parents, agent
timelines and every HND-086 fixture total under both abandoned-call methods.
Imported queue identities do not claim to be these canonical carrier calls.
Exact queue source observations are read back through the datasets door, and
queue formulas are reconciled in live, retained and scheduled reports. Provider metadata
and independently stored test-edge booking readback do not certify live audio or
real external delivery.

HND-022 remains partial. Actual handling-user attribution, receptionist containment
and tracking conversion remain. HND-019 supplies the still-missing real live-wallboard
comparison; stored queue observations are not a live wallboard. Real survey SMS
and handset receipt remain held on toll-free verification. No real text is sent
by these reporting proofs. The existing HND-092 live-mail receipt does not prove
a newly delivered HND-022 report; this round exercises the official mail edge.
