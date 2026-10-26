# Validation harness

Produces the Section 11 evidence from captured `v2.flows.instances.flow.{id}` notifications.

Standard library only, so it runs in any Python 3.9+ interpreter. `pull_samples.py` is the one
exception: it needs boto3, so run that one through the aws skill's wrapper.

## Order of operations

```text
pull_samples.py      S3 Bronze envelopes    -> artifacts/samples/<executionId>.json
      |
      +-> fetch_direct.py     V5, V6   signed URI: auth, redirects, TTL, expiry
      +-> probe_endpoint.py   V4       what `endpoint` actually is
      +-> jobs_compare.py     V1,V2,V3 Jobs artifacts, per expand variant
              |
              +-> semantic_diff.py  V1  direct vs Jobs, field by field
      +-> load_probe.py       V6       concurrency ramp, rate-limit domain
```

## Which gate each script answers

| Script | Gates | What it establishes |
|---|---|---|
| `fetch_direct.py` | 5, 6 | whether the signature alone authorises the download, the serving host, redirect behaviour, and the failure shape at expiry |
| `probe_endpoint.py` | 4 | whether `endpoint` is a durable retrieval path, and whether it mints a fresh signed URI - which would make Jobs unnecessary for recovery |
| `jobs_compare.py` | 1, 2, 3 | whether the notification `executionId` is accepted verbatim in `ids[]`, and whether any expand variant returns data the direct download lacks |
| `semantic_diff.py` | 1 | the directional field-level comparison, and the actual PASS/FAIL for gate 1 |
| `load_probe.py` | 6 | highest clean concurrency, and whether downloads share the Platform API rate-limit domain |
| `probe_turn_metadata.py` | 10 | which turn-level fields Bot Flow Reporting Turns returns (tool calls, AVA details, guardrail and knowledge metadata); prints field paths, counts and enum values only, never conversation content |

Gates 8 and 9 are answered by the PowerShell probes in `scripts/`, not here:
`gc-probe-topic-transports.ps1` and `gc-build-ava-registry.ps1`.

## Running

```powershell
$py = "$env:USERPROFILE\.cursor\skills\aws\.venv\Scripts\python.exe"

# 1. get samples (needs AWS credentials, hence the wrapper)
powershell -File $env:USERPROFILE\.cursor\skills\aws\scripts\aws-exec.ps1 `
  -Run "$py harness\pull_samples.py --bucket <bronze_bucket> --limit 20"

# 2. per-execution evidence
& $py harness\fetch_direct.py   --event artifacts\samples\<id>.json
& $py harness\probe_endpoint.py --event artifacts\samples\<id>.json
& $py harness\jobs_compare.py   --event artifacts\samples\<id>.json
& $py harness\semantic_diff.py  --execution-id <id>

# 3. concurrency, once several fresh samples exist
& $py harness\load_probe.py --events artifacts\samples\*.json
```

Answerable before any event has been captured, because it is a property of the API contract
rather than of an execution:

```powershell
& $py harness\jobs_compare.py --discover-only
```

## Timing constraint

`executionHistoryUriTtl` bounds everything. Once it lapses, `fetch_direct.py`, `load_probe.py`
and the direct half of `semantic_diff.py` can no longer run against that execution, and only
the Jobs path remains. `pull_samples.py` prints remaining TTL per sample for this reason, so
run the direct-download scripts first and the Jobs scripts second.

## Output

Evidence goes to `artifacts/validation/`:

| File | Contents |
|---|---|
| `v4-endpoint-<id>.json` | endpoint probe results |
| `v5-signed-uri-<id>.json` | per-attempt status, headers, host, timing, expiry outcome |
| `v1-v2-v3-jobs-<id>.json` | job submissions, states, artifact hashes per variant |
| `v1-diff-<id>.json` | directional diff and the gate verdict |
| `v2-expand-vocabulary.json` | expand values discovered from the live spec |
| `v6-load-probe.json` | per-wave throughput, latency percentiles, throttling signals |
| `<id>-direct.json`, `<id>-job-*.json` | the downloaded artifacts themselves |

`artifacts/` is gitignored. These files contain real conversation content from a shared
production org, and the org records at execution-data level `All`, so treat them as personal
data: keep them local, and delete them once the gate they support has been recorded.

Signed URIs are redacted wherever they are written to an evidence file, since a signed URI is
a bearer credential until it expires.
