Old reference: `3f0fa40d5a6f029f3aaa26c65f6f3b19bc2d8ad5` (main, 28 October 2026). Clauses done there: HND-064, HND-086, HND-092, HND-096 and HND-100.

# Carried-done audit

One row per outcome of every acceptance point of every clause that was done at the old reference. **Asserting test** is the line of the assertion (or of the call whose expected status a test helper asserts) in a file the clause's Evidence cell lists. **Result** is `asserted`, `none` or `moved`. A `none` row demotes its clause to partial, and that clause's Gap names the outcome. A `moved` row is an outcome that left the point as a restated Base duty or as mechanism, with its destination.

| Clause | Point | Outcome | Asserting test | Result |
| --- | --- | --- | --- | --- |
| HND-064 | 1 | A link is requested through the real configured mail provider | none in a cited file: the receipt check is `tests/helpers/handset-mailbox.mjs:17`, run only when `HANDSET_LIVE_MAIL=1`, which Verify does not set | none |
| HND-064 | 1 | A link is requested (local mail capture) | `tests/handset-auth.mjs:28` | asserted |
| HND-064 | 1 | The link is confirmed and signs the operator in | `tests/handset-auth-browser.mjs:36` | asserted |
| HND-064 | 1 | A replayed link is refused | `tests/handset-auth.mjs:27` | asserted |
| HND-064 | 1 | An expired link is refused | `tests/handset-auth.mjs:36` | asserted |
| HND-064 | 1 | Unknown and inactive requests are indistinguishable | `tests/handset-auth.mjs:14` | asserted |
| HND-064 | 1 | Sign-out revokes the session | moved to Base BASE-ACCESS-002 | moved |
| HND-064 | 2 | A forged carrier callback has no effect | `tests/handset-auth.mjs:87` | asserted |
| HND-064 | 2 | A forged carrier callback has no effect at 1440 and 390 | `tests/handset-auth-browser.mjs:56` | asserted |
| HND-064 | 2 | A cross-origin mutation is refused | `tests/handset-auth.mjs:81` | asserted |
| HND-064 | 2 | A cross-origin mutation is refused at 1440 and 390 | `tests/handset-auth-browser.mjs:43` | asserted |
| HND-064 | 2 | No demo or shared-account login bypasses sign-in | `tests/handset-auth.mjs:65` | asserted |
| HND-064 | 2 | Declared public paths and throttling | moved to Base BASE-ACCESS-003 | moved |
| HND-064 | old 2 | Private routes, server functions, media and API refuse unsigned and revoked reads with no data or effect | moved to Base BASE-ACCESS-002 | moved |
| HND-064 | old 4–8 | The current door inventory, link and session lifetimes, handler fences and signed Twilio ingress | moved to `docs/HTTP-DOORS.md` (mechanism) | moved |
| HND-086 | 1 | The public-import dataset loads with queue A's six offered entries | `tests/handset-reporting.mjs:29` | asserted |
| HND-086 | 1 | The handled entries carry 160 talk, 40 hold and 40 wrap seconds | `tests/handset-reporting.mjs:28` | asserted |
| HND-086 | 2 | Exclude-abandons service level is 2 of 4 | `tests/handset-reporting.mjs:38` | asserted |
| HND-086 | 2 | Include-abandons service level at S of 5 is 2 of 5 | `tests/handset-reporting.mjs:23` | asserted |
| HND-086 | 3 | ASA is 17.5 seconds | `tests/handset-reporting.mjs:24` | asserted |
| HND-086 | 3 | Eligible abandonment is 1 of 5 | `tests/handset-reporting.mjs:25` | asserted |
| HND-086 | 3 | Mean eligible abandon wait is 40 seconds | `tests/handset-reporting.mjs:26` | asserted |
| HND-086 | 3 | AHT is 60 seconds | `tests/handset-reporting.mjs:27` | asserted |
| HND-086 | 4 | At S of zero, include-abandons service level is 2 of 6 | `tests/handset-reporting.mjs:41` | asserted |
| HND-086 | 4 | At S of zero, abandonment is 2 of 6 | `tests/handset-reporting.mjs:42` | asserted |
| HND-086 | 4 | At S of zero, mean abandon wait is 21.5 seconds | `tests/handset-reporting.mjs:43` | asserted |
| HND-086 | 5 | Queue-B transfer, overflow and callback entries reconcile with no queue-B arrival | `tests/handset-reporting.mjs:53` | asserted |
| HND-086 | 5 | The callback keeps its offered-call correlation | `tests/handset-reporting.mjs:54` | asserted |
| HND-086 | 5 | Queue-A arrivals are not duplicated | `tests/handset-reporting.mjs:55` | asserted |
| HND-086 | 6 | 600 staffed seconds give 40% occupancy | `tests/handset-reporting.mjs:32` | asserted |
| HND-086 | 6 | Exact state durations | `tests/handset-reporting.mjs:31` | asserted |
| HND-086 | 6 | Expected answered and missed offers | `tests/handset-reporting.mjs:33` | asserted |
| HND-086 | 7 | All entries are closed before the comparison | `tests/handset-reporting.mjs:22` | asserted |
| HND-086 | 7 | Live and final historical values agree (API door) | `tests/handset-reporting.mjs:36` | asserted |
| HND-086 | 7 | Live and final historical values agree at 1440 and 390 | none: `tests/handset-console-browser.mjs:161` saves the final report and captures it, and no assertion reads the history page | none |
| HND-086 | 7 | The method and thresholds change at 1440 and 390 | `tests/handset-console-browser.mjs:164`, `tests/handset-console-browser.mjs:168` | asserted |
| HND-086 | 7 | Changing them rewrites no original leg | `tests/handset-reporting.mjs:44`, `tests/handset-reporting.mjs:48` | asserted |
| HND-086 | 7 | The scheduled per-queue report arrives with these formulas and totals | `tests/handset-reporting.mjs:68` | asserted |
| HND-086 | 7 | The scheduled report shows as accepted at 1440 and 390 | `tests/handset-console-browser.mjs:172` | asserted |
| HND-092 | 1 | A known month exports as admin CSV with every call | `tests/handset-reporting.mjs:121` | asserted |
| HND-092 | 1 | Call and leg counts reconcile | `tests/handset-reporting.mjs:120` | asserted |
| HND-092 | 1 | The CSV carries the timezone | `tests/handset-reporting.mjs:122` | asserted |
| HND-092 | 1 | Exactly one scheduled per-queue call-log email arrives | `tests/handset-reporting.mjs:147` | asserted |
| HND-092 | 1 | The email's call and leg counts and timezone reconcile | `tests/handset-reporting.mjs:149` | asserted |
| HND-092 | 2 | The selected range reaches Box, Dropbox and Google Drive at their official edges | `tests/handset-reporting.mjs:173` | asserted |
| HND-092 | 2 | The selected range reaches the buyer's SFTP server | `tests/handset-reporting.mjs:211` | asserted |
| HND-092 | 2 | File count verified independently | `tests/handset-reporting.mjs:176` | asserted |
| HND-092 | 2 | Media checksums verified independently | `tests/handset-reporting.mjs:179` | asserted |
| HND-092 | 2 | Transcript links | `tests/handset-reporting.mjs:178` | asserted |
| HND-092 | 2 | An explicit unavailable-recording entry | `tests/handset-reporting.mjs:178`, `tests/handset-reporting.mjs:214` | asserted |
| HND-092 | 3 | A lost response after transfer | `tests/handset-reporting.mjs:170` | asserted |
| HND-092 | 3 | Interrupt and resume completes | `tests/handset-reporting.mjs:173`, `tests/handset-reporting.mjs:212` | asserted |
| HND-092 | 3 | No duplicate manifest entries or files | `tests/handset-reporting.mjs:173`, `tests/handset-reporting.mjs:181` | asserted |
| HND-092 | 4 | Revoking destination access stops future transfers | `tests/handset-reporting.mjs:183`, `tests/handset-reporting.mjs:216` | asserted |
| HND-092 | 4 | A restricted supervisor cannot bulk-export recordings | `tests/handset-reporting.mjs:125` | asserted |
| HND-092 | 4 | A restricted supervisor cannot email a call log | `tests/handset-reporting.mjs:125` | asserted |
| HND-096 | 1 | The preview names the duplicate extension row | `tests/handset-admin.mjs:15` | asserted |
| HND-096 | 1 | The preview names the reused MAC row | `tests/handset-admin.mjs:16` | asserted |
| HND-096 | 1 | The preview names the missing emergency address row | `tests/handset-admin.mjs:17` | asserted |
| HND-096 | 1 | The console shows the named-row errors (representative case) | `tests/handset-console-browser.mjs:58` | asserted |
| HND-096 | 1 | A plan with errors cannot be approved | `tests/handset-admin.mjs:18` | asserted |
| HND-096 | 1 | Fixed rows preview with no errors | `tests/handset-admin.mjs:20` | asserted |
| HND-096 | 1 | The plan shows its cost | `tests/handset-admin.mjs:22`, `tests/handset-admin.mjs:24` | asserted |
| HND-096 | 1 | Apply needs the exact approved plan | `tests/handset-admin.mjs:25`, `tests/handset-admin.mjs:26` | asserted |
| HND-096 | 1 | 60 users and 40 devices are applied | `tests/handset-admin.mjs:34` | asserted |
| HND-096 | 1 | The console applies the approved plan to completion | `tests/handset-console-browser.mjs:66` | asserted |
| HND-096 | 2 | An interrupted apply keeps its durable cursor | `tests/handset-admin.mjs:30` | asserted |
| HND-096 | 2 | Reapply replays without new work | `tests/handset-admin.mjs:32` | asserted |
| HND-096 | 2 | No duplicate users or devices | `tests/handset-admin.mjs:35`, `tests/handset-admin.mjs:46` | asserted |
| HND-096 | 2 | No charges | `tests/handset-admin.mjs:42` | asserted |
| HND-096 | 3 | A versioned template updates a selected group | `tests/handset-admin.mjs:96`, `tests/handset-admin.mjs:97` | asserted |
| HND-096 | 3 | Its diff is shown | `tests/handset-admin.mjs:85` | asserted |
| HND-096 | 3 | Affected and unaffected records | `tests/handset-admin.mjs:98` | asserted |
| HND-096 | 3 | A stale approval is refused | `tests/handset-admin.mjs:89` | asserted |
| HND-096 | 3 | An unauthorized role grant is refused | `tests/handset-admin.mjs:79` | asserted |
| HND-096 | 3 | Independent user overrides are preserved | `tests/handset-admin.mjs:94`, `tests/handset-admin.mjs:95` | asserted |
| HND-096 | 3 | Active calls are preserved | `tests/handset-admin.mjs:100`, `tests/handset-admin.mjs:101` | asserted |
| HND-100 | 1 | Processing without per-source consent is refused | `tests/handset-records.mjs:942` | asserted |
| HND-100 | 1 | Processing without per-purpose consent is refused | `tests/handset-records.mjs:941` | asserted |
| HND-100 | 1 | The exact consented run is allowed | `tests/handset-records.mjs:947` | asserted |
| HND-100 | 1 | The output carries its source label | `tests/handset-records.mjs:948` | asserted |
| HND-100 | 2 | A changed consenting-owner version refuses the next run | `tests/handset-records.mjs:1019` | asserted |
| HND-100 | 2 | After a version change, derived output is erased | `tests/handset-records.mjs:1016` (asserted at `tests/handset-records.mjs:992`) | asserted |
| HND-100 | 2 | Withdrawn consent refuses the next run | `tests/handset-records.mjs:999` | asserted |
| HND-100 | 2 | After withdrawal, derived output is erased | `tests/handset-records.mjs:998` (asserted at `tests/handset-records.mjs:992`) | asserted |

## Demoted

- **HND-064** is partial: request through the real configured mail provider is not asserted in a cited file inside Verify.
- **HND-086** is partial: at 1440 and 390 the final-history page is never read, so live-versus-final agreement is asserted only at the API door.
