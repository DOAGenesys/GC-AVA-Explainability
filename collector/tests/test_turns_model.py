import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import turns_model  # noqa: E402

FLOW_ID = "11111111-2222-3333-4444-555555555555"


def make_turn(minute: int, action: int, *, tools=None, result="NoMatch", end=None, session="s-1", **extra):
    turn = {
        "sessionId": session,
        "conversation": {"id": "c-1"},
        "dateCreated": f"2026-10-26T10:{minute:02d}:00.000Z",
        "dateCompleted": f"2026-10-26T10:{minute:02d}:30.000Z",
        "executionFrameId": f"frame-{action}",
        "userInput": "synthetic input",
        "botPrompts": ["synthetic prompt"],
        "askAction": {
            "actionNumber": action,
            "actionType": "AgenticVirtualAgent",
            "actionName": "Agentic Virtual Agent",
            "agentDetails": {"agentId": "a-1", "agentName": "Synthetic AVA", "agentVersion": "3"},
        },
        "askActionResult": result,
        "toolCalls": tools or [],
        **extra,
    }
    if end:
        turn["sessionEndDetails"] = end
    return turn


def tool(name, status="Success", latency=120):
    return {
        "toolName": name,
        "toolType": "DataAction",
        "toolId": f"{name}-id",
        "targetId": f"{name}-target",
        "status": status,
        "origin": "AvaTool",
        "latencyMs": latency,
        "dateInvoked": "2026-10-26T10:00:10.000Z",
    }


class NormalizeTurnTests(unittest.TestCase):
    def test_keeps_tool_calls_and_agent_details(self):
        normalized = turns_model.normalize_turn(make_turn(0, 1, tools=[tool("lookup")]))
        self.assertEqual(normalized["agentName"], "Synthetic AVA")
        self.assertEqual(normalized["agentVersion"], "3")
        self.assertEqual(normalized["toolCalls"][0]["toolName"], "lookup")
        self.assertEqual(normalized["toolCalls"][0]["latencyMs"], 120)
        self.assertEqual(normalized["key"], "2026-10-26T10:00:00.000Z|1|frame-1")

    def test_tolerates_missing_and_malformed_fields(self):
        normalized = turns_model.normalize_turn({"dateCreated": "2026-10-26T10:00:00Z", "askAction": "bad", "toolCalls": "bad"})
        self.assertEqual(normalized["toolCalls"], [])
        self.assertIsNone(normalized["agentName"])
        self.assertIsNone(normalized["sessionEnd"])

    def test_accepts_guardrail_lists_under_any_guardrail_key(self):
        normalized = turns_model.normalize_turn(
            make_turn(0, 1, guardrailEvents=[{"type": "Topic", "violationsTriggered": 2, "violationsThreshold": 3, "instruction": "x"}])
        )
        self.assertEqual(normalized["guardrails"], [{"type": "Topic", "violationsTriggered": 2, "violationsThreshold": 3}])

    def test_summarises_knowledge_metadata_without_answer_text(self):
        call = tool("kb")
        call["knowledgeMetadata"] = {"knowledgeName": "FAQ", "retrievalStatus": "Success", "generatedAnswer": "long", "retrievedSources": [{}, {}]}
        normalized = turns_model.normalize_turn(make_turn(0, 1, tools=[call]))
        self.assertEqual(normalized["toolCalls"][0]["knowledge"]["retrievedSources"], 2)
        self.assertNotIn("generatedAnswer", normalized["toolCalls"][0]["knowledge"])


class SessionTests(unittest.TestCase):
    def test_groups_by_session_and_keeps_conversation(self):
        sessions = turns_model.group_by_session([make_turn(0, 1), make_turn(1, 2), make_turn(2, 1, session="s-2"), {"no": "session"}])
        self.assertEqual(sorted(sessions), ["s-1", "s-2"])
        self.assertEqual(sessions["s-1"]["conversationId"], "c-1")
        self.assertEqual(len(sessions["s-1"]["turns"]), 2)

    def test_merge_is_idempotent_across_overlapping_windows(self):
        first = [turns_model.normalize_turn(make_turn(0, 1)), turns_model.normalize_turn(make_turn(1, 2))]
        second = [turns_model.normalize_turn(make_turn(1, 2, result="Success")), turns_model.normalize_turn(make_turn(2, 3))]
        merged = turns_model.merge_turns(first, second)
        self.assertEqual([t["actionNumber"] for t in merged], [1, 2, 3])
        self.assertEqual(merged[1]["result"], "Success")
        self.assertEqual(turns_model.merge_turns(merged, second), merged)

    def test_summary_counts_tools_failures_guardrails_and_end(self):
        turns = [
            turns_model.normalize_turn(make_turn(0, 1, tools=[tool("a"), tool("b", status="Failure")])),
            turns_model.normalize_turn(make_turn(1, 2, result="GuardrailsViolation")),
            turns_model.normalize_turn(make_turn(2, 3, end={"type": "Exit", "reason": "Completed"})),
        ]
        summary = turns_model.summarize_session(turns)
        self.assertEqual(summary["turnCount"], 3)
        self.assertEqual(summary["toolCallCount"], 2)
        self.assertEqual(summary["toolFailureCount"], 1)
        self.assertEqual(summary["guardrailCount"], 1)
        self.assertEqual(summary["endType"], "Exit")
        self.assertEqual(summary["firstTurnAt"], "2026-10-26T10:00:00.000Z")
        self.assertEqual(summary["lastTurnAt"], "2026-10-26T10:02:30.000Z")

    def test_serialize_drops_oldest_turns_to_fit(self):
        turns = [turns_model.normalize_turn(make_turn(m, m + 1)) for m in range(10)]
        full, truncated = turns_model.serialize_turns(turns, 1_000_000)
        self.assertFalse(truncated)
        self.assertEqual(len(json.loads(full)), 10)
        limited, truncated = turns_model.serialize_turns(turns, len(full.encode()) // 2)
        self.assertTrue(truncated)
        kept = json.loads(limited)
        self.assertLess(len(kept), 10)
        self.assertEqual(kept[-1]["actionNumber"], 10)


class ContinuationTests(unittest.TestCase):
    def test_accepts_relative_and_absolute_continuations_for_the_same_flow(self):
        path = f"/api/v2/analytics/botflows/{FLOW_ID}/divisions/reportingturns?after=abc&pageSize=250"
        self.assertEqual(turns_model.safe_next_path(path, FLOW_ID), path)
        self.assertEqual(turns_model.safe_next_path("https://api.mypurecloud.de" + path, FLOW_ID), path)

    def test_rejects_other_paths(self):
        self.assertIsNone(turns_model.safe_next_path("/api/v2/users/me", FLOW_ID))
        self.assertIsNone(turns_model.safe_next_path(f"/api/v2/analytics/botflows/other/divisions/reportingturns", FLOW_ID))
        self.assertIsNone(
            turns_model.safe_next_path(f"/api/v2/analytics/botflows/{FLOW_ID}/divisions/reportingturns/../../x", FLOW_ID)
        )
        self.assertIsNone(turns_model.safe_next_path(None, FLOW_ID))


if __name__ == "__main__":
    unittest.main()
