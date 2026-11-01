import json
import sys
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from sc_orgs_sdk import (  # noqa: E402
    SANDBOX_KEY,
    ApiError,
    RateLimitError,
    ScOrgsClient,
    WebhookVerificationError,
    bearer,
    construct_event,
    sign_webhook,
    verify_webhook,
)

FIXTURES = Path(__file__).resolve().parents[2] / "test" / "fixtures"  # shared with the TypeScript tests


class FakeTransport:
    def __init__(self, *responses):
        self.queue = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "headers": dict(headers)})
        status, fixture, headers_out = self.queue.pop(0)
        raw = (FIXTURES / fixture).read_bytes() if fixture.endswith(".json") else fixture.encode()
        return status, dict({"content-type": "application/json"}, **headers_out), raw


class ClientTests(unittest.TestCase):
    def test_bearer(self):
        self.assertEqual(bearer(SANDBOX_KEY), "Bearer " + SANDBOX_KEY)
        for bad in ("sco_abc", "scmp_live_x", ""):
            with self.assertRaises(ValueError):
                bearer(bad)

    def test_get_me(self):
        t = FakeTransport((200, "me.json", {}))
        me = ScOrgsClient(SANDBOX_KEY, transport=t).get_me()
        self.assertEqual(me["organization"]["sid"], "~SANDBOX")
        self.assertEqual(t.calls[0]["url"], "https://api.sc-orgs.space/api/v1/me")
        self.assertEqual(t.calls[0]["headers"]["Authorization"], "Bearer " + SANDBOX_KEY)

    def test_iter_members(self):
        t = FakeTransport((200, "members-page1.json", {}), (200, "members-page2.json", {}))
        handles = [m["rsi_handle"] for m in ScOrgsClient(SANDBOX_KEY, transport=t).iter_members("~SANDBOX", page_size=2)]
        self.assertEqual(handles, ["~sandbox-owner", "~sandbox-alice", "~sandbox-bob", "~sandbox-carol"])
        self.assertEqual(urlparse(t.calls[0]["url"]).path, "/api/v1/orgs/~SANDBOX/members")
        self.assertEqual(parse_qs(urlparse(t.calls[1]["url"]).query), {"page_size": ["2"], "page": ["2"]})

    def test_events_without_key(self):
        t = FakeTransport((200, "events.json", {}))
        data = ScOrgsClient(transport=t).list_events("~SANDBOX", from_="2026-11-01T00:00:00Z")
        self.assertEqual(data["total"], 4)
        self.assertEqual(parse_qs(urlparse(t.calls[0]["url"]).query), {"from": ["2026-11-01T00:00:00Z"]})
        self.assertNotIn("Authorization", t.calls[0]["headers"])

    def test_rate_limit(self):
        slept = []
        t = FakeTransport((429, "unauthorized.json", {"Retry-After": "3"}), (200, "me.json", {}))
        ScOrgsClient(SANDBOX_KEY, transport=t, sleep=slept.append).get_me()
        self.assertEqual(slept, [3.0])
        t = FakeTransport((503, "unauthorized.json", {"Retry-After": "999"}))
        with self.assertRaises(RateLimitError):
            ScOrgsClient(SANDBOX_KEY, transport=t, sleep=slept.append).get_me()

    def test_errors(self):
        t = FakeTransport((404, "org-not-found.json", {}))
        with self.assertRaises(ApiError) as cm:
            ScOrgsClient(transport=t).get_organization("~SANDBOX")
        self.assertEqual((cm.exception.status, cm.exception.code), (404, "NOT_FOUND"))


class WebhookTests(unittest.TestCase):
    v = json.loads((FIXTURES / "webhook-signed.json").read_text())

    def test_server_signed_delivery(self):
        v = self.v
        now = v["timestamp"] + 10
        self.assertTrue(verify_webhook(v["secret"], v["headers"], v["body"], now=now))
        self.assertTrue(verify_webhook(v["previous_secret"], v["headers"], v["body"].encode(), now=now))
        upper = {k.title(): val for k, val in v["headers"].items()}
        self.assertTrue(verify_webhook(v["secret"], upper, v["body"], now=now))

    def test_refusals(self):
        v = self.v
        now = v["timestamp"] + 10
        self.assertFalse(verify_webhook(v["secret"], v["headers"], v["body"] + " ", now=now))
        self.assertFalse(verify_webhook(v["secret"], v["headers"], v["body"], now=v["timestamp"] + 301))
        self.assertFalse(verify_webhook(v["secret"], {}, v["body"], now=now))
        with self.assertRaises(TypeError):
            verify_webhook("nope", v["headers"], v["body"], now=now)

    def test_construct_and_sign(self):
        v = self.v
        event = construct_event(v["secret"], v["headers"], v["body"], now=v["timestamp"])
        self.assertEqual(event["type"], "member.joined")
        with self.assertRaises(WebhookVerificationError):
            construct_event(v["secret"], v["headers"], v["body"], now=v["timestamp"] + 1000)
        self.assertEqual(sign_webhook(v["secret"], v["headers"]["webhook-id"], v["timestamp"], v["body"]), v["headers"]["webhook-signature"].split(" ")[0])


if __name__ == "__main__":
    unittest.main()
