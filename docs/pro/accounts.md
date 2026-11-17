# Accounts and groups

Pro authenticates each user with their own account. Users sign out from the account menu
(the picture or initials at the top right).

[Roles and access](./roles.md) lists each role's permissions.

## Managing accounts

Accounts live under **Settings › Accounts** in the sidebar. Only
[global admins](./roles.md#global-admin) see the page. An admin on a single
schema doesn't get this screen, because from it they could widen their own
grant.

The list holds people and [service accounts](./api-tokens.md) together. **All**,
**People** and **Service accounts** narrow the list to one kind. **Add** creates
a person or a service account. A person is added on a page of its own with a first password or an
invitation, which then opens the new account's page. The search box keeps the accounts whose email, service account name or
person's name holds the text. The counts on the tabs follow the search. **In group** keeps one
group's members. **Role on** picks a schema. The list then shows each account with a role on that schema
and the grant the role comes from. See [access by schema](./roles.md#access-by-schema).

![The accounts page](../images/pro/accounts.webp){.light-only}
![The accounts page](../images/pro/accounts-dark.webp){.dark-only}

From there, add a person with a role. An account's page shows under its name the roles its direct grants and groups together
give it on each schema. **Role on** in the list shows which
grant each role comes from. The **Activity** link after the date the account was added opens the
[audit log](./audit-log.md) filtered to the account's actions. The page also shows:

- **Direct roles**: the roles granted to the account itself. Grant and remove them here. When a
  direct role adds nothing a group already gives, the page says so.
- **Groups**: the groups the account is in, with what each group grants. Add the account to a group or take it out here.
- **Signing in**: set a password, or invite the person to choose one. See
  [first password and invitations](#first-password-and-invitations). The section
  also says how many browsers the account is signed in on and the address it was last seen from. **Sessions**
  lists each browser with the address it signed in from and the time, and links to the account's sign-in
  history in the audit log: every sign-in, failed attempt and sign-out. **Sign out everywhere** ends
  every session.

Edit the account's name here too, or disable or delete the account. Disabling, deleting or changing a
password ends that account's sessions immediately. An open invitation link stops working when the
account is disabled, its password is set or changed another way, or the person signs in by SSO.

A session lasts 12 hours from sign-in. It ends sooner after an hour in which the person doesn't
click, type, scroll or open a page. A page that refreshes itself doesn't count, which means a browser
left open on a page is signed out an hour after anyone last used it. Signing in again from a browser
ends the session that browser held before.

Failed sign-ins lock for fifteen minutes. Five failures against an account from one client
address in fifteen minutes lock that account from that address. Five failures from one client address lock
that address out of every account. An account is locked from everywhere only after twenty failures.
That lock passes over a browser that signed in to the account in the last 90 days. A stranger
can't lock someone out of their own account. An IPv6 address counts as its
whole /64, so a client can't get more tries by moving to another address in it. The account's page
shows the lock, where a global admin can clear it.

Machines get [service accounts](./api-tokens.md) instead, which appear in the same list. A service account
acts only through API tokens.

![An account's page](../images/pro/account.webp){.light-only}
![An account's page](../images/pro/account-dark.webp){.dark-only}

Pro always refuses two changes, and says so:

- removing the last global admin who can sign in (with a password or by SSO), by demotion,
  disabling or deletion, because nobody would be left to undo it
- a global admin disabling or deleting their own account (another global admin can do that)

The person changes their password from **Profile** in the account menu at the top right. That page
needs no role. It shows the signed-in account and its roles, and takes the current password and the
new password twice. Changing the password there signs out every other session and keeps the current
session.

## First password and invitations

A person gets their first password in one of two ways:

- **A password**. The global admin sets it and hands it over.
- **An invitation**. Pro makes a link the person opens to choose a password. The link works once,
  for 7 days. Pro stores only the link's hash, which means the page shows the link once, with a
  **Copy** button, right after it's made.

With [Settings › Email](./destinations.md#email) set up, Pro can email the link:

- **Add a person** starts on **Invite**, with **Email the link to this address** checked. Without
  an email server, it starts on **Set a password**, and **Invite** makes a link to copy.
- An account's page has **Send invitation**, which emails a new link to the account's address, and
  **Create invitation link**, which makes a new link and emails nothing.

Either way, the account's page then shows the link with **Copy**, for the global admin to send
another way. When the email isn't sent, the page shows the email server's error. The link
still works. The audit log records each invitation, and each email sent or failed.

A new link replaces the account's open one, which stops working, including in an email already
sent. While a link is open, the account's page asks before making a new one. Each global admin can
email 5 invitations in 15 minutes, and all of them together 20, before invitation emails stop for 15
minutes. Creating a link to copy has no limit.

## Groups

An account can hold a role directly or through a group. Groups
live under **Settings › Groups**, where the search box keeps the groups whose name or
description holds the text. Give a group a role on a schema (or on all
schemas), and every member has that role. **Add people** adds members by searching for a name or address
or by pasting a list of addresses. Where two roles apply to the same schema, the person may do everything
either allows, as [Roles](./roles.md) explains. A group's page lists its
members ten at a time, with a search and a way to remove each member. **View in Accounts** opens the
Accounts list filtered to the group, with each member's roles and last activity.
**History** opens the audit log filtered to the group's changes. When
[SSO](./sso.md) maps a provider group to the Pro group, the page names the provider group too. Service accounts can't join a group.

![A group's page](../images/pro/group.webp){.light-only}
![A group's page](../images/pro/group-dark.webp){.dark-only}
