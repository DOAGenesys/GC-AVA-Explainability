"""Genesys Cloud flow-execution-history retrieval via the Jobs API, batched.

This exists because the notification's `executionHistoryUri` field has never once been populated
in this org - 0 of 30 observed events carried one - so the Jobs API is not a fallback path, it is
the only retrieval path. See validation 2 and 6 in docs/validation-log.md.

Two measured facts shape everything here:

  - A job accepts at most **10** execution ids. 10 is accepted, 11 is rejected. One job costs 2
    API calls (the POST plus a single poll to reach `Success`), so batching at the ceiling costs
    0.2 API calls per execution instead of the 2 that one-job-per-execution costs.
  - A batched job returns a `downloadUri` per entity, and those URIs are served from a separate
    download host, so the payload bytes do not consume Platform API budget.

And one measured hazard: **a rejected batch is all-or-nothing and names no id.** The response is a
bare 422 `The input data is not valid`. Treating a rejection as "none of these are retrievable" is
indistinguishable from catastrophic data loss - that exact mistake produced a "0 of 15 retained"
reading during validation - so a rejected batch is bisected until the offending ids are isolated.
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import boto3

LOG = logging.getLogger(__name__)

# The measured acceptance ceiling. Deliberately not raised "just in case": 11 is a hard 422, and
# an over-large batch degrades into bisection, which costs more calls than it saves.
MAX_IDS_PER_JOB = int(os.environ.get("JOBS_MAX_IDS", "10"))

JOB_TERMINAL_STATES = ("Success", "Failed")
JOB_POLL_INTERVAL_S = float(os.environ.get("JOBS_POLL_INTERVAL_SECONDS", "2"))
JOB_TIMEOUT_S = float(os.environ.get("JOBS_TIMEOUT_SECONDS", "60"))

API_HOST = os.environ.get("GENESYS_API_HOST", "api.mypurecloud.de")
LOGIN_HOST = os.environ.get("GENESYS_LOGIN_HOST", "login.mypurecloud.de")
CREDENTIALS_SECRET_ID = os.environ.get("GENESYS_CREDENTIALS_SECRET_ID", "")

_secrets = boto3.client("secretsmanager")

# Cached across invocations of the same execution environment. A client-credentials token lasts
# considerably longer than a Lambda container, so minting one per invocation would add an
# avoidable auth call to every batch.
_token: dict[str, Any] = {"value": None, "expiresAt": 0.0}


class JobsUnavailable(Exception):
    """Raised when the Jobs API cannot be reached at all, so the batch should be retried."""


# --------------------------------------------------------------------------- transport


def _request(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = 30.0,
) -> tuple[int, dict[str, str], bytes]:
    req = urllib.request.Request(url, method=method, data=body, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, {k.lower(): v for k, v in exc.headers.items()}, exc.read()
    except Exception as exc:  # noqa: BLE001 - transport failure must surface as retryable
        raise JobsUnavailable(f"{type(exc).__name__}: {exc}") from exc


def _access_token() -> str:
    if _token["value"] and time.time() < _token["expiresAt"]:
        return _token["value"]

    if not CREDENTIALS_SECRET_ID:
        raise JobsUnavailable("GENESYS_CREDENTIALS_SECRET_ID is not configured")

    secret = json.loads(_secrets.get_secret_value(SecretId=CREDENTIALS_SECRET_ID)["SecretString"])
    payload = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": secret["clientId"],
        "client_secret": secret["clientSecret"],
    }).encode()

    status, _, raw = _request(
        f"https://{LOGIN_HOST}/oauth/token",
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        body=payload,
    )
    if status != 200:
        raise JobsUnavailable(f"token request returned {status}: {raw[:200]!r}")

    parsed = json.loads(raw)
    _token["value"] = parsed["access_token"]
    # 60s of margin so a token cannot expire between the POST and the poll of the same job.
    _token["expiresAt"] = time.time() + float(parsed.get("expires_in", 86400)) - 60
    return _token["value"]


def _api(path: str, *, method: str = "GET", payload: Any = None) -> tuple[int, dict[str, str], bytes]:
    """Call the Platform API, honouring 429 once with the server's own Retry-After."""
    for attempt in (1, 2):
        headers = {
            "Authorization": f"Bearer {_access_token()}",
            "Content-Type": "application/json",
        }
        body = json.dumps(payload).encode() if payload is not None else None
        status, resp_headers, raw = _request(
            f"https://{API_HOST}{path}", method=method, headers=headers, body=body
        )
        if status != 429 or attempt == 2:
            return status, resp_headers, raw
        delay = float(resp_headers.get("retry-after", "3"))
        LOG.warning("Jobs API returned 429, waiting %ss as instructed", delay)
        time.sleep(min(delay, 10.0))
    raise AssertionError("unreachable")


