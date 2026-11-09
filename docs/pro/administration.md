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

Pro encrypts SMTP passwords, API keys, webhook URLs, signing secrets and
Authorization headers, PagerDuty integration keys and the OIDC client secret
before it stores them. The encryption key comes from `PGBOSS_PRO_SECRET_KEY`:

```bash
PGBOSS_PRO_SECRET_KEY="$(openssl rand -base64 32)"
```

The key must be at least 32 characters, since a shorter key can be guessed from a copy of the
database. Without the key, the screens that keep secrets refuse to save them and show why.
The key has to be set before anyone adds a webhook or PagerDuty destination.
Pro never writes a secret in the clear, and never sends a stored secret back to
the browser. The fields show bullets. Saving without touching them keeps
what's there, unless what the secret is sent to changed: a webhook's host, the
SMTP server or user, or the SSO issuer or client id. Pro then asks for the secret
again. A stored secret only ever goes where it was entered for. Losing the key means re-entering those secrets. Nothing else
is lost.
