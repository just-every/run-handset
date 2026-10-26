# Call logs and buyer archives

Open `/app/exports` as a current native owner or admin. Choose a UTC range
(inclusive start, exclusive end), display timezone and optional queue or case
owner. The CSV preserves canonical call and leg IDs, provider IDs, timestamps,
disposition, observed duration, supplied billed units with their provenance,
queue and agent attribution, and consent and recording references. Missing
carrier units are explicit; owner-entered units are labelled unverified. CSV
references grant no access to recording or transcript content. Restricted
supervisors cannot use these export doors.

An owner can schedule one reviewed queue or owner CSV email, with the exact
recipient and timezone shown. Each email requires the explicit sensitive-copy
policy. Due work claims its send durably, repeats current owner authority, and
never retries an uncertain submission. Accepted transport is distinct from
inbox delivery. Revoke a pending schedule to stop future submission; a delivered
email remains in separate recipient custody.

## Buyer-owned archives

In export settings, preview a buyer-controlled Box, Dropbox or Google Drive
folder using a scoped access token. The token is used for that request only;
it is never stored. Use a Box token downscoped to the chosen folder with
base_explorer, base_upload and item_download; a Dropbox app-folder token with
metadata and content read and write; or a Google token with drive.file access
to the selected folder. The owner confirms the independently read destination,
encryption, credential scope and buyer retention deadline.

Prepare the selected recording range for one exact export person. Keep the
64-character lowercase hexadecimal AES-256 key in buyer custody. Handset stores
only its hash and a separate nonce for each file. The owner reviews and approves
the exact destination, selection and person. This approval never grants media
access: each release still needs current independent recording playback and
transcript grants. An unavailable or inaccessible selected recording remains
in the manifest with its reason. Current authority is checked again after
provider content readback and before transfer.

Transfer or resume with the same key and a current scoped destination token.
Stable file identities, independently downloaded ciphertext checksums and an
encrypted checksummed manifest distinguish transferred from verified. A lost
upload response is reconciled by destination lookup and readback, without
creating a second file or manifest entry. A checksum conflict stops transfer.
Revoking the job, connector, owner authority or a content grant stops future
releases. Existing remote copies remain in buyer custody; the buyer enforces
remote retention. The selected retention deadline also bounds native release.

The manifest carries source and call IDs, recording time, selected range,
policy, transcript references, plaintext and ciphertext checksums, file state
and missing-media reasons. Files use AES-256-GCM: the first 12 bytes are the
nonce, followed by ciphertext including the 128-bit tag. Associated data is
the export ID, a colon, then the file key shown in the native archive preview. Keep the key separately
from the destination. Archive preparation is bounded to 2,000 recordings and
the existing per-recording media limit; an exceeded qualification fails
explicitly rather than silently dropping content.

## Buyer OpenSSH transfer

For SFTP, the owner previews and approves the absolute directory, host, port,
SSH user and pinned SHA-256 host-key fingerprint. Transfer runs on the buyer's
machine with `/usr/bin/sftp`; the Worker never holds an SSH identity.

Create a private mode-0600 JSON settings file containing `origin` (the HTTPS
Handset origin), `email`, `jobId`, `encryptionKey`, `identityFile` and
`knownHostsFile`. Request a fresh native email login:

```sh
node ./src/handset/exports/sftp.mjs request-login ./private-settings.json
```

Add `confirmationToken` from that email link to the private settings file,
then run:

```sh
node ./src/handset/exports/sftp.mjs run ./private-settings.json
```

The login creates its own memory-only native session. The command checks the
approved fingerprint, uses only the buyer's private SSH identity, writes a
temporary file followed by rename, independently gets each final file and
compares its digest. Resuming checks existing files before writing. The native
state says `client_verified` because the buyer command supplies the SSH
readback receipt. It never represents that receipt as a Worker-side network
observation. Existing remote copies cannot be recalled by native revocation.

HND-065 and HND-066 retain full installation portability, erasure and local
erasure receipts. HND-032 retains carrier billing reconciliation; exporting
supplied units does not assert carrier invoice settlement.

Proof runs through native routes in `tests/handset-reporting.mjs`, real OpenSSH
against the test SFTP network edge, and the owner browser journey in
`tests/handset-receptionist-browser.mjs` at 1440 and 390. The live SendGrid
journey is `tests/journeys/handset-export-mail.mjs`; it requires held credentials
through the injector and reads the controlled fleet QA mailbox independently.
