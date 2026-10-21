Your whole Handset installation can be saved to one archive file and restored from it. Keep a backup before you reset
an installation or move it to another computer.

## Back up

Stop Handset first, so nothing writes while the archive is made. From the `run-handset` folder:

```sh
rer dev --stop
rer export --output exports/handset.rer
```

`rer export` saves every record to `exports/handset.rer` with an integrity receipt. It leaves out sign-in, private
settings and other state that belongs to this computer only. A large installation takes a while; the command prints a
line every few seconds with the parts done and the time left.

Keep the archive somewhere safe: it holds your installation's records.

## Restore

A restore goes into an empty installation only. To restore into the same folder, reset it first, then import, then
set the owner up again:

```sh
rer reset --yes
rer import --input exports/handset.rer --yes
rer setup --owner-email you@example.com
rer dev
```

`rer reset` removes this installation's local data and settings and keeps the source, the dependencies and your
`exports/` folder; it refuses while Handset is running. `rer import` checks the archive and restores it; if it
stops part way, run the same command again and it starts over cleanly. `rer setup` makes you the owner again, since
the archive never carries sign-in. Then `rer dev` starts the restored Handset.

## What a backup is not

The archive is a copy of one installation for the same Handset. It is not an export for other phone systems and it
cannot be uploaded anywhere in the app.
