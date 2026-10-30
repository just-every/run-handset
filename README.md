<img src="public/brand/mark.svg" width="72" height="72" alt="">

# Handset

Free, open source business phone system and cloud contact center.

100% free, open source alternative to RingCentral, Zoom Phone and Dialpad.
Homepage and docs: [run-handset.com](https://run-handset.com).

Handset is a new seed. This checkout contains the Base technical foundation:
the Lobby, owner sign-in, local development and a static run site. Phone-system
and contact-center capabilities are targets, and none is implemented yet.
Read [CONTRACT.md](CONTRACT.md) and [ACCEPTANCE.md](ACCEPTANCE.md) for the target
and its missing acceptance evidence. The run site's `/contract` page renders the
root contract through Base's shared parser.

## Run locally

```sh
curl -fsSL https://runeditrun.com/install.sh | sh -s -- dev just-every/run-handset
```

Git is required; rer brings Node and pnpm. Already have Node 22 or later?
`npx -y @runeditrun/rer dev just-every/run-handset` does the same. To start
again: `cd run-handset && rer dev`.

The installed `/` is the Base Lobby. Local development signs you in through the
private link printed by rer; complete the foundation's first-run setup at
`/setup`. Development mail is suppressed. There are no product records or
carrier connections. See [RUN-LOCALLY.md](RUN-LOCALLY.md) for local operations.

The checkout pins Node 22.20.0, pnpm 10.12.4 and `@runeditrun/rer` 0.2.94.
The CLI is consumed as a package; `src/base` and the adopted runtime modules are
editable copies of the Base foundation pinned in `edition.json` and
`base-copies.json`.

## Commands

```sh
rer check --profile first-party
rer build
pnpm run typecheck
pnpm run test:runtime
rer build --site
```

GitHub Verify runs the foundation's sharded verification. The separate Run site
workflow deploys `run-handset.com` through the `run-site` environment when
`RUN_SITE_DEPLOY=true`. Its `/run` page explains local installation.

MIT licensed. Source: [just-every/run-handset](https://github.com/just-every/run-handset).

Run Handset: https://run-handset.com/run
