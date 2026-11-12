# Retention and secrets

## Retention

Pro prunes its own store once a minute.

- Pro keeps closed alerts, alert deliveries, finished operations and the status
  page's queue health history for 90 days. A running operation stays however old
  it is.
- Pro keeps the audit log forever unless a global admin sets a number of days
  under **Settings → Audit log**. The shortest is 30 days. Within a minute of
  saving, Pro starts deleting older entries at up to 50,000 a minute. Deleted
  entries can't be recovered. The audit log records the change to this setting
  too.

## Secrets

Pro encrypts each schema's connection, SMTP passwords, API keys, webhook URLs, signing secrets and
Authorization headers, PagerDuty integration keys and the OIDC client secret
before it stores them. 

The encryption key should be in the `PGBOSS_PRO_SECRET_KEY` environment variable, and it has to be at least 32 characters. Without the key, Pro logs an error at startup and serves no pages. Pro never writes a secret in the clear and never sends a stored secret back to the browser. In the browser, a secret is masked as bullets in place of the stored value. Saving a form with the bullets untouched keeps the stored secret.

Pro sends a stored secret only to the server it was entered for. Pro asks for the secret again when
one of these changes:

- a webhook's host
- the SMTP server or user
- the SSO issuer or client id

### Key changes

Without the key it was encrypted with, Pro can't read a stored secret. Pro reads one key, and
changing the key means entering every secret again.

The first time Pro starts with a key, it stores a check value encrypted with that key. Each start
decrypts the check value. When that fails, Pro tries to decrypt every stored secret and reports only
the secrets that fail. Pro logs them, and every global admin sees a banner on each page that lists
them and where to enter them again:

- each schema's connection, in Settings › Schemas
- each destination's secrets, in Settings › Destinations
- the email server's password or API key, in Settings › Email
- the SSO client secret, in Settings › SSO

Settings › Schemas, Settings › Destinations and Settings › Email mark each secret that doesn't decrypt. Until it's
entered again, Pro doesn't monitor the schema, and the destination can't send. A delivery that fails
for that reason names the secret and isn't retried. SSO sign-in fails until the client secret is
entered again, and password sign-in keeps working. Restarting Pro with the earlier key also brings
the secrets back.

A check value that fails while every stored secret decrypts is stored again with the current key,
and Pro reports nothing. After each save in Settings › Schemas, Destinations or SSO, Pro tries every
stored secret again. Once every stored secret decrypts, Pro stores the check value again with the
current key and the banner goes.
