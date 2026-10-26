import json
import os
import pathlib
import sys
import unittest
from datetime import datetime, timezone
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
os.environ.setdefault("AWS_DEFAULT_REGION", "eu-central-1")

import turns_sweep  # noqa: E402

FLOW_ID = "11111111-2222-3333-4444-555555555555"
NOW = datetime(2026, 10, 26, 12, 0, tzinfo=timezone.utc)


class FakeTable:
    def __init__(self):
        self.items = {}

    def get_item(self, Key):
        item = self.items.get(Key["pk"])
        return {"Item": item} if item else {}

    def put_item(self, Item):
        self.items[Item["pk"]] = Item


def turn(session, minute, action):
    return {
        "sessionId": session,
        "conversation": {"id": f"conv-{session}"},
        "dateCreated": f"2026-10-26T11:{minute:02d}:00.000Z",
        "askAction": {"actionNumber": action, "agentDetails": {"agentName": "Synthetic AVA"}},
        "toolCalls": [{"toolName": "lookup", "status": "Success"}],
    }


def page(entities, next_uri=None):
    body = {"entities": entities}
    if next_uri:
        body["nextUri"] = next_uri
    return 200, json.dumps(body).encode()


class SweepFlowTests(unittest.TestCase):
    def setUp(self):
        self.table = FakeTable()
        self.s3 = mock.patch.object(turns_sweep, "_s3").start()
        self.addCleanup(mock.patch.stopall)

    def run_flow(self, responses, previous=None):
        calls = []

        def fake_get(path):
            calls.append(path)
            return responses.pop(0)

        with mock.patch.object(turns_sweep.jobs, "api_get", side_effect=fake_get):
            outcome = turns_sweep._sweep_flow(self.table, "bucket", "org", FLOW_ID, "Flow", previous, "run", NOW)
        return outcome, calls

    def test_follows_continuations_and_advances_watermark(self):
        next_path = f"/api/v2/analytics/botflows/{FLOW_ID}/divisions/reportingturns?after=x"
        outcome, calls = self.run_flow([page([turn("s-1", 0, 1)], next_path), page([turn("s-1", 1, 2), turn("s-2", 2, 1)])])
        self.assertEqual(calls[1], next_path)
        self.assertEqual((outcome["pages"], outcome["turns"], outcome["sessions"]), (2, 3, 2))
        self.assertTrue(outcome["complete"])
        self.assertEqual(outcome["watermark"], "2026-10-26T12:00:00.000Z")
        self.assertEqual(self.table.items["SESSION#s-1"]["turnCount"], 2)
        self.assertEqual(self.table.items["SESSION#s-1"]["conversationId"], "conv-s-1")
        self.assertEqual(self.table.items["SESSION#s-1"]["day"], "2026-10-26")
        self.assertEqual(self.s3.put_object.call_count, 2)

    def test_starts_from_watermark_minus_overlap(self):
        _, calls = self.run_flow([page([])], previous={"watermark": "2026-10-26T11:00:00.000Z"})
        self.assertIn("interval=2026-10-26T09%3A00%3A00.000Z%2F2026-10-26T12%3A00%3A00.000Z", calls[0])

    def test_page_cap_keeps_previous_watermark(self):
        next_path = f"/api/v2/analytics/botflows/{FLOW_ID}/divisions/reportingturns?after=x"
        with mock.patch.object(turns_sweep, "MAX_PAGES_PER_FLOW", 1):
            outcome, _ = self.run_flow([page([turn("s-1", 0, 1)], next_path)], previous={"watermark": "old"})
        self.assertFalse(outcome["complete"])
        self.assertEqual(outcome["watermark"], "old")

    def test_rejects_foreign_continuation(self):
        with self.assertRaises(turns_sweep.SweepError):
            self.run_flow([page([turn("s-1", 0, 1)], "/api/v2/users")])

    def test_rerun_merges_instead_of_duplicating(self):
        self.run_flow([page([turn("s-1", 0, 1)])])
        self.run_flow([page([turn("s-1", 0, 1), turn("s-1", 1, 2)])])
        self.assertEqual(self.table.items["SESSION#s-1"]["turnCount"], 2)

    def test_http_errors_raise(self):
        with self.assertRaises(turns_sweep.SweepError):
            self.run_flow([(400, b"{}")])


if __name__ == "__main__":
    unittest.main()
