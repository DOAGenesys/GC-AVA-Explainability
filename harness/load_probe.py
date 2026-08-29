"""VALIDATION 6 - signed-download throughput and which rate-limit domain applies.

Establishes the safe download-worker concurrency by ramping concurrency against real signed
URIs and watching for the first sign of throttling.

> This probe generates deliberate load against a shared production org's download service.
> It ramps gently, stops at the first throttling signal, and defaults to a low ceiling.
> Do not raise --max-concurrency without a reason.

Because a signed URI is single-execution and TTL-bound, the probe re-requests the same small
set of URIs rather than needing thousands of captured events. That measures the throttling
domain, which is the question, even though it does not measure aggregate egress.

Usage:
  python harness/load_probe.py --events artifacts/samples/*.json
  python harness/load_probe.py --events e1.json e2.json --max-concurrency 20
"""

from __future__ import annotations

import argparse
import glob
import statistics
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import gcapi

THROTTLE_STATUSES = {429, 503, 509}


def one_request(url: str, ca_bundle: str | None) -> dict:
    resp = gcapi.request(url, ca_bundle=ca_bundle, timeout=60)
    headers = {k.lower(): v for k, v in resp.headers.items()}
    return {
        "status": resp.status,
        "elapsedMs": resp.elapsed_ms,
        "bytes": len(resp.body),
        "retryAfter": headers.get("retry-after"),
        "rateLimitHeaders": {k: v for k, v in headers.items() if "ratelimit" in k or "rate-limit" in k},
        "error": resp.error,
    }


