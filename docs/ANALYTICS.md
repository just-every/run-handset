# Historical customer-call reports

The existing Queue reports console now combines two clearly separate source populations:
reviewed queue observations retain HND-086 formulas, while native customer calls
are grouped once per canonical call. Enter `*` as Queue ID for all native calls;
a specific queue selects calls with a visit to that queue. Interval ends are excluded.
The native API and customer-call CSV use the same current-owner authorization as
the console. Scheduled reports bind the formula revision and exact owner recipient;
a revoked owner or changed owner version prevents delivery.

Local hours include their UTC offset, keeping both fall-back hours distinct.
Person remains the current case owner. Handling user is a separate dimension: only a completed provider-read-back queue offer, bound to the canonical source and parent call, attributes a handler. Ringing, reservations and case ownership never supply handling evidence. A transfer may have multiple verified handlers; each sees the call once, so handling-user groups are not additive. Missing attribution remains Unattributed.
Completed or in-progress provider legs count as answered; this does not establish
independently received staff audio. A canonical terminal no-answer, busy, failed
or canceled call is missed only when no leg is answered. Other and unknown states
remain in volume, with their exclusion from answered and missed counts shown.
Root calls, transfer legs and endpoint offers never inflate canonical call volume.
CSV contains one row per selected root call, with local hour, timezone, reporting team, reporting location, tracking source, handling users, handling offer IDs, linked receptionist outcome IDs, booking outcome flags and capture time.
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

Tracking sources are versioned owner-maintained business-number labels. Unattributed
clears the label. Changing only a team or location through the API without supplying
a source preserves the current source. A stale source edit retains its draft and
shows the current source before explicit reconciliation. These are current reporting
labels; they do not verify ad clicks or an advertising platform, or reconstruct
historical source assignments. Captured reports retain their exact labels and revision.

Booking conversion requires an independently read-back booking tied to the exact
canonical call ID and the same case within the declared repeat-contact window.
Only tracked inbound calls with verified number identities and a complete observation
window enter the denominator. Unattributed, immature and unknown-identity exclusions
are disclosed. A booking on another call in the same case, manual closure or an
unlinked or wrong-case outcome never converts this call. Empty denominators are
unavailable. Source filters, custom dashboard measures, CSV, API, retained reports
and owner schedules use the same source call set.

Native booking containment has a deliberately bounded outcome basis. Its denominator
is distinct terminal inbound calls with exactly linked receptionist work. Its numerator
requires a completed call and a confirmed booking, with no recorded human assignment,
handoff, escalation or unfinished step. Replays do not multiply calls. Historical
exceptions still exclude containment after a human decides them. This metric measures
observed native booking work, and does not certify audio, an external human transfer,
or every receptionist resolution type. The report discloses that boundary beside
the raw numerator and denominator.

HND-022 remains partial. Completed native queue offers now provide handling-user
attribution, while other handling paths still need qualification. Complete receptionist
session completion and human-handoff proof remain beyond the bounded native booking
measure. HND-019 supplies the real live-wallboard comparison; stored queue observations
are not a live wallboard. Real survey SMS and handset receipt remain held on toll-free
verification. No real text is sent by these reporting proofs. The existing HND-092
live-mail proof does not establish a newly delivered HND-022 report; these journeys
exercise the official mail edge. HND-023 retains advertising-platform attribution.
