"""SC Orgs org API keys: ``sco_live_...``, or ``sco_test_...`` for test-realm orgs (Manage -> API)."""

import re
from typing import Dict

KEY_PREFIX = "sco_"
_KEY_RE = re.compile(r"^sco_(live|test)_\S+$")


def is_api_key(key: object) -> bool:
    """True for a string shaped like an org API key. Doesn't check it with the server."""
    return isinstance(key, str) and bool(_KEY_RE.match(key))


def bearer(key: str) -> str:
    """The ``Authorization`` header value for a key. Raises ValueError for anything else."""
    if not is_api_key(key):
        raise ValueError("SC Orgs API keys start with sco_live_ or sco_test_ (create one in your org under Manage -> API on sc-orgs.space)")
    return "Bearer " + key


def auth_headers(key: str) -> Dict[str, str]:
    return {"Authorization": bearer(key)}
