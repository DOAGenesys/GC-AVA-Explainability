"""Drive a real bot flow execution so the pipeline has an event to capture.

Why this exists. Gates 1, 4, 5, 6 and 7 are all questions about the *notification* and its
signed URI, so none of them can be answered from the Jobs API - they need an event to actually
arrive. The pipeline was deployed into a shared presales org and then sat idle, because whether
an event appears depends on whether somebody else happens to run a demo. That made the critical
path of the whole validation effort a matter of waiting.

`POST /api/v2/textbots/botflows/sessions` removes the wait. Its summary is "Create an execution
instance of a bot flow definition", and that is exactly the object the architecture is built
around: a flow execution instance, which on completion emits `v2.flows.instances.flow.{id}` with
`executionId` and `executionHistoryUri`. So a session started here produces the same class of
event as a live customer conversation, on demand.

Two properties make this safe on a shared org. The session is the platform's own bot-flow test
facility rather than a side door, and it creates no customer-facing interaction - no call is
placed and no message is sent to anyone. It does consume AVA inference on the target flow, so it
stays deliberately short and is pointed at flows whose names mark them as demo or test assets.

Usage:
  python harness/drive_bot_flow.py --list
  python harness/drive_bot_flow.py --flow-name "Troubleshooting" --say "hello" --say "thanks, bye"
  python harness/drive_bot_flow.py --flow-id <uuid> --turns 4
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import threading
import time
import uuid
from pathlib import Path

import gcapi

REGISTRY = Path(__file__).resolve().parent.parent / "artifacts" / "ava-flow-registry.json"

# Opening utterances chosen to be intent-free and harmless. The goal is a completed execution
# with at least one AVA turn, not a successful task - a flow that cannot understand the input
# still records the turn, the tool deliberation and an exit reason, which is what the gates need.
DEFAULT_SCRIPT = [
    "hello",
    "I have a question about my account",
    "thank you, that is all",
]


def load_registry() -> list[dict]:
    if not REGISTRY.is_file():
        raise SystemExit(f"registry not found: {REGISTRY}\nRun scripts\\gc-build-ava-registry.ps1")
    return json.loads(REGISTRY.read_text(encoding="utf-8-sig"))["avaFlows"]


def pick_flow(flows: list[dict], flow_id: str | None, flow_name: str | None) -> dict:
    if flow_id:
        for flow in flows:
            if flow["id"] == flow_id:
                return flow
        # Not in the registry is a warning, not an error: the registry only holds AVA-enabled
        # flows, and driving a non-AVA flow is still a valid way to test event delivery.
        print(f"  note: {flow_id} is not an AVA-enabled flow in the registry")
        return {"id": flow_id, "name": "<not in registry>", "type": "?"}
    if flow_name:
        matches = [f for f in flows if flow_name.lower() in f["name"].lower() and f["active"]]
        if not matches:
            raise SystemExit(f"no active AVA flow matching '{flow_name}'")
        return matches[0]
    raise SystemExit("pass --flow-id or --flow-name, or --list to choose one")


def launch(client: gcapi.Client, flow: dict, language: str, channel: str) -> tuple[str, str]:
    external_session_id = f"ava-explain-{uuid.uuid4()}"
    payload = {
        "flow": {"id": flow["id"]},
        "externalSessionId": external_session_id,
        "channel": {
            "name": channel,
            "inputModes": ["Text"],
            "outputModes": ["Text"],
            # 'Open' is the neutral third-party-messaging user agent. It avoids implying a real
            # channel like Phone or Whatsapp, which would misrepresent the interaction.
            "userAgent": {"name": "Open"},
        },
        "language": language,
        # The spec marks inputData optional; the API rejects its absence with
        # "Validation failed: inputData: must not be null". An empty variables map satisfies it.
        "inputData": {"variables": {}},
    }
    resp = client.api("/api/v2/textbots/botflows/sessions", method="POST", payload=payload)
    if not resp.ok:
        raise SystemExit(f"launch failed: {resp.status} {resp.error}\n{resp.body[:800].decode()}")
    return resp.json()["id"], external_session_id


def turn(client: gcapi.Client, session_id: str, payload: dict) -> dict:
    resp = client.api(
        f"/api/v2/textbots/botflows/sessions/{session_id}/turns",
        method="POST",
        payload=payload,
    )
    # A finished session rejects further turns; that is a normal end state, not a failure.
    if resp.status == 404:
        return {"nextActionType": "SessionGone"}
    if not resp.ok:
        raise SystemExit(f"turn failed: {resp.status} {resp.error}\n{resp.body[:800].decode()}")
    return resp.json()


def prompts_text(response: dict) -> str:
    """Collect every 'text' string under prompts, whatever the nesting.

    textPrompts is keyed by output mode and its values have varied between a mapping and a list
    across flow types, so walking for text is more durable than indexing a fixed path.
    """
    found: list[str] = []

    def walk(node: object) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "text" and isinstance(value, str):
                    found.append(value)
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(response.get("prompts") or {})
    return " ".join(found).strip()


def pump(
    client: gcapi.Client,
    session_id: str,
    response: dict,
    limit: int = 25,
    delay: float = 2.0,
    verbose: bool = False,
) -> dict:
    """Send NoOp turns while the flow reports NoOp.

    NoOp as a *response* means the flow advanced internally but has nothing to say and is not
    yet waiting on the user - typically it is running an action such as an AVA invocation, which
    is why the accompanying prompt is often just a Typing event. The caller must keep turning the
    crank; treating NoOp as an end state ends the session early and produces an execution with no
    AVA turn in it at all.
    """
    for attempt in range(limit):
        if response.get("nextActionType") != "NoOp":
            return response
        payload: dict = {"inputEventType": "NoOp"}
        if response.get("id"):
            payload["previousTurn"] = {"id": response["id"]}
        response = turn(client, session_id, payload)
        text = prompts_text(response)
        if text:
            print(f"  [bot]  {text}")
        elif verbose:
            print(f"         .. noop {attempt + 1}: {response.get('nextActionType')}")
        if response.get("nextActionType") == "NoOp":
            time.sleep(delay)
    return response


def run(args: argparse.Namespace) -> int:
    config = gcapi.load_org_config()
    client = gcapi.Client(config, ca_bundle=args.ca_bundle)
    flows = load_registry()

    if args.list:
        print(f"  {len(flows)} AVA-enabled flows\n")
        for flow in flows:
            state = "active" if flow["active"] else "inactive"
            print(f"  {flow['id']}  {flow['type']:11} {state:8} {flow['name']}")
        return 0

    flow = pick_flow(flows, args.flow_id, args.flow_name)

    if args.sessions > 1:
        return run_many(client, config, flow, args)

    gcapi.banner(f"Driving {flow['name']} ({flow['type']}) {flow['id']}")
    drive_one(client, config, flow, args, verbose=args.verbose)
    return 0


def run_many(
    client: gcapi.Client, config: gcapi.OrgConfig, flow: dict, args: argparse.Namespace
) -> int:
    """Drive many sessions concurrently to produce event volume.

    Gates 6, 7 and 12 are all volume questions - download throughput, duplicate delivery,
    reconciliation under load - and one event cannot answer any of them. Concurrency is kept
    modest because the point is to exercise the collector, not to stress a shared presales org.
    """
    gcapi.banner(
        f"Driving {args.sessions} sessions x {args.turns} turns "
        f"({args.concurrency} concurrent) against {flow['name']}"
    )
    results: list[dict] = []
    lock = threading.Lock()

    def worker(index: int) -> None:
        try:
            outcome = drive_one(client, config, flow, args, verbose=False, quiet=True)
            with lock:
                results.append(outcome)
                print(
                    f"  [{len(results):3}/{args.sessions}] {outcome['sessionId']} "
                    f"{outcome['finalNextActionType']}  {outcome['botTurns']} bot turns"
                )
        except SystemExit as exc:
            with lock:
                results.append({"index": index, "error": str(exc)})
                print(f"  [{len(results):3}/{args.sessions}] FAILED: {exc}")

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        list(pool.map(worker, range(args.sessions)))

    ok = [r for r in results if not r.get("error")]
    artifact = gcapi.write_artifact(
        f"botflow-batch-{int(time.time())}.json",
        {
            "flow": flow,
            "requested": args.sessions,
            "succeeded": len(ok),
            "concurrency": args.concurrency,
            "turns": args.turns,
            "sessionIds": [r["sessionId"] for r in ok],
            "executionIdsAreSessionIds": True,
            "results": results,
        },
        subdir="driven",
    )
    print(f"\n  {len(ok)}/{args.sessions} sessions completed")
    print(f"  batch -> {artifact}")
    print("\n  Expect one notification per session. Check with:")
    print("    scripts\\pipeline-status.ps1  (via the aws skill wrapper)")
    return 0 if ok else 1


def drive_one(
    client: gcapi.Client,
    config: gcapi.OrgConfig,
    flow: dict,
    args: argparse.Namespace,
    verbose: bool = False,
    quiet: bool = False,
) -> dict:
    def say(text: str) -> None:
        if not quiet:
            print(text)

    session_id, external_session_id = launch(client, flow, args.language, args.channel)
    say(f"  sessionId         : {session_id}")
    say(f"  externalSessionId : {external_session_id}")

    transcript: list[dict] = []
    bot_turns = 0
    # A NoOp opens the conversation and retrieves the greeting without asserting user input.
    response = turn(client, session_id, {"inputEventType": "NoOp"})
    say(f"\n  [greeting] {prompts_text(response) or '(none)'}")
    response = pump(client, session_id, response, verbose=verbose)
    previous_turn = response.get("id")
    transcript.append({"direction": "bot", "text": prompts_text(response), "raw": response})

    script = args.say or DEFAULT_SCRIPT
    for index in range(args.turns):
        next_action = response.get("nextActionType")
        if next_action != "WaitForInput":
            say(f"\n  session no longer awaiting input (nextActionType={next_action})")
            break
        utterance = script[index % len(script)]
        say(f"\n  [user] {utterance}")
        payload = {
            "inputEventType": "UserInput",
            "inputEventUserInput": {
                "mode": "Text",
                # An alternative is {"transcript": {"text": ..., "confidence": ...}}. Neither
                # 'utterance' nor a bare string transcript is accepted.
                "alternatives": [{"transcript": {"text": utterance, "confidence": 1.0}}],
            },
        }
        if previous_turn:
            payload["previousTurn"] = {"id": previous_turn}
        response = turn(client, session_id, payload)
        text = prompts_text(response)
        say(f"  [bot]  {text or '(no prompt)'}")
        response = pump(client, session_id, response, verbose=verbose)
        previous_turn = response.get("id") or previous_turn
        bot_turns += 1
        transcript.append({"direction": "user", "text": utterance})
        transcript.append({"direction": "bot", "text": text, "raw": response})
        if response.get("nextActionType") in ("Disconnect", "Exit", "SessionGone"):
            break
        time.sleep(args.delay)

    # The notification is emitted on flow end, so the session has to stop being open. But a
    # UserDisconnect sent while the bot is still waiting for input is NOT equivalent to the flow
    # running to its own exit: measured on two flows, sessions ending Disconnect/TriggeredByUser
    # produced no execution history at all (absent from /flows/instances/query, and the Jobs API
    # returns 404 for the id), and therefore no event. Sessions ending Exit/TriggeredByFlow
    # produced history and an event every time. So this disconnect is a way to stop leaking open
    # sessions, not a way to manufacture an observable execution.
    final = response.get("nextActionType")
    forced = False
    if final == "WaitForInput":
        say("\n  disconnecting to close the session (script exhausted, flow still asking) ...")
        response = turn(client, session_id, {"inputEventType": "UserDisconnect"})
        final = response.get("nextActionType")
        forced = True

    exit_action = response.get("nextActionExit") or response.get("nextActionDisconnect") or {}
    say(f"\n  final nextActionType : {final}")
    if exit_action.get("reason"):
        say(f"  reason               : {exit_action['reason']}")
    if exit_action.get("flowOutcomes"):
        say(f"  outcomes             : {exit_action['flowOutcomes']}")

    result = {
        "flowId": flow["id"],
        "sessionId": session_id,
        "externalSessionId": external_session_id,
        "apiHost": config.api_host,
        "finalNextActionType": final,
        "exitReason": exit_action.get("reason"),
        "botTurns": bot_turns,
        # False means the flow never reached its own exit, so this session is not expected to
        # produce execution history or an event and must not be counted as a delivery miss.
        "flowReachedOwnExit": not forced,
    }

    if not quiet:
        artifact = gcapi.write_artifact(
            f"botflow-session-{session_id}.json",
            {**result, "flow": flow, "transcript": transcript},
            subdir="driven",
        )
        print(f"\n  transcript -> {artifact}")
        if forced:
            print(
                "\n  WARNING: the script ran out while the flow was still asking for input, so the"
                "\n  session was force-disconnected. Executions ended this way produce no execution"
                "\n  history and no notification - there is nothing for the pipeline to pick up."
                "\n  Extend --say so the flow reaches its own exit before judging delivery."
            )
        else:
            print("\n  The flow reached its own exit. Watch for the notification with:")
            print("    powershell -File scripts\\wait-for-first-event.ps1")
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--flow-id")
    ap.add_argument("--flow-name", help="substring match against active AVA-enabled flows")
    ap.add_argument("--list", action="store_true", help="list AVA-enabled flows and exit")
    ap.add_argument("--say", action="append", help="an utterance; repeat for a multi-turn script")
    ap.add_argument("--turns", type=int, default=3, help="maximum user turns to send")
    ap.add_argument("--language", default="en-us")
    ap.add_argument("--channel", default="Messaging", choices=["Chat", "Call", "Messaging"])
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between turns")
    ap.add_argument("--verbose", action="store_true", help="log every NoOp poll")
    ap.add_argument("--sessions", type=int, default=1, help="how many sessions to drive")
    ap.add_argument("--concurrency", type=int, default=4, help="parallel sessions when --sessions>1")
    ap.add_argument("--ca-bundle")
    return run(ap.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
