from typing import Any, Optional

from ._operations import GeneratedScOrgsClient
from .auth import bearer

DEFAULT_BASE_URL = "https://api.sc-orgs.space/api/v1"
#: The shared read-only sandbox key from sc-orgs.space/developers: it only sees the ~SANDBOX test org.
SANDBOX_KEY = "sco_test_hKI7h4mK1eSEen1hfCCBUXOSQnKxIFbHSPcPM7sXVAl"
SANDBOX_ORG = "~SANDBOX"


class ScOrgsClient(GeneratedScOrgsClient):
    """The SC Orgs public API (org profile, members, roles, events, RSVPs).

    >>> sco = ScOrgsClient(os.environ["SCO_API_KEY"])
    >>> org = sco.get_me()["organization"]["sid"]
    >>> for m in sco.iter_members(org): print(m["rsi_handle"])

    The key is optional: without one, the operations that allow it return the public
    view. Keyword options: ``base_url``, ``max_retries`` (default 3), ``max_retry_delay``
    (seconds, default 60), ``timeout``, ``headers``, ``transport``, ``on_retry``.
    """

    _user_agent_name = "sc-orgs-sdk"

    def __init__(self, key: Optional[str] = None, *, base_url: str = DEFAULT_BASE_URL, **options: Any):
        if key is not None:
            bearer(key)  # validates the prefix
        super().__init__(base_url=base_url, token=key, **options)
