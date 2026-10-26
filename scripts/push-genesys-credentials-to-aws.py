"""Copy the Genesys OAuth client credentials from an MCP config into AWS Secrets Manager.

The collector and the turns sweep authenticate with a client-credentials grant whose secret lives
in Secrets Manager as {"clientId": ..., "clientSecret": ...}. This script moves the values from the
AVA harness entry of a per-org mcp.json into that secret without them ever being printed.

Leak-proof by construction:
  - the values are read into two local variables and used only to build the SecretString;
  - output is an allowlist: key names, value lengths, presence, the secret name, its ARN, the
    action taken and the habitat;
  - every line is scrubbed against the loaded values before printing;
  - any exception prints only its type and line number.

Dry run (no AWS call), always first against a fake copy:
    python scripts/push-genesys-credentials-to-aws.py --mcp-config <fake.json> --dry-run

Real run, through the aws skill wrapper so AWS credentials stay in the child environment:
    powershell -File %USERPROFILE%\\.cursor\\skills\\aws\\scripts\\aws-exec.ps1 -Region eu-central-1 `
      -Run "<venv python> scripts\\push-genesys-credentials-to-aws.py"
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

DEFAULT_MCP_CONFIG = Path(
    r"C:\Users\<user>\cursor\AVA skills MCP Cursor files\<org-folder>\mcp.json"
)
DEFAULT_SECRET_NAME = "ava-explain/genesys-oauth"
CLIENT_ID_KEY = "GENESYS_CLIENT_ID"
CLIENT_SECRET_KEY = "GENESYS_CLIENT_SECRET"

loaded_secret_values: list[str] = []


def print_scrubbed(line: str) -> None:
    for value in loaded_secret_values:
        if value:
            line = line.replace(value, "***")
    print(line)


def load_client_credentials(mcp_config: Path, server_name: str) -> tuple[str, str, str]:
    raw = json.loads(mcp_config.read_text(encoding="utf-8-sig"))
    servers = raw.get("mcpServers") if isinstance(raw, dict) else None
    entry = servers.get(server_name) if isinstance(servers, dict) else None
    env_block = entry.get("env") if isinstance(entry, dict) else None
    if not isinstance(env_block, dict):
        raise SystemExit(f"no env block for server '{server_name}'")

    client_id = env_block.get(CLIENT_ID_KEY) or ""
    client_secret = env_block.get(CLIENT_SECRET_KEY) or ""
    habitat = str(env_block.get("AVA_HABITAT") or "")
    loaded_secret_values.extend([client_id, client_secret])
    del env_block, entry, servers, raw

    for key, value in ((CLIENT_ID_KEY, client_id), (CLIENT_SECRET_KEY, client_secret)):
        state = "MISSING" if not value else (
            "PLACEHOLDER" if value.startswith("${") else f"set (len {len(value)})"
        )
        print_scrubbed(f"  {key}: {state}")
    if not client_id or not client_secret or client_id.startswith("${") or client_secret.startswith("${"):
        raise SystemExit("credentials incomplete; nothing written")
    return client_id, client_secret, habitat


def store_secret(secret_name: str, secret_string: str) -> None:
    import boto3
    from botocore.exceptions import ClientError

    logging.getLogger("botocore").setLevel(logging.CRITICAL)
    client = boto3.client("secretsmanager")
    try:
        described = client.describe_secret(SecretId=secret_name)
        client.put_secret_value(SecretId=described["ARN"], SecretString=secret_string)
        action, arn = "updated (new version)", described["ARN"]
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") != "ResourceNotFoundException":
            raise
        created = client.create_secret(
            Name=secret_name,
            Description="Genesys Cloud OAuth client credentials for the AVA explainability collectors",
            SecretString=secret_string,
            Tags=[{"Key": "Project", "Value": "GC-AVA-Explainability"}],
        )
        action, arn = "created", created["ARN"]
    print_scrubbed(f"  secret   : {secret_name}")
    print_scrubbed(f"  action   : {action}")
    print_scrubbed(f"  arn      : {arn}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mcp-config", type=Path, default=DEFAULT_MCP_CONFIG)
    parser.add_argument("--server", default="ava-harness")
    parser.add_argument("--secret-name", default=DEFAULT_SECRET_NAME)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    try:
        if not args.mcp_config.is_file():
            print_scrubbed("  mcp config not found")
            return 1
        client_id, client_secret, habitat = load_client_credentials(args.mcp_config, args.server)
        secret_string = json.dumps({"clientId": client_id, "clientSecret": client_secret})
        del client_id, client_secret
        print_scrubbed(f"  habitat  : {habitat or 'unknown'}")
        print_scrubbed("  payload  : keys clientId, clientSecret")
        if args.dry_run:
            print_scrubbed(f"  dry run  : would write {args.secret_name}; no AWS call made")
            return 0
        store_secret(args.secret_name, secret_string)
        return 0
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, str) else "stopped"
        print_scrubbed(f"  stopped  : {code}")
        return 1
    except Exception as exc:  # noqa: BLE001 - never echo payloads or messages
        line = exc.__traceback__.tb_lineno if exc.__traceback__ else "?"
        print_scrubbed(f"  failed   : {type(exc).__name__} at line {line}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
