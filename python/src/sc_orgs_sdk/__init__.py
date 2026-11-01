"""Typed client for the SC Orgs public API, with webhook signature verification.

https://sc-orgs.space/developers
"""

from ._http import ApiError, RateLimitError, parse_retry_after
from ._types import *  # noqa: F401,F403  (the generated response types)
from ._version import __version__
from .auth import KEY_PREFIX, auth_headers, bearer, is_api_key
from .client import DEFAULT_BASE_URL, SANDBOX_KEY, SANDBOX_ORG, ScOrgsClient
from .webhooks import (
    SECRET_PREFIX,
    WEBHOOK_TOLERANCE_SECONDS,
    WebhookVerificationError,
    assert_valid_webhook,
    construct_event,
    sign_webhook,
    verify_webhook,
)

__all__ = [
    "ApiError",
    "RateLimitError",
    "parse_retry_after",
    "ScOrgsClient",
    "DEFAULT_BASE_URL",
    "SANDBOX_KEY",
    "SANDBOX_ORG",
    "KEY_PREFIX",
    "bearer",
    "auth_headers",
    "is_api_key",
    "verify_webhook",
    "assert_valid_webhook",
    "construct_event",
    "sign_webhook",
    "WebhookVerificationError",
    "SECRET_PREFIX",
    "WEBHOOK_TOLERANCE_SECONDS",
    "__version__",
]