def run_wave(urls: list[str], concurrency: int, ca_bundle: str | None) -> dict:
    started = time.perf_counter()
    results: list[dict] = []

    # Issue exactly `concurrency` requests, cycling the available URIs.
    work = [urls[i % len(urls)] for i in range(concurrency)]

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(one_request, url, ca_bundle) for url in work]
        for future in as_completed(futures):
            results.append(future.result())

    wall = time.perf_counter() - started
    latencies = [r["elapsedMs"] for r in results if r["status"] and r["elapsedMs"]]
    statuses: dict[int, int] = {}
    for r in results:
        statuses[r["status"]] = statuses.get(r["status"], 0) + 1

    throttled = [r for r in results if r["status"] in THROTTLE_STATUSES]
    rate_headers: dict[str, str] = {}
    for r in results:
        rate_headers.update(r["rateLimitHeaders"])

    return {
        "concurrency": concurrency,
        "requests": len(results),
        "wallSeconds": round(wall, 2),
        "throughputPerSecond": round(len(results) / wall, 2) if wall > 0 else None,
        "statuses": statuses,
        "p50Ms": int(statistics.median(latencies)) if latencies else None,
        "p95Ms": int(statistics.quantiles(latencies, n=20)[18]) if len(latencies) >= 20 else None,
        "maxMs": max(latencies) if latencies else None,
        "throttledCount": len(throttled),
        "retryAfterSeen": sorted({r["retryAfter"] for r in throttled if r["retryAfter"]}),
        "rateLimitHeaders": rate_headers,
        "totalBytes": sum(r["bytes"] for r in results),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--events", nargs="+", required=True, help="captured notification JSON files or globs")
    ap.add_argument("--ca-bundle")
    ap.add_argument("--max-concurrency", type=int, default=16)
    ap.add_argument("--pause-seconds", type=float, default=5.0, help="cool-down between waves")
    args = ap.parse_args()

    paths: list[str] = []
    for pattern in args.events:
        expanded = glob.glob(pattern)
        paths.extend(expanded if expanded else [pattern])

    urls: list[str] = []
    for path in paths:
        try:
            event = gcapi.load_event(path)
        except Exception as exc:  # noqa: BLE001 - a bad sample should not abort the probe
            print(f"  skipping {path}: {exc}")
            continue
        uri = event.get("executionHistoryUri")
        if uri:
            urls.append(uri)

    if not urls:
        raise SystemExit("no executionHistoryUri found in the supplied events")

    gcapi.banner("VALIDATION 6 - signed-download concurrency and rate-limit domain")
    print(f"  {len(urls)} distinct signed URI(s) available")
    print(f"  ramping 1 -> {args.max_concurrency}, stopping at the first throttling signal")

    # A quick baseline first: which host serves these, and does it look like the Platform API?
    probe = gcapi.request(urls[0], ca_bundle=args.ca_bundle)
    summary = probe.summary()
    print(f"\n  download host : {summary['finalHost']}")
    print(f"  baseline      : status {probe.status}, {summary['bytes']} bytes, {probe.elapsed_ms} ms")
    if summary["headers"]:
        print("  headers of interest:")
        for key, value in summary["headers"].items():
            print(f"    {key}: {value}")
    if not probe.ok:
        print("\n  Baseline fetch failed - the URIs have probably expired. Capture fresh events.")
        gcapi.write_artifact("v6-load-probe.json", {"error": "baseline failed", "baseline": summary})
        return 1

    evidence: dict = {
        "downloadHost": summary["finalHost"],
        "baseline": summary,
        "uriCount": len(urls),
        "waves": [],
    }

    concurrency = 1
    stop_reason = f"reached max concurrency {args.max_concurrency}"
    while concurrency <= args.max_concurrency:
        wave = run_wave(urls, concurrency, args.ca_bundle)
        evidence["waves"].append(wave)
        print(
            f"\n  concurrency {concurrency:>3}: "
            f"{wave['throughputPerSecond']} req/s, p50 {wave['p50Ms']} ms, "
            f"max {wave['maxMs']} ms, statuses {wave['statuses']}"
        )
        if wave["rateLimitHeaders"]:
            print(f"    rate-limit headers: {wave['rateLimitHeaders']}")

        if wave["throttledCount"] > 0:
            stop_reason = (
                f"throttled at concurrency {concurrency}: "
                f"{wave['throttledCount']} of {wave['requests']} requests"
            )
            print(f"    THROTTLED. Stopping the ramp. Retry-After seen: {wave['retryAfterSeen']}")
            break

        errors = {s: c for s, c in wave["statuses"].items() if s == 0 or s >= 500}
        if errors:
            stop_reason = f"errors at concurrency {concurrency}: {errors}"
            print(f"    errors observed: {errors}. Stopping the ramp.")
            break

        concurrency *= 2
        if concurrency <= args.max_concurrency:
            time.sleep(args.pause_seconds)

    evidence["stopReason"] = stop_reason

    # ------------------------------------------------------------------- verdict
    print("\n  === Verdict ===")
    print(f"  {stop_reason}")

    clean = [w for w in evidence["waves"] if w["throttledCount"] == 0]
    if clean:
        best = max(clean, key=lambda w: w["concurrency"])
        recommended = max(1, best["concurrency"] // 2)
        print(f"  Highest clean concurrency observed : {best['concurrency']}")
        print(f"  Recommended max_download_concurrency: {recommended}  (half, as headroom)")
        evidence["highestCleanConcurrency"] = best["concurrency"]
        evidence["recommendedConcurrency"] = recommended
    else:
        print("  No clean wave. Keep max_download_concurrency at 1 and investigate.")
        evidence["recommendedConcurrency"] = 1

    if evidence["baseline"]["headers"].get("inin-ratelimit-allowed"):
        print("  Headers are Platform-API shaped, so downloads likely SHARE the Platform API")
        print("  rate-limit domain. Budget download concurrency against other API usage.")
        evidence["rateLimitDomain"] = "platform-api"
    elif "amazonaws.com" in (summary["finalHost"] or "") or summary["headers"].get("x-amz-request-id"):
        print("  Served by object storage rather than the Platform API, so downloads are")
        print("  outside the Platform API rate-limit domain. Concurrency can be higher.")
        evidence["rateLimitDomain"] = "object-store"
    else:
        print("  Rate-limit domain is not conclusive from headers alone.")
        evidence["rateLimitDomain"] = "unknown"

    out = gcapi.write_artifact("v6-load-probe.json", evidence)
    print(f"\n  Evidence: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
