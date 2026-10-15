# Retention and secrets

## Retention

Pro prunes its own store once a minute.

- Closed alerts, alert deliveries, finished operations and the status page's
  queue health history are kept for 90 days. An operation still queued or
  running is kept however old.
- The audit log is kept forever unless an administrator sets a number of days
  under **Settings → Audit log**. The shortest is 30 days. Entries older than that
  are deleted within a minute of saving and cannot be recovered. Setting it is
  recorded in the trail.

## Secrets

SMTP passwords, API keys, webhook signing secrets and Authorization headers,
PagerDuty integration keys and the OIDC client secret are encrypted before they
are stored, with a key from the environment:

```bash
PGBOSS_PRO_SECRET_KEY="$(openssl rand -base64 32)"
```

Without it, the screens that keep secrets refuse to save them and say so.
Nothing is ever written in the clear, and no secret is sent back to the browser
once stored: the fields show bullets, and saving without touching them keeps
what is there. Losing the key means re-entering those secrets, nothing worse.
