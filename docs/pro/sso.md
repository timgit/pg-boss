# Single sign-on

`/pro/sso` points the dashboard at any OpenID Connect provider, such as Okta,
Entra, Google, Auth0 or Keycloak. Paste the issuer, the client id and the client
secret. Copy the redirect URI the page shows into your provider. The login page
then gets a **Sign in with…** button.

![The single sign-on page](../images/pro/sso.webp){.light-only}
![The single sign-on page](../images/pro/sso-dark.webp){.dark-only}

Pro matches people on their **verified** email address. Someone invited here
first who later signs in through your provider lands on the same account, with
the roles they already had. Pro refuses an address your provider hasn't
verified. You choose whether an unknown address becomes a new account, and it's
off by default.

If your provider sends a group claim, you can map its group names onto groups
here. Pro syncs only the groups you name, so a group you maintain by hand is
never emptied because the provider hasn't heard of it.

The issuer must be `https`, except on `localhost`, `127.0.0.1` or `[::1]`, where
Pro accepts `http`. That lets you try the whole round trip against a provider
running in a container on your own machine before you point Pro at the real one.
