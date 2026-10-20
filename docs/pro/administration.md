# Retention and secrets

## Retention

Pro prunes its own store once a minute.

- Pro keeps closed alerts, alert deliveries, finished operations and the status
  page's queue health history for 90 days. It keeps an operation that's still
  queued or running however old it is.
- Pro keeps the audit log forever unless an administrator sets a number of days
  under **Settings → Audit log**. The shortest is 30 days. Pro deletes entries
  older than that within a minute of saving, and they can't be recovered. The
  audit log records the change to this setting too.

## Secrets

Pro encrypts SMTP passwords, API keys, webhook URLs, signing secrets and
Authorization headers, PagerDuty integration keys and the OIDC client secret
before it stores them, with a key from the environment:

```bash
PGBOSS_PRO_SECRET_KEY="$(openssl rand -base64 32)"
```

Without it, the screens that keep secrets refuse to save them and say so, which
means the key has to be set before adding a webhook or PagerDuty destination.
Pro never writes a secret in the clear, and never sends a stored secret back to
the browser. The fields show bullets, and saving without touching them keeps
what's there. Losing the key means re-entering those secrets, and nothing else
is lost.
