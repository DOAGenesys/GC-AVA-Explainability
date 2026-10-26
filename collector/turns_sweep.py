"""Scheduled server-side sweep of Bot Flow Reporting Turns into durable storage.

Triggered hourly by an EventBridge schedule. The partner-bus collector only learns about
executions that reach their flow's exit; this sweep closes that gap by pulling every AVA session
Genesys Cloud reports, whether or not it exited, and persisting it before the platform's
retention (about 10 days) drops it:

    bronze/turns/dt=YYYY-MM-DD/org=<org>/flow=<flowId>/<runId>-pNNN.json   raw pages, unmodified
    DynamoDB  SESSION#<sessionId>                                          merged session record
    DynamoDB  SWEEP#<flowId>                                               per-flow watermark

Each run asks for [watermark - overlap, now]. Overlap plus merge-by-turn-key makes re-reading
harmless, so a late turn or a failed run is recovered by the next one. A flow's watermark only
advances when its pages were read to the end; a page cap or a timeout leaves it where it was.

Nothing here logs conversation content: log lines carry ids, counts and HTTP statuses only.
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key

import jobs
import turns_model

LOG = logging.getLogger()
LOG.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

PAGE_SIZE = int(os.environ.get("TURNS_PAGE_SIZE", "250"))
MAX_PAGES_PER_FLOW = int(os.environ.get("TURNS_MAX_PAGES_PER_FLOW", "40"))
OVERLAP = timedelta(minutes=int(os.environ.get("TURNS_OVERLAP_MINUTES", "120")))
# The platform's retention is about 10 days; asking right at the edge returns 400s.
MAX_LOOKBACK = timedelta(days=float(os.environ.get("TURNS_MAX_LOOKBACK_DAYS", "9.9")))
SESSION_TTL = timedelta(days=int(os.environ.get("TURNS_SESSION_TTL_DAYS", "30")))
# DynamoDB items cap at 400 KB; the summary attributes need a little of that.
TURNS_JSON_MAX_BYTES = 350_000
# Stop starting new flows when less than this is left, so watermarks are written cleanly.
TIME_RESERVE_MS = 45_000
SWEEP_DAY = "SWEEP"
AVA_FLOW_TYPES = ("digitalbot", "bot")

_s3 = boto3.client("s3")
_dynamodb = boto3.resource("dynamodb")


class SweepError(Exception):
    """A flow could not be swept this run; its watermark stays put."""


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _get_json(path: str) -> tuple[int, Any]:
    status, raw = jobs.api_get(path)
    if status != 200:
        return status, None
    return status, json.loads(raw)


def list_ava_flows() -> dict[str, str]:
    """Every published Bot or Digital Bot flow that hosts an AVA, as {flowId: name}."""
    flows: dict[str, str] = {}
    for flow_type in AVA_FLOW_TYPES:
        page = 1
        while True:
            status, body = _get_json(f"/api/v2/flows?type={flow_type}&pageSize=100&pageNumber={page}")
            if status != 200:
                raise SweepError(f"flow listing for {flow_type} returned {status}")
            for entity in body.get("entities") or []:
                published = entity.get("publishedVersion") or {}
                if entity.get("id") and (
                    entity.get("agenticVirtualAgentEnabled") or published.get("agenticVirtualAgentEnabled")
                ):
                    flows[entity["id"]] = entity.get("name") or entity["id"]
            if page >= int(body.get("pageCount") or 1):
                break
            page += 1
    return flows


def _sweep_items(table: Any) -> dict[str, dict[str, Any]]:
    items: dict[str, dict[str, Any]] = {}
    kwargs: dict[str, Any] = {"IndexName": "day-index", "KeyConditionExpression": Key("day").eq(SWEEP_DAY)}
    while True:
        page = table.query(**kwargs)
        for item in page.get("Items", []):
            if item.get("flowId"):
                items[item["flowId"]] = item
        if "LastEvaluatedKey" not in page:
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _fetch_pages(flow_id: str, start: datetime, end: datetime) -> tuple[list[tuple[bytes, dict]], bool]:
    query = urllib.parse.urlencode({"interval": f"{_iso(start)}/{_iso(end)}", "pageSize": PAGE_SIZE})
    path: str | None = f"/api/v2/analytics/botflows/{flow_id}/divisions/reportingturns?{query}"
    pages: list[tuple[bytes, dict]] = []
    while path and len(pages) < MAX_PAGES_PER_FLOW:
        status, raw = jobs.api_get(path)
        if status == 404:
            return pages, True
        if status != 200:
            raise SweepError(f"reporting turns returned {status}")
        body = json.loads(raw)
        pages.append((raw, body))
        next_uri = body.get("nextUri")
        if not next_uri:
            return pages, True
        path = turns_model.safe_next_path(next_uri, flow_id)
        if path is None:
            raise SweepError("continuation pointed outside this flow's reporting turns")
    return pages, False


def _archive_pages(bucket: str, org_id: str, flow_id: str, run_id: str, pages: list[tuple[bytes, dict]], now: datetime) -> None:
    prefix = f"bronze/turns/dt={now:%Y-%m-%d}/org={org_id}/flow={flow_id}/{run_id}"
    for index, (raw, _) in enumerate(pages, start=1):
        _s3.put_object(
            Bucket=bucket,
            Key=f"{prefix}-p{index:03d}.json",
            Body=raw,
            ContentType="application/json",
            ServerSideEncryption="AES256",
        )


def _store_sessions(table: Any, flow_id: str, flow_name: str, sessions: dict[str, dict[str, Any]], now: datetime) -> int:
    expires_at = int((now + SESSION_TTL).timestamp())
    stored = 0
    for session_id, incoming in sessions.items():
        key = {"pk": f"SESSION#{session_id}"}
        existing = table.get_item(Key=key).get("Item") or {}
        try:
            previous = json.loads(existing.get("turnsJson") or "[]")
        except ValueError:
            previous = []
        turns = turns_model.merge_turns(previous, incoming["turns"])
        summary = turns_model.summarize_session(turns)
        if not summary["firstTurnAt"]:
            continue
        turns_json, truncated = turns_model.serialize_turns(turns, TURNS_JSON_MAX_BYTES)
        item = {
            **key,
            "kind": "session",
            "sessionId": session_id,
            "flowId": flow_id,
            "flowName": flow_name,
            "day": summary["firstTurnAt"][:10],
            "turnsJson": turns_json,
            "turnsTruncated": truncated,
            "updatedAt": _iso(now),
            "expiresAt": expires_at,
            **{name: value for name, value in summary.items() if value is not None},
        }
        conversation_id = incoming.get("conversationId") or existing.get("conversationId")
        if conversation_id:
            item["conversationId"] = conversation_id
        table.put_item(Item=item)
        stored += 1
    return stored


def _sweep_flow(table: Any, bucket: str, org_id: str, flow_id: str, flow_name: str, previous: dict[str, Any] | None, run_id: str, now: datetime) -> dict[str, Any]:
    oldest = now - MAX_LOOKBACK
    watermark = _parse_iso((previous or {}).get("watermark"))
    start = max(watermark - OVERLAP, oldest) if watermark else oldest
    started = time.monotonic()
    pages, complete = _fetch_pages(flow_id, start, now)
    turns = [turn for _, body in pages for turn in body.get("entities") or []]
    if pages and turns:
        _archive_pages(bucket, org_id, flow_id, run_id, pages, now)
    sessions = turns_model.group_by_session(turns)
    stored = _store_sessions(table, flow_id, flow_name, sessions, now)
    return {
        "pages": len(pages),
        "turns": len(turns),
        "sessions": stored,
        "complete": complete,
        "watermark": _iso(now) if complete else (previous or {}).get("watermark"),
        "durationMs": int((time.monotonic() - started) * 1000),
    }


def _write_watermark(table: Any, flow_id: str, flow_name: str, now: datetime, outcome: dict[str, Any]) -> None:
    item = {
        "pk": f"SWEEP#{flow_id}",
        "kind": "sweep",
        "day": SWEEP_DAY,
        "firstTurnAt": _iso(now),
        "flowId": flow_id,
        "flowName": flow_name,
        "lastRunAt": _iso(now),
        "lastRunComplete": bool(outcome.get("complete")),
        "lastRunPages": int(outcome.get("pages") or 0),
        "lastRunTurns": int(outcome.get("turns") or 0),
        "lastRunSessions": int(outcome.get("sessions") or 0),
    }
    if outcome.get("watermark"):
        item["watermark"] = outcome["watermark"]
    if outcome.get("error"):
        item["lastError"] = outcome["error"][:200]
    table.put_item(Item=item)


def handler(event: dict[str, Any] | None, context: Any) -> dict[str, Any]:
    table = _dynamodb.Table(os.environ["TURNS_TABLE"])
    bucket = os.environ["BRONZE_BUCKET"]
    org_id = os.environ.get("GENESYS_ORG_ID") or "unknown-org"
    now = datetime.now(timezone.utc)
    run_id = now.strftime("%Y%m%dT%H%M%SZ")

    previous = _sweep_items(table)
    requested = [flow for flow in (event or {}).get("flowIds") or [] if isinstance(flow, str)]
    if requested:
        flows = {flow_id: previous.get(flow_id, {}).get("flowName") or flow_id for flow_id in requested}
    else:
        # Flows swept before stay in scope even if their AVA flag is later cleared, so sessions
        # already inside retention are not abandoned mid-window.
        flows = {flow_id: item.get("flowName") or flow_id for flow_id, item in previous.items()}
        flows.update(list_ava_flows())
    for extra in filter(None, (os.environ.get("TURNS_EXTRA_FLOW_IDS") or "").split(",")):
        flows.setdefault(extra.strip(), extra.strip())

    totals = {"flows": len(flows), "swept": 0, "skipped": 0, "failed": 0, "pages": 0, "turns": 0, "sessions": 0, "incomplete": 0}
    for flow_id, flow_name in flows.items():
        if context is not None and context.get_remaining_time_in_millis() < TIME_RESERVE_MS:
            totals["skipped"] += 1
            continue
        try:
            outcome = _sweep_flow(table, bucket, org_id, flow_id, flow_name, previous.get(flow_id), run_id, now)
        except (SweepError, jobs.JobsUnavailable) as exc:
            outcome = {"complete": False, "watermark": previous.get(flow_id, {}).get("watermark"), "error": str(exc)}
            totals["failed"] += 1
            LOG.warning("sweep failed for flow %s: %s", flow_id, type(exc).__name__)
        else:
            totals["swept"] += 1
            totals["pages"] += outcome["pages"]
            totals["turns"] += outcome["turns"]
            totals["sessions"] += outcome["sessions"]
            totals["incomplete"] += 0 if outcome["complete"] else 1
            if outcome["turns"]:
                LOG.info(
                    "flow %s: %s pages, %s turns, %s sessions, complete=%s, %sms",
                    flow_id, outcome["pages"], outcome["turns"], outcome["sessions"], outcome["complete"], outcome["durationMs"],
                )
        _write_watermark(table, flow_id, flow_name, now, outcome)

    LOG.info("turns sweep %s: %s", run_id, json.dumps(totals))
    return {"runId": run_id, **totals}
