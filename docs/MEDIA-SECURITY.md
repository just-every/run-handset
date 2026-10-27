# Current prompt media boundary

HND-048 is partial. These declarations cover the current prompt and signed
ingress doors; they do not qualify an operating carrier, a SIP device or a live
speech model. No live conversation audio is submitted to a model by these doors.

| Flow | Fields and destination | Purpose and authority | Withdrawal and custody |
| --- | --- | --- | --- |
| Uploaded or browser-recorded greeting | Selected prompt, language, variant, schedule and WAV bytes to the installation's configured HTTPS origin | Current native owner or an approved current greeting-draft role creates a scoped draft. Browser microphone permission is separate from server permission. | Every mutation checks the native session and browser origin. Normalized audio stays in the installation database until the owner erases installation data; a draft authoring door provides no external playback. |
| Greeting text to speech | Model, input text, voice, language instructions and WAV response format to `https://api.openai.com/v1/audio/speech` | Current native owner explicitly requests a greeting version, with direct AI transport enabled. Only authored greeting text leaves; no recording or live call is supplied. | Disabled or missing AI configuration refuses. Any other origin, port, path, credentials in the address, query or fragment refuses before credentials or text leave. Provider redirects are never followed. OpenAI receives the configured private key only in its authorization header. |
| Phone greeting readback | Exact account and recording identifiers to the fixed Twilio account resource, first JSON then WAV | A signed callback must match the current source, exact call and author's own registered extension, after the one-time code. Caller-supplied recording URLs are ignored. | Source authority is rechecked before fetching audio and before retaining a draft. Revocation during metadata readback prevents the audio request. Redirects and wrong call or account identity refuse. The private carrier token appears only in the Twilio authorization header. |
| Carrier test playback | Exact approved normalized WAV from the installation to the bearer of one test-bound audio address | A current owner selects the source, immutable flow and test instant. Signed ingress binds the test to one carrier call. | The address binds the test and exact version, expires with the test, requires a current source on every fetch, and uses no-store. Revocation or replacement consent never revives an old address. No carrier key or native session travels in that address. |
| Signed MMS ingress | Account, event, number, text and media-reference metadata from Twilio to this installation | Valid exact-URL signature and current selected-number source consent | Media references must use the exact HTTPS Twilio origin without embedded credentials, query or fragment. Malformed references refuse. Ingress does not download MMS media or follow its links. Revocation fences retained events. |

WAV validation checks complete RIFF length, bounded chunks, one format and one
data chunk, frame alignment, byte rate, codec, channels, sample rate and duration.
Provider audio must also declare a WAV content type and stay within the upload
bound while streaming; a missing or false size header cannot remove that bound.
Normalization drops ancillary file metadata. Neither malformed files nor refused
provider media create prompt versions. Redirect targets receive no request.

The installation's actual US region and the external providers' US processing,
retention and erasure configuration are **unqualified**. No fixed upstream
retention or erasure guarantee is asserted. Native prompt versions are retained
in this installation; revocation stops release and preserves existing evidence.
Real carrier recordings remain in the carrier account under its independently
configured retention and deletion controls. This slice performs no remote erase.
An operating media or live-model rollout must qualify the original HND-048
custody requirements before it can be counted complete.

Conservative default adopted pending ct: the existing direct speech operation
uses only the exact OpenAI speech endpoint, and carrier prompt playback requires
an expiring current-source test capability. Other model destinations and
permanent prompt playback addresses receive no data from these doors.

## Acceptance coverage

- `tests/handset-prompts.mjs`, “Uploaded, browser-recorded, phone-recorded and
  Spanish speech prompts are refused, previewed, approved, pinned and kept
  through rollback”: valid authoring plus malformed and truncated WAV refusal.
- Same file, “A signed Gather test call plays each pinned variant and dials an
  extension mid-greeting or a directory name”: valid playback, tampered address,
  expiry, source revocation and refusal to revive old playback after reconsent.
- `tests/handset-media-privacy.mjs`, “Prompt media refuses hostile redirects and
  cross-origin writes without leaking private bindings or reading audio after
  revocation”: actual prompt, source-settings and signed recording doors; exact
  transport credentials, redirect refusal, bad media, source withdrawal during
  readback and planted private-binding absence from responses, native storage and
  ordinary audit exports. An undeclared speech destination gets no request.
- `tests/handset-transports.mjs`, “Signed call status reordering preserves one
  canonical call and every original event without repeating work”: signed MMS
  malformed and foreign-origin references refuse, valid metadata is retained
  without fetching media, and call events preserve existing replay behavior.
- `tests/handset-console-browser.mjs`, “prompts console at 1440” and “prompts
  console at 390”: upload refusal, successful native authoring, source settings,
  cross-origin refusal without changing source authority, explicit revocation
  and retained revoked history. Controls have visible text; audio and date
  controls use native browser semantics.

Remaining acceptance: installation-local encrypted credential custody and
settings rotation of carrier, webhook and SIP credentials during queued real
calls; supported TLS and SRTP with PSTN limitations; complete external-flow
activation policy and qualified US custody, retention and erasure; live models
receiving only consented audio with paused intervals excluded; and a populated
portable archive proved to carry no secret or active authority. Ordinary audit
export proof does not substitute for installation portability.

A local public-command probe used `rer export --output exports/media-security.rer`
after creating a real prompt draft, case and scoped application credential in
`rer dev`. The 352217-byte archive had one prompt, one version, one case and
one grant; no native session row or private session, installation or setup key
was present. The grant remained unrevoked in the archive. This is direct
private-configuration exclusion evidence, not proof that restore cannot revive
application authority. HND-048 keeps that portable-authority gap.

The integrated native refusal checks also bound private mutation and signed callback bodies while reading, reject duplicate format chunks even when an earlier format code is invalid, and preserve padding on valid odd-length normalized WAV files. Phone greeting requests pin the requesting owner's exact native version and current registered extension. Removing that author's authority refuses provider reads even when the separate source issuer remains authorized. Earlier pending requests without this binding require a fresh request. These points are asserted through `tests/helpers/handset-prompt-security.mjs` in the existing uploaded and recorded prompt registration. Its TTS-specific edge cases also inspect populated runtime logs, responses, prompt storage and the ordinary audit export for planted provider credentials. Provider media failures retain the current main behavior: a fixed 502 response and no draft.
