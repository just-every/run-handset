# Fonts

Every face is self-hosted under the SIL Open Font License 1.1; each folder
holds its licence (`LICENSE.txt`). `fonts.css` declares them all once, and no
page makes a third-party font request.

| Folder | Face | Used for | Upstream |
| --- | --- | --- | --- |
| `archivo/` | Archivo, weights 400 to 900 (width 100) | the run site's and the installed app's outline headings, numerals and the Handset wordmark | https://github.com/Omnibus-Type/Archivo |
| `ibm-plex-sans/` | IBM Plex Sans, weights 300 to 700 (width 100) | the run site's and the installed app's sentences, links and buttons | https://github.com/IBM/plex |
| `ibm-plex-mono/` | IBM Plex Mono, 400 and 500 | the run site's and the installed app's records: logs, times and tags | https://github.com/IBM/plex |
| `outfit/` | Outfit, weights 100 to 900 | sign-in and setup | https://github.com/Outfitio/Outfit-Fonts |

The Archivo, IBM Plex Sans and IBM Plex Mono files are cut from the Google
Fonts releases (`ofl/archivo`, `ofl/ibmplexsans`, `ofl/ibmplexmono`) with
fontTools: the variable fonts pinned to width 100, subset to Basic Latin,
Latin-1, general punctuation and the arrows (the → in "Run Handset →" and in
the page's records), and saved as WOFF2. The Outfit files are Fontsource's
Latin and Latin Extended subsets.

The root document links `/fonts/fonts.css` once, outside the temporary dev SSR
stylesheet, and preloads only the primary Latin Outfit file. Do not import this
CSS from a component. Every sign-in and setup body-font stack uses `--font-body`,
including the local `Outfit Fallback` before generic fallback fonts; controls
inherit it. The run site's pages and the signed-in app's pages preload Archivo
and IBM Plex Sans; the app sets its own stacks in `/handset-app.css`.

Outfit's fallback scales use Outfit/Arial advance-width ratios over A-Z, a-z
and 0-9 at weights 400, 500 and 700. Ascent, descent and line gap match
Outfit's 1000, -260 and 0 per 1000 units, divided by each scale. Matching
metrics reduces layout movement; different glyph designs cannot have identical
widths in every piece of text. Recalculate the fallback and preload when
changing the app's brand font.
