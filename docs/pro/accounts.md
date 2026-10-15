# Accounts and groups

Pro authenticates people, not the deployment. On first run it has no accounts,
so open `/setup` and create the first administrator; that page closes for good
the moment the first account exists. After that, sign in at `/login`, and sign
out from the account menu, your picture or initials at the top right.

Accounts, sessions and role assignments live in Pro's own schema: `pgboss_pro`
by default, in the first database you configured unless
`PGBOSS_PRO_DATABASE_URL` says otherwise. It is created and migrated when the
server starts, and it is separate from the `pgboss` schema the queue uses:
nothing here touches your job tables.

What each role may do is on [Roles and access](./roles.md).

## Managing accounts

An administrator whose role covers **every** database manages accounts at
`/pro/accounts`, under **Settings** in the sidebar. An admin scoped
to a single database does not get this screen: it would let them widen their own
scope.

From there: add an account with a role, change or remove a role per database,
set a password, disable an account, or delete it. Disabling, deleting or changing
a password ends that account's sessions immediately.

Two changes are always refused, and both say so:

- removing the last administrator who covers every database, by demotion,
  disabling or deletion: there would be nobody left who could undo it
- disabling or deleting your own account: another administrator can

There is no invitation email. Pro runs inside your network and has no mail
credentials, so an administrator sets the first password and hands it over: and
the person changes it themselves at `/pro/profile`, reached from **Profile** in the
account menu at the top right. That page needs no role: it shows who you are and what you may
do, and takes your current password, a new one, and the new one again. Changing
it signs out every other session, and keeps the one you are using.

## Groups

An account can hold a role directly, or through a group that holds one. Groups
live at `/pro/groups`: give a group a role over a database (or over every
database), put people in it by pasting their addresses, and everyone in it has
that role. Where two roles apply to the same database, the stronger wins.

`/pro/access` answers the question that actually gets asked in an incident: who
can act on this database, and why: showing the role each person ends up with
beside every grant that produced it.
