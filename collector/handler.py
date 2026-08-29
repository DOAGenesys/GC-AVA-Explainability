"""Collector for Genesys Cloud v2.flows.instances.flow.{id} notifications.

Triggered by SQS, which is fed by an EventBridge rule on the Genesys partner event bus.

For every notification this writes Bronze artifacts and one manifest row:

    bronze/envelope/       the EventBridge envelope, unmodified
    bronze/history-direct/ the bytes behind executionHistoryUri, unmodified
    bronze/history-jobs/   the bytes retrieved through the Jobs API, unmodified
    bronze/probe/          how the retrieval behaved

**Retrieval is Jobs-first, because the notification does not carry content.** Across every event
observed in this org, `executionHistoryUri` was populated 0 times out of 30, and no notification
topic in the platform's catalogue carries AVA turn or tool detail - see the source inventory in
docs/validation-log.md. So the event's role is to name an execution; the Jobs API is what fetches
it. The direct-URI path below is retained and preferred when a URI does appear, since it costs no
API budget at all, but it is not the expected case.

Records are handled in two phases rather than one-at-a-time, which is the whole point: a job
accepts 10 execution ids for 2 API calls, so an SQS batch of 10 costs 0.2 API calls per execution
instead of the 2 that one job per execution costs. Phase one parses, archives envelopes and claims
manifest rows; phase two retrieves everything still outstanding in as few jobs as possible.

The probe artifact exists because retrieval is the only way to answer validation gates 4, 5 and 6
empirically. Capturing status, headers, redirect chain and timing on every retrieval turns normal
operation into continuous evidence collection, rather than requiring a separate load test.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

import jobs

LOG = logging.getLogger()
LOG.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

BUCKET = os.environ["BRONZE_BUCKET"]
TABLE = os.environ["MANIFEST_TABLE"]
COLLECTOR_VERSION = os.environ.get("COLLECTOR_VERSION", "0.1.0")
DOWNLOAD_TIMEOUT = float(os.environ.get("DOWNLOAD_TIMEOUT_SECONDS", "20"))

# Mirrors the queue's redrive threshold. Lambda is not told that an attempt is the last one, so
# without this the manifest cannot distinguish "will be retried" from "about to hit the DLQ",
# and an execution would sit in DOWNLOAD_PENDING forever with nothing ever promoting it into
# the Jobs recovery population. Reconciliation depends on that distinction.
MAX_RECEIVE_COUNT = int(os.environ.get("MAX_RECEIVE_COUNT", "5"))

# Retries are the queue's job, not the SDK's; a hung download here just burns Lambda time
# that the signed URI may not have.
_boto_cfg = Config(retries={"max_attempts": 3, "mode": "standard"})
_s3 = boto3.client("s3", config=_boto_cfg)
_ddb = boto3.client("dynamodb", config=_boto_cfg)

# Header values worth keeping. Everything else is noise, and the full set can contain
# signature material we would rather not archive.
INTERESTING_HEADERS = {
    "content-type", "content-length", "content-encoding", "etag", "last-modified",
    "x-amz-request-id", "x-amz-id-2", "x-amz-version-id", "x-cache", "via", "server",
    "date", "expires", "cache-control", "age", "retry-after",
    "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
    "inin-ratelimit-count", "inin-ratelimit-allowed", "inin-ratelimit-reset",
    "inin-correlation-id",
}


# --------------------------------------------------------------------------- parsing


def _lag_seconds(event_time: str | None, at: datetime) -> float | None:
    """Seconds between the event's own timestamp and our handling of it."""
    if not event_time:
        return None
    try:
        emitted = datetime.fromisoformat(event_time.replace("Z", "+00:00"))
    except ValueError:
        return None
    return round((at - emitted).total_seconds(), 3)


