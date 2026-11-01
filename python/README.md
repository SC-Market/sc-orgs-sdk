# sc-orgs-sdk (Python)

A typed Python client for the [SC Orgs](https://sc-orgs.space) public API, with webhook signature verification. It has no dependencies (standard library only) and needs Python 3.8 or later.

```python
import os
from sc_orgs_sdk import ScOrgsClient, construct_event

sco = ScOrgsClient(os.environ["SCO_API_KEY"])   # sco_live_… (Manage → API)
org = sco.get_me()["organization"]["sid"]
for m in sco.iter_members(org):
    print(m["rsi_handle"])

# In your webhook handler: the raw body bytes, exactly as received.
event = construct_event(os.environ["SCO_WEBHOOK_SECRET"], headers, raw_body)
```

- Every operation of the public API v1, with responses typed as generated `TypedDict`s. `iter_…` methods fetch every page for you.
- On 429 and 503, the client waits `Retry-After` and retries (`max_retries=3`, `max_retry_delay=60`). Otherwise it raises `RateLimitError`.
- `verify_webhook()` and `construct_event()` check Standard Webhooks signatures the way the SC Orgs server makes them. That includes the two signatures sent during a secret rotation and the 5-minute timestamp window.
- `bearer(key)` and `auth_headers(key)` build the header for your own HTTP client.

Docs: [Developers](https://sc-orgs.space/developers) · [API guide](https://sc-orgs.space/guides/public-api) · [OpenAPI spec](https://api.sc-orgs.space/api/v1/openapi.json) · [Source and examples](https://github.com/SC-Market/sc-orgs-sdk). MIT-licensed.
