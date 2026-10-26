"""Report the deployed state of the AVA explainability AWS stack, as metadata only.

Prints resource names, states, counts and environment variable *names*. Never prints secret
values, environment variable values, or object contents. Run through the aws skill wrapper:

    powershell -File %USERPROFILE%\\.cursor\\skills\\aws\\scripts\\aws-exec.ps1 -Region eu-central-1 `
      -Run "<venv python> scripts\\aws-stack-inventory.py"
"""

from __future__ import annotations

import sys

PREFIX = "ava-explain"


def report_stack_inventory() -> None:
    import boto3

    secrets = boto3.client("secretsmanager")
    names = [
        s["Name"]
        for page in secrets.get_paginator("list_secrets").paginate()
        for s in page.get("SecretList", [])
    ]
    print(f"secrets           : {len(names)} total")
    for name in names:
        if "genesys" in name.lower() or PREFIX in name.lower():
            print(f"  candidate       : {name}")

    lam = boto3.client("lambda")
    for page in lam.get_paginator("list_functions").paginate():
        for fn in page.get("Functions", []):
            if fn["FunctionName"].startswith(PREFIX):
                env_names = sorted((fn.get("Environment") or {}).get("Variables", {}).keys())
                print(f"lambda            : {fn['FunctionName']} runtime={fn.get('Runtime')} "
                      f"modified={fn.get('LastModified')}")
                print(f"  env names       : {', '.join(env_names)}")

    events = boto3.client("events")
    sources = events.list_event_sources(NamePrefix="aws.partner/genesys.com").get("EventSources", [])
    for src in sources:
        print(f"partner source    : {src['Name'].rsplit('/', 1)[-1]} state={src.get('State')}")
    for bus in events.list_event_buses(NamePrefix="aws.partner/genesys.com").get("EventBuses", []):
        rules = events.list_rules(EventBusName=bus["Name"]).get("Rules", [])
        print(f"event bus         : {bus['Name'].rsplit('/', 1)[-1]} rules={len(rules)}")
        for rule in rules:
            print(f"  rule            : {rule['Name']} state={rule.get('State')}")

    ddb = boto3.client("dynamodb")
    for table in ddb.list_tables().get("TableNames", []):
        if table.startswith(PREFIX):
            desc = ddb.describe_table(TableName=table)["Table"]
            print(f"dynamodb          : {table} items~{desc.get('ItemCount')}")

    sqs = boto3.client("sqs")
    for url in sqs.list_queues(QueueNamePrefix=PREFIX).get("QueueUrls", []):
        attrs = sqs.get_queue_attributes(
            QueueUrl=url, AttributeNames=["ApproximateNumberOfMessages"]
        )["Attributes"]
        print(f"sqs               : {url.rsplit('/', 1)[-1]} visible={attrs.get('ApproximateNumberOfMessages')}")

    iam = boto3.client("iam")
    providers = iam.list_open_id_connect_providers().get("OpenIDConnectProviderList", [])
    for provider in providers:
        print(f"oidc provider     : {provider['Arn'].split('oidc-provider/', 1)[-1]}")


def main() -> int:
    try:
        report_stack_inventory()
        return 0
    except Exception as exc:  # noqa: BLE001 - never echo payloads or messages
        line = exc.__traceback__.tb_lineno if exc.__traceback__ else "?"
        print(f"inventory failed: {type(exc).__name__} at line {line}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