def _unwrap(record_body: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return (eventbridge_envelope, genesys_notification_body).

    Genesys delivers the topic name as detail-type and the topic body as detail. Some
    transports wrap the body again as {topicName, eventBody}, so both shapes are accepted
    rather than assuming one and failing obscurely later.
    """
    envelope = json.loads(record_body)
    detail = envelope.get("detail", {})

    if isinstance(detail, dict) and "eventBody" in detail and "topicName" in detail:
        return envelope, detail["eventBody"] or {}
    return envelope, detail if isinstance(detail, dict) else {}


def _org_id_from_source(envelope: dict[str, Any]) -> str:
    """Extract the Genesys org id from aws.partner/genesys.com/cloud/{orgId}/{suffix}."""
    source = envelope.get("source", "")
    parts = source.split("/")
    return parts[3] if len(parts) >= 4 else "unknown-org"


def _s3_key(kind: str, org_id: str, execution_id: str, occurred: str) -> str:
    day = occurred[:10] if len(occurred) >= 10 else datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return f"bronze/{kind}/dt={day}/org={org_id}/{execution_id}.json"


# --------------------------------------------------------------------------- download


def _download(uri: str) -> dict[str, Any]:
    """Fetch the signed URI, recording everything needed for validations 4, 5 and 6."""
    redirects: list[dict[str, str]] = []

    class _Tracer(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            redirects.append({
                "status": str(code),
                "from_host": urllib.parse.urlparse(req.full_url).netloc,
                "to_host": urllib.parse.urlparse(newurl).netloc,
            })
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    opener = urllib.request.build_opener(_Tracer)
    # No Authorization header on purpose: this establishes whether the signature alone is
    # sufficient, which validation 6 asks and the architecture assumes.
    request = urllib.request.Request(uri, headers={"User-Agent": f"ava-explainability/{COLLECTOR_VERSION}"})

    started = time.monotonic()
    probe: dict[str, Any] = {
        "requestedAt": datetime.now(timezone.utc).isoformat(),
        "host": urllib.parse.urlparse(uri).netloc,
        "authorizationHeaderSent": False,
        "redirects": redirects,
    }

    try:
        with opener.open(request, timeout=DOWNLOAD_TIMEOUT) as response:
            raw = response.read()
            probe.update({
                "httpStatus": response.status,
                "finalHost": urllib.parse.urlparse(response.url).netloc,
                "headers": {
                    k.lower(): v for k, v in response.headers.items()
                    if k.lower() in INTERESTING_HEADERS
                },
            })
    except urllib.error.HTTPError as exc:
        body = exc.read()[:4096].decode("utf-8", "replace")
        probe.update({
            "httpStatus": exc.code,
            "error": "http_error",
            "errorBody": body,
            "headers": {k.lower(): v for k, v in exc.headers.items() if k.lower() in INTERESTING_HEADERS},
            "elapsedMs": round((time.monotonic() - started) * 1000, 1),
        })
        # 403 on a signed URI usually means expired; 404 can mean the file is not ready yet.
        probe["retryable"] = exc.code in (404, 408, 425, 429, 500, 502, 503, 504)
        return {"probe": probe, "bytes": None}
    except Exception as exc:  # noqa: BLE001 - transport failures must be recorded, not raised blind
        probe.update({
            "error": type(exc).__name__,
            "errorMessage": str(exc),
            "retryable": True,
            "elapsedMs": round((time.monotonic() - started) * 1000, 1),
        })
        return {"probe": probe, "bytes": None}

    # Some services gzip without setting Content-Encoding on the wire we see.
    if raw[:2] == b"\x1f\x8b":
        try:
            raw = gzip.decompress(raw)
            probe["gzipDecoded"] = True
        except OSError:
            probe["gzipDecoded"] = False

    probe.update({
        "elapsedMs": round((time.monotonic() - started) * 1000, 1),
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "retryable": False,
    })

    # Cheap structural summary so the artifact is useful without re-reading the payload.
    try:
        parsed = json.loads(raw)
        probe["jsonTopLevelKeys"] = sorted(parsed.keys()) if isinstance(parsed, dict) else None
        probe["jsonIsArray"] = isinstance(parsed, list)
    except (json.JSONDecodeError, UnicodeDecodeError):
        probe["jsonTopLevelKeys"] = None
        probe["parseNote"] = "body is not JSON"

    return {"probe": probe, "bytes": raw}


# --------------------------------------------------------------------------- manifest


def _claim(org_id: str, execution_id: str, meta: dict[str, Any]) -> tuple[bool, str | None]:
    """Insert the manifest row.

    Returns (is_first_delivery, existing_status). When the row already exists the redelivery
    is counted and the stored status is returned, because the two reasons a record can arrive
    twice need opposite handling:

      - EventBridge delivered a genuine duplicate of something already ARCHIVED: skip.
      - SQS is redriving a record whose download failed: download again.

    Treating both as "duplicate, skip" would make the retry path a no-op, so a transient
    download failure would become permanent data loss the moment the URI expired. The
    redelivery counter is retained either way, as evidence for validation 7.
    """
    now = datetime.now(timezone.utc).isoformat()
    try:
        _ddb.put_item(
            TableName=TABLE,
            Item={
                "pk": {"S": f"{org_id}:{execution_id}"},
                "orgId": {"S": org_id},
                "executionId": {"S": execution_id},
                "status": {"S": "EVENT_RECEIVED"},
                "eventReceivedAt": {"S": now},
                "collectorVersion": {"S": COLLECTOR_VERSION},
                "duplicateDeliveries": {"N": "0"},
                **{k: {"S": str(v)} for k, v in meta.items() if v is not None},
            },
            ConditionExpression="attribute_not_exists(pk)",
        )
        return True, None
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        updated = _ddb.update_item(
            TableName=TABLE,
            Key={"pk": {"S": f"{org_id}:{execution_id}"}},
            UpdateExpression=(
                "SET duplicateDeliveries = if_not_exists(duplicateDeliveries, :z) + :one, "
                "lastDuplicateAt = :now"
            ),
            ExpressionAttributeValues={":one": {"N": "1"}, ":z": {"N": "0"}, ":now": {"S": now}},
            ReturnValues="ALL_NEW",
        )
        status = (updated.get("Attributes") or {}).get("status", {}).get("S")
        return False, status


def _set_status(org_id: str, execution_id: str, status: str, **extra: Any) -> None:
    names = {"#s": "status"}
    values = {":s": {"S": status}}
    sets = ["#s = :s"]
    for i, (key, val) in enumerate(extra.items()):
        if val is None:
            continue
        names[f"#k{i}"] = key
        values[f":v{i}"] = {"N": str(val)} if isinstance(val, (int, float)) else {"S": str(val)}
        sets.append(f"#k{i} = :v{i}")

    _ddb.update_item(
        TableName=TABLE,
        Key={"pk": {"S": f"{org_id}:{execution_id}"}},
        UpdateExpression="SET " + ", ".join(sets),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def _put_json(key: str, payload: Any) -> None:
    _s3.put_object(
        Bucket=BUCKET,
        Key=key,
        Body=json.dumps(payload, separators=(",", ":")).encode(),
        ContentType="application/json",
    )


# --------------------------------------------------------------------------- handler


def _prepare(record: dict[str, Any]) -> dict[str, Any] | None:
    """Phase one for a single record: archive the envelope, claim the manifest row, pick a route.

    Returns the work item phase two needs, or None when there is nothing left to retrieve -
    either because the execution is already archived, or because it has been routed to a terminal
    status here.
    """
    envelope, body = _unwrap(record["body"])

    org_id = _org_id_from_source(envelope)
    execution_id = body.get("executionId") or envelope.get("id") or "unknown"
    occurred = body.get("startDateTime") or envelope.get("time") or ""
    uri = body.get("executionHistoryUri")
    ttl = body.get("executionHistoryUriTtl")

    received_at = datetime.now(timezone.utc)
    expiry = None
    if ttl is not None and not isinstance(ttl, bool):
        # The schema says integer seconds, but a JSON producer is free to send 1800.0 or
        # "1800", and silently losing expiry tracking over a type would defeat the queue's
        # expiry-priority behaviour.
        try:
            expiry = received_at + timedelta(seconds=float(ttl))
        except (TypeError, ValueError):
            LOG.warning("uninterpretable executionHistoryUriTtl %r for %s", ttl, execution_id)

    # SQS counts deliveries, which is the only signal that this is the final attempt.
    receive_count = int(record.get("attributes", {}).get("ApproximateReceiveCount", "1"))
    last_attempt = receive_count >= MAX_RECEIVE_COUNT

    envelope_key = _s3_key("envelope", org_id, execution_id, occurred)
    _put_json(envelope_key, envelope)

    first_time, existing_status = _claim(org_id, execution_id, {
        "conversationId": body.get("conversationId"),
        "flowId": body.get("flowId"),
        "flowVersion": body.get("flowVersion"),
        "flowType": body.get("flowType"),
        "flowExitReason": body.get("flowExitReason"),
        "startDateTime": body.get("startDateTime"),
        "endDateTime": body.get("endDateTime"),
        "executionItemsTruncated": body.get("executionItemsTruncated"),
        "executionHistoryUriTtl": ttl,
        "calculatedExpiryAt": expiry.isoformat() if expiry else None,
        "endpoint": body.get("endpoint"),
        "envelopeKey": envelope_key,
        "eventBridgeId": envelope.get("id"),
        "detailType": envelope.get("detail-type"),
    })

    # Only a completed archive makes redelivery genuinely redundant. Anything else is either a
    # retry of a failed download or a record abandoned mid-flight by a worker that died, and
    # both still need the download attempted while the signed URI is alive.
    if not first_time and existing_status in ("ARCHIVED", "FAILED_PERMANENTLY"):
        LOG.info(
            "redelivery of %s:%s already in status %s, retrieval skipped",
            org_id, execution_id, existing_status,
        )
        return None
    if not first_time:
        LOG.info(
            "redelivery of %s:%s in status %s, retrying retrieval",
            org_id, execution_id, existing_status,
        )

    item = {
        "messageId": record["messageId"],
        "orgId": org_id,
        "executionId": execution_id,
        "occurred": occurred,
        "uri": uri,
        "ttl": ttl,
        "expiry": expiry,
        "receivedAt": received_at,
        "eventTime": envelope.get("time"),
        "receiveCount": receive_count,
        "lastAttempt": last_attempt,
        # Truncation is the one quality signal the event carries, and it decides whether the
        # retrieved artifact can be trusted as complete.
        "executionItemsTruncated": body.get("executionItemsTruncated"),
    }

    if execution_id == "unknown":
        # Without an execution id there is nothing to ask the Jobs API for. The envelope is
        # already archived, so the event is not lost, but it cannot be resolved to content.
        _set_status(org_id, execution_id, "FAILED_PERMANENTLY",
                    recoveryReason="event carried no executionId")
        LOG.error("no executionId in event %s", envelope.get("id"))
        return None

    return item


def _archive_direct(item: dict[str, Any]) -> None:
    """Retrieve through the signed URI in the event. Costs no API budget, so always preferred."""
    org_id, execution_id = item["orgId"], item["executionId"]
    occurred, uri, ttl = item["occurred"], item["uri"], item["ttl"]
    expiry, received_at = item["expiry"], item["receivedAt"]
    receive_count, last_attempt = item["receiveCount"], item["lastAttempt"]

    _set_status(org_id, execution_id, "DOWNLOADING")
    result = _download(uri)
    probe = result["probe"]

    # TTL arithmetic belongs in the probe: this is the raw material for validation 5.
    probe.update({
        "executionId": execution_id,
        "orgId": org_id,
        "executionHistoryUriTtlSeconds": ttl,
        "eventTime": item["eventTime"],
        "eventReceivedAt": received_at.isoformat(),
        "calculatedExpiryAt": expiry.isoformat() if expiry else None,
        "secondsFromEventTimeToDownload": _lag_seconds(item["eventTime"], received_at),
    })
    probe_key = _s3_key("probe", org_id, execution_id, occurred)
    _put_json(probe_key, probe)

    raw = result["bytes"]
    if raw is None:
        # A dead signed URI is not data loss: the execution stays inside Genesys's retention
        # window and the Jobs API can still fetch it. Since this collector now retrieves through
        # Jobs in the same invocation, that happens immediately rather than waiting for an
        # out-of-band sweep, so this is a route change and not a failure.
        _set_status(
            org_id, execution_id, "RECOVERY_REQUIRED",
            probeKey=probe_key,
            lastHttpStatus=probe.get("httpStatus"),
            recoveryReason=probe.get("error", "direct download failed"),
            receiveCount=receive_count,
        )
        LOG.warning(
            "direct download failed for %s:%s (status %s); falling back to Jobs in this invocation",
            org_id, execution_id, probe.get("httpStatus"),
        )
        return False

    history_key = _s3_key("history-direct", org_id, execution_id, occurred)
    _s3.put_object(
        Bucket=BUCKET, Key=history_key, Body=raw, ContentType="application/json",
        Metadata={
            "genesys-org-id": org_id,
            "execution-id": execution_id,
            "sha256": probe["sha256"],
            "retrieval-method": "direct-uri",
            "collector-version": COLLECTOR_VERSION,
        },
    )

    _set_status(
        org_id, execution_id, "ARCHIVED",
        archiveLocation=f"s3://{BUCKET}/{history_key}",
        probeKey=probe_key,
        historySha256=probe["sha256"],
        historyBytes=probe["bytes"],
        downloadElapsedMs=probe["elapsedMs"],
        retrievalMethod="direct-uri",
    )
    LOG.info(
        "archived %s:%s  %s bytes in %s ms via direct uri",
        org_id, execution_id, probe["bytes"], probe["elapsedMs"],
    )
    return True


# --------------------------------------------------------------------------- jobs retrieval


def _archive_via_jobs(items: list[dict[str, Any]]) -> list[str]:
    """Retrieve every outstanding execution in as few jobs as possible.

    Returns the message ids that should be reported as batch item failures, so SQS redelivers
    them. Retrieval is attempted for the whole batch in one go; only the executions that actually
    failed are handed back.
    """
    if not items:
        return []

    by_execution = {item["executionId"]: item for item in items}
    for item in items:
        _set_status(item["orgId"], item["executionId"], "RETRIEVING_VIA_JOBS")

    started = time.monotonic()
    try:
        results, meta = jobs.retrieve(list(by_execution))
    except jobs.JobsUnavailable as exc:
        # The API itself is unreachable, which says nothing about any individual execution. Every
        # record goes back to the queue rather than being marked as missing data.
        LOG.warning("Jobs API unavailable, returning %s records to the queue: %s", len(items), exc)
        for item in items:
            _set_status(item["orgId"], item["executionId"], "DOWNLOAD_PENDING",
                        recoveryReason=f"jobs api unavailable: {exc}")
        return [item["messageId"] for item in items]

    job_calls = sum(m.get("apiCalls", 0) for m in meta)
    failures: list[str] = []

    for execution_id, item in by_execution.items():
        org_id = item["orgId"]
        outcome = results.get(execution_id)

        if outcome is None or outcome["failed"] or not outcome.get("downloadUri"):
            status_code = (outcome or {}).get("statusCode")
            # A 404 inside a job that reached Success means the platform holds no history for
            # this execution. That is expected and permanent for an execution that never reached
            # its flow's exit - see the invisibility finding in the validation log - but it is
            # also what a not-yet-written history looks like, so retries are spent before the
            # execution is declared historyless.
            if item["lastAttempt"]:
                _set_status(
                    org_id, execution_id, "NO_HISTORY_AVAILABLE",
                    recoveryReason=f"jobs returned {status_code or 'no entity'} after "
                                   f"{item['receiveCount']} attempts",
                    receiveCount=item["receiveCount"],
                    jobsStatusCode=str(status_code) if status_code else None,
                )
                LOG.warning(
                    "no execution history for %s:%s after %s attempts (jobs said %s); "
                    "the analytics triage path is the only remaining source",
                    org_id, execution_id, item["receiveCount"], status_code,
                )
            else:
                _set_status(org_id, execution_id, "DOWNLOAD_PENDING",
                            recoveryReason=f"jobs returned {status_code or 'no entity'}",
                            receiveCount=item["receiveCount"])
                failures.append(item["messageId"])
            continue

        try:
            raw = jobs.download(outcome["downloadUri"], timeout=DOWNLOAD_TIMEOUT)
        except jobs.JobsUnavailable as exc:
            _set_status(org_id, execution_id, "DOWNLOAD_PENDING",
                        recoveryReason=f"job uri download failed: {exc}")
            failures.append(item["messageId"])
            continue

        digest = hashlib.sha256(raw).hexdigest()
        history_key = _s3_key("history-jobs", org_id, execution_id, item["occurred"])
        _s3.put_object(
            Bucket=BUCKET, Key=history_key, Body=raw, ContentType="application/json",
            Metadata={
                "genesys-org-id": org_id,
                "execution-id": execution_id,
                "sha256": digest,
                "retrieval-method": "jobs",
                "collector-version": COLLECTOR_VERSION,
            },
        )

        probe_key = _s3_key("probe", org_id, execution_id, item["occurred"])
        _put_json(probe_key, {
            "executionId": execution_id,
            "orgId": org_id,
            "retrievalMethod": "jobs",
            "requestedAt": item["receivedAt"].isoformat(),
            "eventTime": item["eventTime"],
            "secondsFromEventTimeToRetrieval": _lag_seconds(item["eventTime"], item["receivedAt"]),
            "bytes": len(raw),
            "sha256": digest,
            "host": urllib.parse.urlparse(outcome["downloadUri"]).netloc,
            "executionItemsTruncated": item["executionItemsTruncated"],
            # The per-execution API cost of this batch, which is the number the architecture's
            # scalability claim rests on. Recorded on every retrieval so the claim stays evidenced
            # in production rather than resting on a one-off probe.
            "batchSize": len(by_execution),
            "batchApiCalls": job_calls,
            "apiCallsPerExecution": round(job_calls / len(by_execution), 3),
            "jobs": meta,
            "batchElapsedMs": round((time.monotonic() - started) * 1000, 1),
        })

        _set_status(
            org_id, execution_id, "ARCHIVED",
            archiveLocation=f"s3://{BUCKET}/{history_key}",
            probeKey=probe_key,
            historySha256=digest,
            historyBytes=len(raw),
            retrievalMethod="jobs",
            apiCallsPerExecution=round(job_calls / len(by_execution), 3),
        )
        LOG.info("archived %s:%s  %s bytes via jobs", org_id, execution_id, len(raw))

    return failures


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """SQS entry point.

    Two phases on purpose. Handling records one at a time would mean one job per execution, and a
    job costs the same 2 API calls whether it carries 1 id or 10, so per-record handling would
    spend 10x the API budget for identical data. Partial batch failure keeps one bad record from
    blocking the rest.
    """
    failures: list[dict[str, str]] = []
    outstanding: list[dict[str, Any]] = []

    for record in event.get("Records", []):
        try:
            item = _prepare(record)
            if item is not None:
                outstanding.append(item)
        except Exception:  # noqa: BLE001 - never lose a record silently
            LOG.exception("permanent failure preparing message %s", record.get("messageId"))
            failures.append({"itemIdentifier": record["messageId"]})

    # The signed URI costs no API budget, so it is tried first whenever one is present - which,
    # on all evidence from this org, is never.
    needs_jobs: list[dict[str, Any]] = []
    for item in outstanding:
        if not item["uri"]:
            needs_jobs.append(item)
            continue
        try:
            if not _archive_direct(item):
                needs_jobs.append(item)
        except Exception:  # noqa: BLE001
            LOG.exception("direct retrieval raised for %s, deferring to jobs", item["executionId"])
            needs_jobs.append(item)

    try:
        failures.extend({"itemIdentifier": mid} for mid in _archive_via_jobs(needs_jobs))
    except Exception:  # noqa: BLE001 - a batch-wide fault must retry, not discard
        LOG.exception("jobs retrieval failed for the whole batch of %s", len(needs_jobs))
        failures.extend({"itemIdentifier": item["messageId"]} for item in needs_jobs)

    return {"batchItemFailures": failures}
