"""SC Orgs webhooks: Standard Webhooks signatures (https://www.standardwebhooks.com/),
matching the server (backend/src/services/webhooks/signing.ts)::

    webhook-id:        msg_...       unique per event and webhook; your idempotency key
    webhook-timestamp: 1793145600    unix seconds
    webhook-signature: v1,<base64(HMAC-SHA256(secret bytes, "{id}.{timestamp}.{body}"))>

The secret is ``whsec_`` + base64 of 32 bytes; the HMAC key is the decoded bytes.
During a secret rotation both secrets sign, space-separated. Timestamps more than
5 minutes off are refused. Verify the raw body exactly as received.
"""

import base64
import binascii
import hashlib
import hmac
import json
import time
from typing import Any, Dict, Mapping, Optional, Union

SECRET_PREFIX = "whsec_"
WEBHOOK_TOLERANCE_SECONDS = 5 * 60

Body = Union[str, bytes, bytearray]


class WebhookVerificationError(Exception):
    pass


def _header(headers: Mapping[str, Any], name: str) -> Optional[str]:
    getter = getattr(headers, "get", None)
    for k, v in headers.items():
        if k.lower() == name:
            return v[0] if isinstance(v, (list, tuple)) else v
    return getter(name) if getter else None


def _mac(secret: str, msg_id: str, timestamp: Union[int, str], body: Body) -> bytes:
    if not isinstance(secret, str) or not secret.startswith(SECRET_PREFIX):
        raise TypeError("Webhook secrets start with " + SECRET_PREFIX)
    key = base64.b64decode(secret[len(SECRET_PREFIX):])
    raw = body.encode("utf-8") if isinstance(body, str) else bytes(body)
    return hmac.new(key, ("%s.%s." % (msg_id, timestamp)).encode("utf-8") + raw, hashlib.sha256).digest()


def sign_webhook(secret: str, msg_id: str, timestamp: int, body: Body) -> str:
    """The ``webhook-signature`` value for a body: for testing your own receiver."""
    return "v1," + base64.b64encode(_mac(secret, msg_id, timestamp, body)).decode("ascii")


def assert_valid_webhook(secret: str, headers: Mapping[str, Any], body: Body, tolerance: int = WEBHOOK_TOLERANCE_SECONDS, now: Optional[float] = None) -> None:
    """Raises WebhookVerificationError saying why a delivery doesn't check out."""
    msg_id = _header(headers, "webhook-id")
    ts_raw = _header(headers, "webhook-timestamp")
    sigs = _header(headers, "webhook-signature")
    if not msg_id or not ts_raw or not sigs:
        raise WebhookVerificationError("Missing webhook-id, webhook-timestamp or webhook-signature header")
    try:
        ts = int(ts_raw)
    except ValueError:
        raise WebhookVerificationError("Invalid webhook-timestamp")
    if abs((time.time() if now is None else now) - ts) > tolerance:
        raise WebhookVerificationError("webhook-timestamp is too old or too far in the future")
    expected = _mac(secret, msg_id, ts, body)
    for entry in sigs.split(" "):
        version, _, value = entry.partition(",")
        if version != "v1" or not value:
            continue
        try:
            got = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError):
            continue
        if hmac.compare_digest(got, expected):
            return
    raise WebhookVerificationError("No matching signature")


def verify_webhook(secret: str, headers: Mapping[str, Any], body: Body, tolerance: int = WEBHOOK_TOLERANCE_SECONDS, now: Optional[float] = None) -> bool:
    """True when one signature matches and the timestamp is fresh."""
    try:
        assert_valid_webhook(secret, headers, body, tolerance=tolerance, now=now)
        return True
    except WebhookVerificationError:
        return False


def construct_event(secret: str, headers: Mapping[str, Any], body: Body, tolerance: int = WEBHOOK_TOLERANCE_SECONDS, now: Optional[float] = None) -> Dict[str, Any]:
    """Verify, then parse the body: ``{id, type, api_version, occurred_at, organization, data}``."""
    assert_valid_webhook(secret, headers, body, tolerance=tolerance, now=now)
    return json.loads(body if isinstance(body, str) else bytes(body).decode("utf-8"))
