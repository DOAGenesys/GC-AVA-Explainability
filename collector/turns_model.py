"""Pure model for Bot Flow Reporting Turns: normalisation, merging and session summaries.

No AWS or network imports, so the shape decisions can be tested without credentials.

Why this source exists alongside the EventBridge collector: an execution that never reaches its
flow's exit writes no execution history, emits no `v2.flows.instances.flow.{id}` notification, and
answers 404 from the Jobs API permanently. Reporting Turns still records those sessions, and since
the September and October 2026 releases each AVA turn carries its tool calls (name, type, status,
latency, origin) and the AVA's id, name and version. Measured on 26 October 2026 against a session
that ran four tools and never exited: all six turns and all four tool calls were returned.

What it does not carry is the tool input and output payloads, which only the execution history has.
"""

from __future__ import annotations

import json
from typing import Any

TURN_FIELDS_LIMIT = 4000

# Seen live: toolCalls[] and askAction.agentDetails. Guardrail outcomes are declared in the public
# definition (ReportingTurnGuardrailEvent) but not yet referenced by ReportingTurn and not yet
# observed, so any list-valued key mentioning guardrails is accepted rather than one guessed name.
GUARDRAIL_KEY_HINT = "guardrail"
GUARDRAIL_RESULT = "GuardrailsViolation"
SUCCESS_STATUS = "Success"


def _text(value: Any, limit: int = TURN_FIELDS_LIMIT) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text[:limit] if text else None


def _number(value: Any) -> int | float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def turn_key(turn: dict[str, Any]) -> str:
    """Identity of a turn across overlapping sweep windows."""
    return "|".join(
        str(part or "")
        for part in (turn.get("dateCreated"), turn.get("actionNumber"), turn.get("executionFrameId"))
    )


def normalize_tool_call(call: dict[str, Any]) -> dict[str, Any]:
    knowledge = call.get("knowledgeMetadata") if isinstance(call.get("knowledgeMetadata"), dict) else None
    normalized: dict[str, Any] = {
        "toolName": _text(call.get("toolName"), 200) or "(unnamed tool)",
        "toolType": _text(call.get("toolType"), 100),
        "toolId": _text(call.get("toolId"), 200),
        "targetId": _text(call.get("targetId"), 200),
        "status": _text(call.get("status"), 100),
        "origin": _text(call.get("origin"), 100),
        "latencyMs": _number(call.get("latencyMs")),
        "dateInvoked": _text(call.get("dateInvoked"), 64),
        "errorText": _text(call.get("errorText"), 1000),
    }
    if knowledge:
        sources = knowledge.get("retrievedSources")
        normalized["knowledge"] = {
            "knowledgeName": _text(knowledge.get("knowledgeName"), 200),
            "retrievalStatus": _text(knowledge.get("retrievalStatus"), 100),
            "answerGenerationStatus": _text(knowledge.get("answerGenerationStatus"), 100),
            "topConfidence": _number(knowledge.get("topConfidence")),
            "failureReason": _text(knowledge.get("failureReason"), 500),
            "retrievedSources": len(sources) if isinstance(sources, list) else None,
        }
    return normalized


