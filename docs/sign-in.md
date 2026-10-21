Handset signs people in with its own email links: there are no passwords to keep, and nothing is shared with
another sign-in service.

## On this computer

When you start Handset with `rer dev`, it prints a private `RER_OPEN` link. Open it on this computer and Handset
opens signed in as the owner, on the Finish setup page until setup is done. The link holds this checkout's private
key, so open it only on this computer and share it with no one.

Each new browser profile on this computer opens the `RER_OPEN` link once before it can sign in. While you run
Handset this way it sends no email at all.

## By email

A Handset set up with a mail provider signs people in by email. Open `/signin`, enter your email and choose
**Email a sign-in link**. Handset sends a link to that mailbox. The link:

- works once, then stops working;
- expires after 15 minutes;
- asks you to confirm on the page it opens before it signs you in, so a mail scanner opening it signs no one in.

An email address that is not one of the installation's people gets the same answer on the page and no email.

## How long you stay signed in

A sign-in lasts seven days from when it starts, and is not extended by using Handset. After that, sign in again.

## Sign out

Choose **Sign out** in Handset. Signing out ends that session on the server, so a copy of its cookie kept anywhere
else stops working too.
