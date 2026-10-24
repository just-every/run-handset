Handset runs on your own computer: you own the copy, the data and the code. Starting it takes one line.

## Start Handset

Open a terminal and run:

```sh
curl -fsSL https://runeditrun.com/install.sh | sh -s -- dev just-every/run-handset
```

Git is required; rer brings Node and pnpm. Already have Node 22 or later? This does the same:

```sh
npx -y @runeditrun/rer dev just-every/run-handset
```

The installer edits none of your shell files. If it ends with a line to run, run it too: it puts `rer` on your PATH
for this terminal and for new ones. Handset runs on macOS, Linux, or Windows with WSL2.

## What the line does

`rer` clones Handset into a folder named `run-handset`, installs its dependencies, makes you the owner of this
installation and starts it. A first start can take several minutes and prints a progress line at least every 30
seconds. If the command is interrupted, run it again: it picks up where it stopped.

When Handset is ready, `rer` prints two lines:

- `RER_READY` and the address Handset answers on, on this computer only.
- `RER_OPEN` and a private link. Open it on this computer and Handset opens signed in as you, the owner. Treat the
  link like a password: anyone who has it can sign in as you.

## Finish setup

The first time you open Handset it shows **Finish setup**. Make sure the owner's name and email are right, check
**I confirm this owner account is ready to use** and choose **Finish setup**. Until you do, Handset sends you back to
this page. You can correct your name here.

## The front page

The installed Handset's front page is its Lobby: the Handset mark and one button. Before setup is finished the
button reads **Finish setup**; after, it reads **Sign in**. The Lobby is the same for every visitor and shows nothing
about your installation beyond that.

## Start it again, and stop it

To start Handset again later, run the same line from the folder you started it in, or:

```sh
cd run-handset && rer dev
```

In a terminal, `rer dev` stays in the foreground: press Ctrl-C to stop it. Started from a script or an agent's
shell, it returns once Handset is ready and keeps running; stop it from the `run-handset` folder with:

```sh
rer dev --stop
```

A Handset nobody has used for 12 hours stops by itself.
