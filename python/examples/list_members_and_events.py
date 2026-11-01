"""List your org's members and its events of the next 30 days.

    SCO_API_KEY=sco_live_... python3 examples/list_members_and_events.py

Without SCO_API_KEY it uses the public sandbox key (the ~SANDBOX test org).
"""

import os

from sc_orgs_sdk import SANDBOX_KEY, ScOrgsClient

sco = ScOrgsClient(os.environ.get("SCO_API_KEY", SANDBOX_KEY))
org = sco.get_me()["organization"]
print("%s (%s)\n" % (org["name"], org["sid"]))

print("Members")
for m in sco.iter_members(org["sid"]):
    print("  %-24s %s" % (m["rsi_handle"], ", ".join(r["name"] for r in m["roles"]) or "no role"))

print("\nEvents (next 30 days)")
for e in sco.iter_events(org["sid"]):
    print("  %s  %s  [%s]  %d signed up" % (e["start_time"], e["title"], e["status"], e["rsvp_count"]))