def api_get(path: str) -> tuple[int, bytes]:
    """GET a Platform API path with the collector's cached token and 429 handling."""
    status, _, raw = _api(path)
    return status, raw


# --------------------------------------------------------------------------- jobs


def _submit_one_job(ids: list[str]) -> tuple[dict[str, dict], dict[str, Any]]:
    """Submit one job of at most MAX_IDS_PER_JOB ids and poll it to a terminal state.

    Returns (result_by_execution_id, meta). `accepted: False` in the meta means the batch was
    rejected wholesale and the caller must bisect - it does NOT mean the ids are unretrievable.
    """
    status, _, raw = _api("/api/v2/flows/instances/jobs", method="POST", payload={"ids": ids})
    if status != 200:
        return {}, {
            "size": len(ids),
            "accepted": False,
            "httpStatus": status,
            "error": raw[:200].decode("utf-8", "replace"),
        }

    job_id = json.loads(raw)["id"]
    deadline = time.time() + JOB_TIMEOUT_S
    calls = 1
    entities: list[dict] = []
    state: str | None = None

    while time.time() < deadline:
        poll_status, _, poll_raw = _api(f"/api/v2/flows/instances/jobs/{job_id}")
        calls += 1
        if poll_status != 200:
            return {}, {
                "size": len(ids), "accepted": True, "jobId": job_id, "apiCalls": calls,
                "error": f"poll returned {poll_status}",
            }
        parsed = json.loads(poll_raw)
        state = parsed.get("jobState")
        if state in JOB_TERMINAL_STATES:
            entities = parsed.get("entities") or []
            break
        time.sleep(JOB_POLL_INTERVAL_S)
    else:
        return {}, {
            "size": len(ids), "accepted": True, "jobId": job_id, "apiCalls": calls,
            "error": f"job did not reach a terminal state within {JOB_TIMEOUT_S}s",
        }

    results = {}
    for entity in entities:
        execution_id = entity.get("id")
        if not execution_id:
            continue
        results[execution_id] = {
            # An id the platform holds nothing for is still returned as an entity, inside a job
            # that reached Success, flagged failed with statusCode 404. Counting entities rather
            # than unfailed entities reports every id as retrievable, which is how an empty
            # archive once looked like a complete one.
            "failed": bool(entity.get("failed")),
            "statusCode": entity.get("statusCode"),
            "downloadUri": entity.get("downloadUri"),
        }

    return results, {
        "size": len(ids), "accepted": True, "jobId": job_id, "jobState": state,
        "entities": len(entities), "apiCalls": calls,
    }


def _submit_bisecting(ids: list[str], meta: list[dict]) -> dict[str, dict]:
    """Submit ids, halving on wholesale rejection until the unacceptable ones are isolated."""
    if not ids:
        return {}

    results, info = _submit_one_job(ids)
    meta.append(info)

    if info.get("accepted") and not info.get("error"):
        return results

    if len(ids) == 1:
        # A single id rejected on its own is genuinely unacceptable to the platform - a malformed
        # id, or an execution outside retention. Recorded so it is not mistaken for a batch
        # artefact and retried forever.
        return {ids[0]: {"failed": True, "statusCode": "rejected", "downloadUri": None}}

    middle = len(ids) // 2
    return {
        **_submit_bisecting(ids[:middle], meta),
        **_submit_bisecting(ids[middle:], meta),
    }


def retrieve(execution_ids: list[str]) -> tuple[dict[str, dict], list[dict]]:
    """Resolve execution ids to download URIs, batching at the measured ceiling.

    Returns (result_by_execution_id, per-job metadata). Each result carries `failed`, `statusCode`
    and `downloadUri`; an id absent from the mapping was never returned by any job at all, which
    is a different condition from being returned as a 404 and is reported as such.
    """
    unique = list(dict.fromkeys(execution_ids))
    results: dict[str, dict] = {}
    meta: list[dict] = []

    for start in range(0, len(unique), MAX_IDS_PER_JOB):
        results.update(_submit_bisecting(unique[start : start + MAX_IDS_PER_JOB], meta))

    total_calls = sum(m.get("apiCalls", 0) for m in meta)
    LOG.info(
        "Jobs retrieval: %s executions, %s jobs, %s API calls (%.2f per execution)",
        len(unique), len(meta), total_calls,
        total_calls / len(unique) if unique else 0.0,
    )
    return results, meta


def download(uri: str, timeout: float = 30.0) -> bytes:
    """Fetch content from a job's download URI.

    No Authorization header: the URI is pre-signed and served from a download host distinct from
    the API host, so these bytes are outside the API budget. Sending a bearer token to a
    third-party host would be worse than useless.
    """
    status, _, raw = _request(uri, timeout=timeout)
    if status != 200:
        raise JobsUnavailable(f"download returned {status}")
    return raw
