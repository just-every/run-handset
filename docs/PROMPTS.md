# Greetings, prompts and extension dialing

HND-087 remains partial. Current native owners open **Queues → Greetings and
prompts** at `/app/prompts`. The same owner-only API is `/api/handset/prompts`.

## Authoring

A prompt has a name, a use (main attendant, menu, queue, holiday or after hours)
and a shared flag. Each prompt holds numbered, immutable **versions**. A version
records its source, language (English or Spanish), schedule variant (business
hours, holiday, after hours or always), optional effective dates, author, content
hash, duration and original audio format. Sources:

- **Audio file upload.** A PCM16 or mu-law WAV file up to 3 MB and between 0.3 and
  120 seconds. Anything else (another codec, a truncated file, a too short or too
  long clip) is refused and never becomes a version.
- **Browser microphone.** The page records PCM16 audio with the browser's own
  microphone permission and uploads it as WAV.
- **Text to speech.** English or Spanish text of up to 1000 characters goes to the
  official OpenAI speech request schema (model, input, voice, instructions and
  response format) on the direct AI transport. Without that transport the request
  is refused; nothing is invented.
- **Record by phone.** See below.

Every source is normalized to the carrier format: 8 kHz, mono, 8-bit mu-law in a
WAV container, which Twilio plays directly. A version starts as a draft. The owner
plays it, marks the exact audio hash previewed, then approves that exact version
with `approve this exact prompt version`. Approval never changes a published flow.

## Pinning

A flow step other than hours may carry `prompt` with `promptId` and `versionId`.
A flow draft that pins a version which is not approved is refused. Pins are part
of the immutable flow version, so approving a newer version of a shared prompt
changes nothing until a new flow version pins it and goes through the normal tests
and exact publication approval. Rollback restores the earlier flow version and the
exact prompt versions it pinned. `GET /api/handset/prompts/pins/<flow version>`
lists the pinned versions, and a flow evaluation reports the pins on its path. A
dated override entry is a root of the graph, so a holiday step reachable only on
its date validates and is covered by its own test path.

## Record by phone

A request names a prompt, an active source and a destination. The destination must
be an active extension that **the requesting author owns**, so an arbitrary
recipient can never be recorded; any other destination is refused. The server
issues a one-time six digit code, shown once and stored only as a keyed hash. The
signed carrier door verifies the account, called number and business number,
asks for the code (three tries), records, reads the recording resource back and
requires it to belong to that exact call before creating a draft version. This
server places no callback itself: the call that reaches the door needs a qualified
carrier route and a controlled receiver.

## Extensions and directory

Owners register extensions of three to five digits for active people, each with a
directory name and a destination number. The directory keys on the last word of the
name. Rings go to the registered destination only; HND-078 personal answering
rules are not applied and remain missing.

At the signed Gather door (`/providers/twilio/prompts/tests/...`) the greeting is
played inside a Gather, so digits count during the audio. Documented rules:

- The caller has three seconds between digits; `#` ends entry early.
- Exactly one digit is a menu key (1 to 9, and 0 for a tenth destination).
- Three to five digits are an extension. Two digits, or an unknown extension, never
  ring anyone and replay the step; the third failed entry hangs up.
- `*` starts the directory: the caller types the first letters of the last name on
  the keypad, with `*` then the digits inline or after a prompt. One match rings.
  Several matches are read aloud, one key each.

A test call is requested by an owner for one flow version, one source and an
explicit instant. It is signed, bound to the first call it sees, and expires in 15
minutes. It publishes nothing and routes no live call. Each carrier step is
retained as an event.

Carrier audio addresses bind that test and its exact approved prompt version.
Every fetch rechecks test expiry and current source authority, and audio is
served with no-store. Revoking a source withdraws previously issued addresses;
fresh source consent requires a fresh test and never revives old playback.
The current media flows, fixed speech destination and unqualified custody
boundaries are declared in `docs/MEDIA-SECURITY.md`.

## What is not proved here

Real audible test calls, real record-by-phone calls and real ringing of the
registered destination need a carrier number and controlled receivers. HND-078
personal rules, HND-006 live schedule routing and HND-027 role scoping remain with
their clauses.
