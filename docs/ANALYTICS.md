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
CSV contains one row per root call, with local hour, timezone and capture time.
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

HND-022 remains partial. Team and location grouping, actual staff attribution,
receptionist containment and tracking conversion, custom dashboards and richer
filtered drill-down remain. HND-019 supplies the still-missing real live-wallboard
comparison; stored queue observations are not a live wallboard. Real survey SMS
and handset receipt remain held on toll-free verification. No real text is sent
by these reporting proofs. The existing HND-092 live-mail receipt does not prove
a newly delivered HND-022 report; this round exercises the official mail edge.
