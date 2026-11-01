# Test fixtures

Tests never call the live API; they replay these files through a fake `fetch`.

- `me.json`, `members-page*.json`, `events.json`, `org-not-found.json` and `unauthorized.json` were
  recorded from the live API on 2026-11-01 with the public sandbox key (the ~SANDBOX test org).
- `webhook-signed.json` was signed by the SC Orgs backend's own signing code
  (`backend/src/services/webhooks/signing.ts`), with two secrets as during a rotation.
