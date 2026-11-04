# Accounts and groups

Pro authenticates each person with their own account. On first run it has no
accounts, so open the setup link Pro prints to its log and create the first
administrator (see [install](./install.md)). That page closes for good the
moment the first account exists. After that, sign in at `/login`,
and sign out from the account menu (the picture or initials at the top right).

Accounts, sessions and role assignments live in Pro's own schema, `pgboss_pro`
by default. It sits in the first configured database, unless
`PGBOSS_PRO_DATABASE_URL` says otherwise. The server creates and migrates it at
startup. It's separate from the `pgboss` schema the queue uses, so nothing here
touches the job tables.

[Roles and access](./roles.md) lists what each role may do.

## Managing accounts

A [global admin](./roles.md#global-admin) manages accounts at
`/pro/accounts`, under **Settings** in the sidebar. An admin on a single
database doesn't get this screen, because it would let them widen their own
grant.

The list holds people and [service accounts](./api-tokens.md) together. **All**,
**People** and **Service accounts** narrow it to one kind, and **Add** creates
either. The search box keeps the accounts whose email, service account name or
person's name holds the text, and the counts on the tabs follow it. **In group** keeps one
group's members. **Role on** picks a database, and the list then shows who can act on it
and why. See [access by database](./roles.md#access-by-database).

![The accounts page](../images/pro/accounts.webp){.light-only}
![The accounts page](../images/pro/accounts-dark.webp){.dark-only}

From there, add a person with a role. Their own page says under their name what they can do on each
database, from their direct roles and their groups together. **Role on** in the list shows which
grant each comes from. **Activity**, after the date the account was added, opens the
[audit log](./audit-log.md) filtered to what it did. The page also shows:

- **Direct roles**: the roles granted to the account itself. Grant and remove them here. When a
  direct role adds nothing a group already gives, the page says so.
- **Groups**: the groups it's in, with what each grants. Add it to a group or take it out here.
- **Signing in**: set a password, or create an invitation link that lets the person choose one. It
  also says how many browsers the account is signed in on and where it was last seen. **Sessions**
  lists each browser with where it signed in from and when, and links to the account's sign-in
  history in the audit log: every sign-in, failed attempt and sign-out. **Sign out everywhere** ends
  every session.

Edit its name here too, or disable or delete the account. Disabling, deleting or changing a
password ends that account's sessions immediately. An open invitation link stops working when the
account is disabled, its password is set or changed another way, or the person signs in by SSO.

Failed sign-ins lock for fifteen minutes. Five failures against an account from one client
address in fifteen minutes lock that account from there, and five from one client address lock
it for every account. An account is locked from everywhere only after twenty failures, so a
stranger can't lock someone out of their own account in a few tries. The account's page shows
that lock, and a global admin can clear it there.

Machines get [service accounts](./api-tokens.md) instead, in the same list. A service account
acts only through API tokens.

![An account's page](../images/pro/account.webp){.light-only}
![An account's page](../images/pro/account-dark.webp){.dark-only}

Pro always refuses two changes, and says so:

- removing the last global admin who can sign in (with a password or by SSO), by demotion,
  disabling or deletion, because nobody would be left to undo it
- a global admin disabling or deleting their own account (another global admin can do that)

Pro sends no invitation email, because it runs inside the organization's network and may have
no mail credentials. A global admin sends the invitation link, or sets the
first password and hands it over. The person then changes it at `/pro/profile`,
from **Profile** in the account menu at the top right. That page needs no role.
It shows who is signed in and what that account may do, and takes the current
password, a new one, and the new one again. Changing the password there signs out
every other session and keeps the current one.

## Groups

An account can hold a role directly, or through a group that holds one. Groups
live at `/pro/groups`, where the search box keeps the groups whose name or
description holds the text. Give a group a role on a database (or on all
databases) and add people with **Add people**, by searching for a name or address
or by pasting a list of addresses, and every member has that role. Where two roles apply to the same database, the person may do everything
either allows, as [Roles](./roles.md) explains. A group's page lists its
members ten at a time, with a search and a way to remove each one. **View in Accounts** opens the
Accounts list filtered to the group, with each member's roles and when they were last active, and
**History** opens the audit log filtered to the group's changes. When
[SSO](./sso.md) maps a provider group to it, the page names that group too. Service accounts can't join a group.

![A group's page](../images/pro/group.webp){.light-only}
![A group's page](../images/pro/group-dark.webp){.dark-only}
