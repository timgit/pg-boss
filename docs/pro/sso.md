# Single sign-on

`/pro/sso` points the dashboard at any OpenID Connect provider, such as Okta,
Entra, Google, Auth0 or Keycloak. Paste the issuer, the client id and the client
secret. Copy the redirect URI the page shows into the provider. The login page
then gets a **Sign in with…** button.

![The single sign-on page](../images/pro/sso.webp){.light-only}
![The single sign-on page](../images/pro/sso-dark.webp){.dark-only}

Pro matches people on their **verified** email address. Someone invited here
first who later signs in through the provider lands on the same account, with
the roles they already had. Pro refuses an address the provider hasn't
verified. A setting lets an unknown address become a new account, and it's off
by default.

If the provider sends a group claim, this page maps its group names onto Pro
groups. Pro syncs only the mapped groups, so a group kept by hand is never
emptied because the provider hasn't heard of it.

The issuer must be `https`, except on `localhost`, `127.0.0.1` or `[::1]`, where
Pro accepts `http`. That allows a full round trip against a provider running
in a local container, before Pro points at the real one.
