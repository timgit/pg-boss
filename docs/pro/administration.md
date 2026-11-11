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

Pro encrypts each app's connection, SMTP passwords, API keys, webhook URLs, signing secrets and
Authorization headers, PagerDuty integration keys and the OIDC client secret
before it stores them. 

The encryption key should be in the `PGBOSS_PRO_SECRET_KEY` environment variable, and it has to be at least 32 characters. Without the key, Pro logs an error at startup and serves no pages. Pro never writes a secret in the clear and never sends a stored secret back to the browser. In the browser, a secret is masked as bullets in place of the stored value. Saving a form with the bullets untouched keeps the stored secret.

Pro sends a stored secret only to the server it was entered for. Pro asks for the secret again when
one of these changes:

- a webhook's host
- the SMTP server or user
- the SSO issuer or client id

Without the key it was encrypted with, Pro can't read a stored secret. After a lost key, enter every
secret again, including each app's connection.
