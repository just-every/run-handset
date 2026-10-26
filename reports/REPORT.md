# Handset page-s2 candidate

Candidate branch: `cloud/br-page2-handset`. Built from main `aaf706e80c7dbf11c3ef7c617ad686d9377ba6cb`. The final candidate SHA and exact-head Verify run are recorded in the delivery report and the external BUILT.md after push, so this source-locked report does not embed its own commit hash.

All nine approved screens are present in order: hero, burst pipe, Press 2, twenty callers, name back, after-hours interlude, follow-ups, number migration, Thanksgiving and footer. All copy/proofs are HTML. Painted objects use clean AVIF/WebP plates; the hero and full-width cord include 2304/3072 variants. All nine fresh conversions used the supplied 12ui slot wrapper in order. The logo, favicons, brand fonts/tokens and retained width fixes remain.

Words exclude standalone ·, + and →. Header/footer measured separately.
Calm ground: 16 px tiles, every channel of every pixel within 40 levels of its section ground.
Calm clearance: same mask after a 32 px square clearance around non-ground tiles.

| Screen | Words 1440 | Words 390 | Limit | Calm 1440 | Desk calm | Calm 390 | 32 px clearance 1440 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | 36 | 36 | 36 | 39.56% | 42% | 40.65% | 3.85% |
| 02 | 44 | 44 | 44 | 75.24% | 77% | 74.04% | 54.46% |
| 03 | 27 | 27 | 27 | 85.20% | 85% | 66.02% | 66.41% |
| 04 | 38 | 38 | 38 | 81.15% | 82% | 62.77% | 61.93% |
| 05 | 52 | 52 | 52 | 82.31% | 82% | 65.44% | 64.65% |
| 06 | 19 | 19 | 19 | 74.28% | 75% | 28.74% | 66.17% |
| 07 | 33 | 33 | 33 | 85.31% | 85% | 63.73% | 67.52% |
| 08 | 37 | 37 | 37 | 72.28% | 72% | 56.11% | 54.76% |
| 09 | 25 | 25 | 25 | 79.51% | 78% | 63.16% | 51.65% |

The per-screen word counts match STRUCTURE.md at 1440 and 390: 311 words, or 325 with the header and footer. Desktop calm share is within 2.44 percentage points of the desk. Phone calm share is printed for completeness; no phone calm target is supplied.

Typecheck and both tests in `tests/site/site.test.mjs` pass. The updated test is named “the run site builds with named story proofs, its Run Handset actions open /run, and every link and file resolves”. It preserves the original navigation, assets and owner-data checks and adds accessible section names and real HTML proofs, without pinning copy/count. No new permanent test was registered. The /docs test is unchanged.

The browser check builds the site and follows its /run, /docs and /contract links. After scrolling every section and decoding images, the sweep checks all 111 widths from 360 to 2560: zero sideways overflow, text below 13 px, clipped text, text overlaps, card-edge escapes, text scroll spill or separator-led lines. Browser errors: zero. Full-size screens were inspected at 1440/390 and the requested desktop widths, with tablet/intermediate desktop inspection. The final alignment restores the individual picked desktop positions and the closing proof’s single desktop line. The two drawn phone plans are implemented as whole, readable proofs.

No numerical story figures changed from main. The approved corrected 303-555-0190, chronological 40-second handoff, 1,226 + 58 = 1,284, 31/31, 20 waiting, 4:54/0 abandoned, 21 + 2 = 23, four ports/eighteen phones/zero missed test calls and calendar-correct 2026 dates remain. CLAIMS.md maps every capability to code/contract and marks partial and target-only outcomes explicitly.

External build evidence bundle: `br-handset/page-s2-built`. See BUILT.md for each screen’s differences, words-and-whitespace.txt, sweep.txt, shots/ and COMPARE.jpg (943,134 bytes). Built font forms use retained Archivo/IBM Plex; the 21 is optically spaced, with Archivo’s foot on 1. Phone 05 retains 24 px gutters for 360 px legibility, against about 35 px in the drawn plan. Other phone compositions follow the same spirit where no plan is supplied. No substitute art, text painting-over or blurred text is used.

Scope: homepage/site styles and plates, existing site test, CLAIMS.md, this requested report, and refreshed edition source lock. Product source, Base, package files and workflows are untouched. No deploy, publication scan or landing. The local candidate clone is deleted after push and exact-head CI; external evidence remains. No side issue requires an owner decision. Independent critic review is the next result.
