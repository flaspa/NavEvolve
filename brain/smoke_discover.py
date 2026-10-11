"""Smoke test: Nimble Search v2 (no model, no server). Compares the plain
documented request with the shopping-focus variant and reports latency."""
import os, time
from pathlib import Path
import requests
from dotenv import load_dotenv
load_dotenv(Path(__file__).with_name(".env")); load_dotenv(Path(__file__).parent.parent / ".env")
import discover

key = os.environ.get("NIMBLE_API_KEY", "").strip()
print("key present:", bool(key))
base = {"query": "rustic cylindrical solid wood stool round seat buy", "search_depth": "lite",
        "full_content": False, "country": "US", "locale": "en", "max_results": 5}
for label, extra in [("plain", {}), ("focus=shopping", {"focus": "shopping"})]:
    t0 = time.perf_counter()
    try:
        r = requests.post(discover.NIMBLE_SEARCH_URL, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                          json={**base, **extra}, timeout=150)
        n = len((r.json().get("results") or [])) if r.ok else None
        print(f"{label}: HTTP {r.status_code} results={n} in {time.perf_counter()-t0:.1f}s", "" if r.ok else r.text[:160])
        if r.ok:
            for it in (r.json().get("results") or [])[:3]:
                print("   -", (it.get("title") or "")[:60], "|", it.get("url", "")[:70])
    except Exception as exc:
        print(f"{label}: {type(exc).__name__} after {time.perf_counter()-t0:.1f}s")
