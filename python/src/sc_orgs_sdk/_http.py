"""The transport the clients share: urllib from the standard library, ``{"data": ...}``
unwrapping, typed errors, pagination and 429/503 retries that respect Retry-After.
No third-party dependencies."""

import email.utils
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Iterator, Mapping, Optional, Tuple

from ._version import __version__

#: ``transport(method, url, headers, body, timeout) -> (status, headers, body)``.
#: Swap it for tests or another HTTP library; header names in the result may be any case.
Transport = Callable[[str, str, Dict[str, str], Optional[bytes], Optional[float]], Tuple[int, Mapping[str, str], bytes]]


def urllib_transport(method, url, headers, body, timeout):
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, dict(res.headers.items()), res.read()
    except urllib.error.HTTPError as e:  # non-2xx responses still carry a body
        return e.code, dict(e.headers.items()), e.read()


class ApiError(Exception):
    """A non-2xx response. ``code`` is the API's machine-readable error code."""

    def __init__(self, status: int, body: Any, headers: Mapping[str, str]):
        err = body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), dict) else {}
        self.status = status
        self.code: str = err.get("code") or "HTTP_%d" % status
        self.message: str = err.get("message") or "HTTP %d" % status
        self.details = err.get("details")
        self.validation_errors = err.get("validationErrors")
        self.retry_after = parse_retry_after(_header(headers, "retry-after"))
        self.request_id = _header(headers, "x-request-id")
        self.body = body
        super().__init__("%s: %s" % (self.code, self.message))


class RateLimitError(ApiError):
    """A 429 (or 503) the client gave up on: retries used up, or Retry-After above max_retry_delay."""


def parse_retry_after(value: Optional[str], now: Optional[float] = None) -> Optional[float]:
    """Retry-After in seconds: delta-seconds or an HTTP date. None when absent or invalid."""
    if value is None or not str(value).strip():
        return None
    v = str(value).strip()
    try:
        return float(v)
    except ValueError:
        pass
    try:
        at = email.utils.parsedate_to_datetime(v).timestamp()
    except (TypeError, ValueError, IndexError):
        return None
    return max(0.0, float(int(at - (time.time() if now is None else now) + 0.999)))


def _header(headers: Mapping[str, str], name: str) -> Optional[str]:
    for k, v in headers.items():
        if k.lower() == name:
            return v
    return None


def build_query(query: Optional[Mapping[str, Any]]) -> str:
    """``?a=1&b=x&b=y``, skipping None. Booleans are sent as true/false."""
    if not query:
        return ""
    pairs = []
    for key, value in query.items():
        if value is None:
            continue
        for v in value if isinstance(value, (list, tuple)) else [value]:
            if isinstance(v, bool):
                v = "true" if v else "false"
            elif isinstance(v, float) and v.is_integer():
                v = int(v)
            pairs.append((key, str(v)))
    return "?" + urllib.parse.urlencode(pairs) if pairs else ""


class BaseClient:
    def __init__(
        self,
        *,
        base_url: str,
        token: Optional[str] = None,
        max_retries: int = 3,
        max_retry_delay: float = 60.0,
        timeout: Optional[float] = 30.0,
        headers: Optional[Mapping[str, str]] = None,
        transport: Optional[Transport] = None,
        sleep: Callable[[float], None] = time.sleep,
        on_retry: Optional[Callable[[Dict[str, Any]], None]] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self._token = token
        self.max_retries = max_retries
        self.max_retry_delay = max_retry_delay
        self.timeout = timeout
        self._headers = {"User-Agent": "%s/%s (python)" % (self._user_agent_name, __version__)}
        self._headers.update(headers or {})
        self._transport = transport or urllib_transport
        self._sleep = sleep
        self._on_retry = on_retry

    _user_agent_name = "sc-sdk"

    def _send(self, method: str, path: str, query: Optional[Mapping[str, Any]] = None, body: Any = None, accept: str = "application/json") -> Any:
        url = self.base_url + path + build_query(query)
        headers = {"Accept": accept}
        headers.update(self._headers)
        if self._token:
            headers["Authorization"] = "Bearer " + self._token
        payload = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body).encode("utf-8")

        attempt = 0
        while True:
            status, res_headers, raw = self._transport(method, url, headers, payload, self.timeout)
            parsed = _parse(raw, _header(res_headers, "content-type") or "")
            if 200 <= status < 300:
                return parsed
            # 429: a rate limit. 503: the API is busy (it rejects before doing
            # any work, so a retry is safe even for a write).
            if status not in (429, 503):
                raise ApiError(status, parsed, res_headers)
            retry_after = parse_retry_after(_header(res_headers, "retry-after"))
            delay = retry_after if retry_after is not None else min(2.0 ** attempt, self.max_retry_delay)
            if attempt >= self.max_retries or delay > self.max_retry_delay:
                raise RateLimitError(status, parsed, res_headers)
            attempt += 1
            if self._on_retry:
                self._on_retry({"attempt": attempt, "status": status, "delay_seconds": delay, "method": method, "url": url})
            self._sleep(delay)

    def _request(self, method: str, path: str, query: Optional[Mapping[str, Any]] = None, body: Any = None) -> Any:
        parsed = self._send(method, path, query=query, body=body)
        return parsed["data"] if isinstance(parsed, dict) and "data" in parsed else parsed

    def _paginate(self, fetch_page: Callable[[int], Any], key: str) -> Iterator[Any]:
        seen = 0
        page = 1
        while True:
            data = fetch_page(page)
            items = data.get(key) or []
            for item in items:
                yield item
            seen += len(items)
            if not items or seen >= data.get("total", 0):
                return
            page += 1


def _parse(raw: bytes, content_type: str) -> Any:
    if not raw:
        return None
    text = raw.decode("utf-8", errors="replace")
    if "json" in content_type:
        try:
            return json.loads(text)
        except ValueError:
            return text
    return text