def _guardrail_events(turn: dict[str, Any]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for key, value in turn.items():
        if GUARDRAIL_KEY_HINT not in key.lower() or not isinstance(value, list):
            continue
        for item in value:
            if isinstance(item, dict):
                events.append({
                    "type": _text(item.get("type"), 100),
                    "violationsTriggered": _number(item.get("violationsTriggered")),
                    "violationsThreshold": _number(item.get("violationsThreshold")),
                })
    return events


def normalize_turn(turn: dict[str, Any]) -> dict[str, Any]:
    ask = turn.get("askAction") if isinstance(turn.get("askAction"), dict) else {}
    agent = ask.get("agentDetails") if isinstance(ask.get("agentDetails"), dict) else {}
    end = turn.get("sessionEndDetails") if isinstance(turn.get("sessionEndDetails"), dict) else None
    intent = turn.get("intent") if isinstance(turn.get("intent"), dict) else {}
    knowledge_events = turn.get("knowledgeBaseEvents") if isinstance(turn.get("knowledgeBaseEvents"), dict) else {}
    prompts = turn.get("botPrompts") if isinstance(turn.get("botPrompts"), list) else []
    tool_calls = turn.get("toolCalls") if isinstance(turn.get("toolCalls"), list) else []

    normalized = {
        "dateCreated": _text(turn.get("dateCreated"), 64),
        "dateCompleted": _text(turn.get("dateCompleted"), 64),
        "actionNumber": ask.get("actionNumber"),
        "executionFrameId": _text(turn.get("executionFrameId"), 200),
        "userInput": _text(turn.get("userInput")),
        "botPrompts": [p for p in (_text(prompt) for prompt in prompts) if p],
        "actionType": _text(ask.get("actionType"), 100),
        "actionName": _text(ask.get("actionName"), 200),
        "result": _text(turn.get("askActionResult"), 100),
        "agentId": _text(agent.get("agentId"), 200),
        "agentName": _text(agent.get("agentName"), 200),
        "agentVersion": _text(agent.get("agentVersion"), 50),
        "intent": _text(intent.get("name"), 200),
        "knowledgeSearches": len(knowledge_events.get("search") or []) if isinstance(knowledge_events.get("search"), list) else 0,
        "toolCalls": [normalize_tool_call(c) for c in tool_calls if isinstance(c, dict)],
        "guardrails": _guardrail_events(turn),
        "sessionEnd": {"type": _text(end.get("type"), 50), "reason": _text(end.get("reason"), 200)} if end else None,
    }
    normalized["key"] = turn_key(normalized)
    return normalized


def group_by_session(turns: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Group raw page entities into {sessionId: {conversationId, turns}}."""
    sessions: dict[str, dict[str, Any]] = {}
    for turn in turns:
        if not isinstance(turn, dict) or not turn.get("sessionId"):
            continue
        session = sessions.setdefault(turn["sessionId"], {"conversationId": None, "turns": []})
        conversation = turn.get("conversation") if isinstance(turn.get("conversation"), dict) else {}
        session["conversationId"] = session["conversationId"] or conversation.get("id")
        session["turns"].append(normalize_turn(turn))
    return sessions


def merge_turns(existing: list[dict[str, Any]], incoming: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_key = {turn["key"]: turn for turn in existing if isinstance(turn, dict) and turn.get("key")}
    for turn in incoming:
        by_key[turn["key"]] = turn
    return sorted(by_key.values(), key=lambda turn: (turn.get("dateCreated") or "", str(turn.get("actionNumber") or "")))


def summarize_session(turns: list[dict[str, Any]]) -> dict[str, Any]:
    created = [t["dateCreated"] for t in turns if t.get("dateCreated")]
    finished = [t.get("dateCompleted") or t.get("dateCreated") for t in turns if t.get("dateCompleted") or t.get("dateCreated")]
    calls = [call for turn in turns for call in turn.get("toolCalls") or []]
    agent = next((t for t in reversed(turns) if t.get("agentName") or t.get("agentId")), {})
    end = next((t["sessionEnd"] for t in reversed(turns) if t.get("sessionEnd")), None)
    guardrails = sum(len(t.get("guardrails") or []) for t in turns) + sum(
        1 for t in turns if t.get("result") == GUARDRAIL_RESULT
    )
    return {
        "firstTurnAt": min(created) if created else None,
        "lastTurnAt": max(finished) if finished else None,
        "turnCount": len(turns),
        "toolCallCount": len(calls),
        "toolFailureCount": sum(1 for call in calls if call.get("status") and call["status"] != SUCCESS_STATUS),
        "guardrailCount": guardrails,
        "knowledgeSearchCount": sum(int(t.get("knowledgeSearches") or 0) for t in turns),
        "agentId": agent.get("agentId"),
        "agentName": agent.get("agentName"),
        "agentVersion": agent.get("agentVersion"),
        "endType": end.get("type") if end else None,
        "endReason": end.get("reason") if end else None,
        "lastResult": next((t["result"] for t in reversed(turns) if t.get("result")), None),
    }


def serialize_turns(turns: list[dict[str, Any]], max_bytes: int) -> tuple[str, bool]:
    """JSON-encode turns, keeping the newest that fit inside a DynamoDB item budget."""
    kept = list(turns)
    while kept:
        encoded = json.dumps(kept, separators=(",", ":"), ensure_ascii=False)
        if len(encoded.encode("utf-8")) <= max_bytes:
            return encoded, len(kept) < len(turns)
        kept = kept[1:]
    return "[]", bool(turns)


def safe_next_path(next_uri: str | None, flow_id: str) -> str | None:
    """Accept a continuation only if it points back at this flow's reporting-turns endpoint."""
    if not next_uri:
        return None
    path = next_uri
    if "://" in path:
        path = "/" + path.split("://", 1)[1].split("/", 1)[-1]
    expected = f"/api/v2/analytics/botflows/{flow_id}/divisions/reportingturns"
    return path if path.split("?", 1)[0].lower() == expected.lower() else None
