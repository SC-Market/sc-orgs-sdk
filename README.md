# SC Orgs SDK

Typed clients for the [SC Orgs](https://sc-orgs.space) public API, with webhook signature verification, for TypeScript/JavaScript (`@sc-orgs/sdk`) and Python (`sc_orgs_sdk`). SC Orgs is a hub for Star Citizen organizations: rosters, roles, events and RSVPs.

- **Developers page (scopes, webhooks, error codes):** https://sc-orgs.space/developers
- **API guide:** https://sc-orgs.space/guides/public-api
- **OpenAPI spec:** https://api.sc-orgs.space/api/v1/openapi.json

The SDK and the API are free to use.

## What's covered

Everything in the public API v1 (`https://api.sc-orgs.space/api/v1`), generated from the OpenAPI spec:

| Method | Endpoint | Scopes |
| --- | --- | --- |
| `getMe()` | `GET /me` | any key |
| `getOrganization(org)` | `GET /orgs/{org}` | `org:read`, or no key for the public view |
| `listMembers(org)`, `iterateMembers(org)` | `GET /orgs/{org}/members` | `members:read` |
| `getMember(org, member)` | `GET /orgs/{org}/members/{member}` | `members:read` |
| `listRoles(org)` | `GET /orgs/{org}/roles` | `roles:read` |
| `listEvents(org)`, `iterateEvents(org)` | `GET /orgs/{org}/events` | `events:read`, or no key for public events |
| `getEvent(org, id)` | `GET /orgs/{org}/events/{event_id}` | `events:read`, or no key for a public event |
| `listRsvps(org, id)`, `iterateRsvps(org, id)` | `GET /orgs/{org}/events/{event_id}/rsvps` | `events:read` + `rsvps:read` |

`org` is the org's RSI SID, for example `~SANDBOX`. Python uses the same names in snake_case (`get_me()`, `iter_members()`…). The `from` query parameter of `list_events` is `from_` in Python.

It also covers webhooks: `verifyWebhook()`, `constructEvent()` and `signWebhook()`, which implement [Standard Webhooks](https://www.standardwebhooks.com/) in the same way as the SC Orgs server.

## Quick start: TypeScript / JavaScript

Node 18 or later, or any runtime with `fetch` and Web Crypto (Deno, Bun, Cloudflare Workers). The package has no runtime dependencies, and it ships both ESM and CommonJS builds.

```sh
npm install @sc-orgs/sdk   # once it's published; until then, see "Use it before it's on npm"
```

```ts
import { ScOrgsClient, ApiError } from "@sc-orgs/sdk"

// An org API key from Manage → API on sc-orgs.space. Keep it on a server.
const sco = new ScOrgsClient({ token: process.env.SCO_API_KEY })

const { organization } = await sco.getMe() // the key's org
for await (const member of sco.iterateMembers(organization.sid)) {
  console.log(member.rsi_handle, member.roles.map((r) => r.name))
}

const { events } = await sco.listEvents(organization.sid, { status: "upcoming" })

// Without a key: public orgs and public events only.
const anon = new ScOrgsClient()
```

You can try it without an account: the developers page publishes a read-only sandbox key, exported as `SANDBOX_KEY`. It only sees the `~SANDBOX` test org (`SANDBOX_ORG`).

**Bearer auth helper.** `bearer(key)` returns the `Authorization` header value and `authHeaders(key)` returns the headers object, for use with your own HTTP client. Both throw on anything that isn't an `sco_live_` or `sco_test_` key.

**Options:** `new ScOrgsClient({ token, baseUrl, fetch, maxRetries, maxRetryDelay, timeout, headers, onRetry })`.

### Webhooks

```ts
import { constructEvent, WebhookVerificationError } from "@sc-orgs/sdk"

// body: the raw request body (string or bytes), exactly as received. Not parsed JSON.
const event = await constructEvent(process.env.SCO_WEBHOOK_SECRET, request.headers, body)
// event: { id, type, api_version, occurred_at, organization: { id, sid }, data }
```

Each delivery carries three headers: `webhook-id` (the same on redeliveries, so use it as your idempotency key), `webhook-timestamp` and `webhook-signature`. The signature is `v1,` followed by the base64 HMAC-SHA256 of `{id}.{timestamp}.{body}`, keyed with the base64-decoded part of your `whsec_` secret. While a secret is being rotated, both secrets sign, separated by a space, and one match is enough. Timestamps more than 5 minutes off are refused. The comparison runs in constant time.

The event types are `member.joined`, `member.left`, `member.roles_updated`, `event.created`, `event.updated`, `event.cancelled`, `event.starting` and `ping` (the Send test button). See the developers page for each type's `data`.

## Quick start: Python

Python 3.8 or later. The package uses only the standard library.

```sh
pip install sc-orgs-sdk   # once it's published; until then: pip install ./python
```

```python
import os
from sc_orgs_sdk import ScOrgsClient, construct_event

sco = ScOrgsClient(os.environ["SCO_API_KEY"])
org = sco.get_me()["organization"]["sid"]
for m in sco.iter_members(org):
    print(m["rsi_handle"])

event = construct_event(os.environ["SCO_WEBHOOK_SECRET"], request_headers, raw_body)
```

Responses are plain dicts, typed with `TypedDict`s generated from the spec.

## Rate limits and retries

| Bucket | Limit |
| --- | --- |
| Per key | 120 requests a minute, bursts of 30 |
| Per org (all its keys together) | 600 requests a minute |
| Anonymous (no key), per IP address | 60 requests a minute, bursts of 20 |
| Invalid keys, per IP address | 20 per 15 minutes, then 429 |
| Webhook test sends, per webhook | 10 an hour |

On a `429` or `503`, the clients wait the number of seconds in `Retry-After` and retry, up to `maxRetries` times (3 by default). If `Retry-After` is longer than `maxRetryDelay` (60 seconds by default), they don't sleep: they throw a `RateLimitError`, so a script never hangs. The API is read-only, so retries are always safe. Other errors throw `ApiError` with the API's `code` (`INSUFFICIENT_SCOPE`, `KEY_EXPIRED`, `NOT_FOUND`…), `message` and `details`.

## Examples

Build once first (`npm install && npm run build`). After that, the examples import `@sc-orgs/sdk` from this checkout.

- [`examples/list-members-and-events.mjs`](examples/list-members-and-events.mjs) lists your org's members and its next events. Without `SCO_API_KEY`, it runs against the sandbox.
- [`examples/express-webhook.mjs`](examples/express-webhook.mjs) verifies webhook signatures in an Express handler (`npm install express` first). It listens on 127.0.0.1 by default, so put a TLS reverse proxy or tunnel in front of it.
- [`python/examples/list_members_and_events.py`](python/examples/list_members_and_events.py) and [`python/examples/webhook_server.py`](python/examples/webhook_server.py) are the same in Python, with the standard library only.

## Regenerating when the API changes

```sh
npm run generate:check   # exit 1 if the live spec differs from openapi/
npm run generate         # fetch the live spec, update openapi/ and regenerate
npm test                 # build + TypeScript tests
cd python && python3 -m unittest discover -s tests   # Python tests
```

`npm run generate` rewrites `src/generated/*` and `python/src/sc_orgs_sdk/_types.py` and `_operations.py`. Don't edit them by hand. Webhook payloads aren't in the spec, so `src/webhooks.ts` and `python/src/sc_orgs_sdk/webhooks.py` are written by hand. If the server's signing changes (`backend/src/services/webhooks/signing.ts`), update both, and re-sign `test/fixtures/webhook-signed.json` with the server's code. The generator is `scripts/lib/codegen.mjs` (no dependencies), shared with [sc-market-sdk](https://github.com/SC-Market/sc-market-sdk).

Tests replay recorded fixtures from `test/fixtures/` and never call the live API.

## Publishing (maintainers)

Nothing is published automatically, and there is no CI. To release:

1. Bump the version in `package.json`, `python/pyproject.toml` and `python/src/sc_orgs_sdk/_version.py`.
2. `npm run generate:check`, then `npm test` and the Python tests.
3. **npm:** log in with `npm login`, as an account in the `@sc-orgs` npm organization (create the org first if it doesn't exist). Check the contents with `npm pack --dry-run`, then run `npm publish --access public`.
4. **PyPI:** `cd python && python3 -m pip install --upgrade build twine && python3 -m build && python3 -m twine upload dist/*`. The username is `__token__`, and the password is a PyPI API token.
5. Tag the release: `git tag v0.1.0 && git push --tags`.

### Use it before it's on npm

Clone this repo and run `npm install && npm run build && npm pack`. Then, in your project, run `npm install /path/to/sc-orgs-sdk-0.1.0.tgz`. For Python: `pip install ./python`.

## Licence

MIT (see [LICENSE](LICENSE)). Star Citizen® is a registered trademark of Cloud Imperium Rights LLC. SC Orgs is an unofficial fan site, not affiliated with the Cloud Imperium group of companies.

---

[SC Orgs](https://sc-orgs.space) · [Developers](https://sc-orgs.space/developers) · [Guides](https://sc-orgs.space/guides) · Sister site: [SC Market](https://sc-market.space)
