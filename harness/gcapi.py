"""Shared plumbing for the validation harness: config, auth, HTTP, and evidence recording.

Dependency-free on purpose. The harness has to run in whatever interpreter is available,
including the aws skill's venv, so it uses only the standard library. boto3 is imported
lazily and only by the optional S3 helpers.

Two things here are less obvious than they look:

1. TLS. This machine sits behind a TLS-inspecting proxy, so the default certificate store
   rejects api.mypurecloud.de and every signed download host. The same enterprise CA bundle
   the aws skill uses is applied here, for the same reason and with the same refusal to
   disable verification.

2. Evidence. Every request records status, headers, timing and final URL to a JSON artifact
   rather than just returning a body. Validations 4, 5 and 6 are questions about HTTP
   behaviour, not about payloads, so the metadata *is* the result.
"""

from __future__ import annotations

import base64
import json
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
ARTIFACTS = REPO_ROOT / "artifacts"

DEFAULT_MCP_CONFIG = Path(
    r"C:\Users\<user>\cursor\AVA skills MCP Cursor files\<org-folder>\mcp.json"
)
DEFAULT_CA_BUNDLE = Path.home() / ".cursor" / "certs" / "windows-enterprise-ca-bundle.pem"

HABITAT_TO_API_HOST = {
    "prod-use1": "api.mypurecloud.com",
    "prod-usw2": "api.usw2.pure.cloud",
    "prod-cac1": "api.cac1.pure.cloud",
    "prod-euw1": "api.mypurecloud.ie",
    "prod-euw2": "api.euw2.pure.cloud",
    "prod-euc1": "api.mypurecloud.de",
    "prod-euc2": "api.euc2.pure.cloud",
    "prod-apne1": "api.mypurecloud.jp",
    "prod-apne2": "api.apne2.pure.cloud",
    "prod-apne3": "api.apne3.pure.cloud",
    "prod-aps1": "api.aps1.pure.cloud",
    "prod-apse2": "api.mypurecloud.com.au",
    "prod-sae1": "api.sae1.pure.cloud",
    "prod-mec1": "api.mec1.pure.cloud",
}


# --------------------------------------------------------------------------- TLS


def resolve_ca_bundle(override: str | None = None) -> str | None:
    candidates = [
        override,
        os.environ.get("AWS_CA_BUNDLE"),
        os.environ.get("REQUESTS_CA_BUNDLE"),
        os.environ.get("SSL_CERT_FILE"),
        str(DEFAULT_CA_BUNDLE),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    return None


def ssl_context(ca_bundle: str | None = None) -> ssl.SSLContext:
    bundle = resolve_ca_bundle(ca_bundle)
    ctx = ssl.create_default_context(cafile=bundle) if bundle else ssl.create_default_context()
    # Verification stays on unconditionally. A TLS-inspecting proxy is a reason to supply the
    # right CA, never a reason to stop checking who we are talking to.
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx


# ------------------------------------------------------------------------ config


@dataclass
class OrgConfig:
    client_id: str
    client_secret: str
    habitat: str
    org_id: str | None = None

    @property
    def api_host(self) -> str:
        host = HABITAT_TO_API_HOST.get(self.habitat)
        if not host:
            raise SystemExit(f"unknown habitat '{self.habitat}'")
        return host

    @property
    def login_host(self) -> str:
        return self.api_host.replace("api.", "login.", 1)


def load_org_config(
    mcp_config: str | Path = DEFAULT_MCP_CONFIG, server_name: str = "ava-harness"
) -> OrgConfig:
    path = Path(mcp_config)
    if not path.is_file():
        raise SystemExit(f"MCP config not found: {path}")
    raw = json.loads(path.read_text(encoding="utf-8-sig"))
    try:
        env = raw["mcpServers"][server_name]["env"]
    except KeyError as exc:
        raise SystemExit(f"MCP config has no server '{server_name}' ({exc})") from exc

    return OrgConfig(
        client_id=env["GENESYS_CLIENT_ID"],
        client_secret=env["GENESYS_CLIENT_SECRET"],
        habitat=env["AVA_HABITAT"],
        org_id=env.get("GENESYS_ORG_ID"),
    )


# -------------------------------------------------------------------- HTTP layer


@dataclass
class Response:
    """A response plus the metadata that the HTTP-behaviour validations actually need."""

    status: int
    headers: dict[str, str]
    body: bytes
    final_url: str
    elapsed_ms: int
    error: str | None = None

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8"))

    def summary(self, keep_headers: tuple[str, ...] = ()) -> dict[str, Any]:
        interesting = keep_headers or (
            "content-type",
            "content-length",
            "content-encoding",
            "date",
            "expires",
            "cache-control",
            "etag",
            "last-modified",
            "server",
            "via",
            "x-amz-request-id",
            "x-amz-id-2",
            "x-cache",
            "retry-after",
            "x-ratelimit-limit",
            "x-ratelimit-remaining",
            "x-ratelimit-reset",
            "inin-ratelimit-count",
            "inin-ratelimit-allowed",
            "inin-ratelimit-reset",
            "inin-correlation-id",
        )
        lower = {k.lower(): v for k, v in self.headers.items()}
        return {
            "status": self.status,
            "elapsedMs": self.elapsed_ms,
            "finalUrl": redact_url(self.final_url),
            "finalHost": urllib.parse.urlparse(self.final_url).hostname,
            "bytes": len(self.body),
            "headers": {k: lower[k] for k in interesting if k in lower},
            "error": self.error,
        }


def redact_url(url: str) -> str:
    """Strip signature material so evidence artifacts can be shared and committed.

    A signed execution-history URI is a bearer credential for the duration of its TTL.
    """
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return "<unparseable>"
    if not parts.query:
        return url
    sensitive = {
        "x-amz-signature",
        "x-amz-credential",
        "x-amz-security-token",
        "signature",
        "sig",
        "token",
        "awsaccesskeyid",
        "key-pair-id",
    }
    kept = []
    for key, value in urllib.parse.parse_qsl(parts.query, keep_blank_values=True):
        kept.append((key, "<redacted>" if key.lower() in sensitive else value))
    return urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(kept), "")
    )


def request(
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: int = 60,
    ca_bundle: str | None = None,
    follow_redirects: bool = True,
) -> Response:
    req = urllib.request.Request(url, method=method, data=body)
    for key, value in (headers or {}).items():
        req.add_header(key, value)

    ctx = ssl_context(ca_bundle)
    opener_handlers: list[Any] = [urllib.request.HTTPSHandler(context=ctx)]
    if not follow_redirects:

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_args, **_kwargs):  # noqa: D102
                return None

        opener_handlers.append(NoRedirect())
    opener = urllib.request.build_opener(*opener_handlers)

    start = time.perf_counter()
    try:
        with opener.open(req, timeout=timeout) as resp:
            data = resp.read()
            return Response(
                status=resp.status,
                headers=dict(resp.headers.items()),
                body=data,
                final_url=resp.url,
                elapsed_ms=int((time.perf_counter() - start) * 1000),
            )
    except urllib.error.HTTPError as exc:
        data = exc.read() if hasattr(exc, "read") else b""
        return Response(
            status=exc.code,
            headers=dict(exc.headers.items()) if exc.headers else {},
            body=data,
            final_url=getattr(exc, "url", url),
            elapsed_ms=int((time.perf_counter() - start) * 1000),
            error=f"HTTP {exc.code} {exc.reason}",
        )
    except urllib.error.URLError as exc:
        hint = ""
        if isinstance(exc.reason, ssl.SSLError) or "CERTIFICATE_VERIFY" in str(exc.reason):
            bundle = resolve_ca_bundle(ca_bundle)
            hint = (
                f" | TLS interception: CA bundle in use = {bundle or 'none found'}. "
                f"Export the enterprise CA to {DEFAULT_CA_BUNDLE} or pass --ca-bundle."
            )
        return Response(
            status=0,
            headers={},
            body=b"",
            final_url=url,
            elapsed_ms=int((time.perf_counter() - start) * 1000),
            error=f"{type(exc).__name__}: {exc.reason}{hint}",
        )


# -------------------------------------------------------------------------- auth


@dataclass
class Client:
    config: OrgConfig
    ca_bundle: str | None = None
    _token: str | None = field(default=None, repr=False)

    def token(self) -> str:
        if self._token:
            return self._token
        creds = f"{self.config.client_id}:{self.config.client_secret}".encode()
        resp = request(
            f"https://{self.config.login_host}/oauth/token",
            method="POST",
            headers={
                "Authorization": "Basic " + base64.b64encode(creds).decode(),
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body=b"grant_type=client_credentials",
            ca_bundle=self.ca_bundle,
        )
        if not resp.ok:
            raise SystemExit(f"OAuth token request failed: {resp.status} {resp.error}")
        self._token = resp.json()["access_token"]
        return self._token

    def api(
        self,
        path: str,
        method: str = "GET",
        payload: Any = None,
        timeout: int = 60,
    ) -> Response:
        headers = {"Authorization": f"Bearer {self.token()}"}
        body = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload).encode()
        return request(
            f"https://{self.config.api_host}{path}",
            method=method,
            headers=headers,
            body=body,
            timeout=timeout,
            ca_bundle=self.ca_bundle,
        )


# ------------------------------------------------------------------- evidence io


def write_artifact(name: str, data: Any, subdir: str = "validation") -> Path:
    out = ARTIFACTS / subdir / name
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
    return out


def write_blob(name: str, data: bytes, subdir: str = "validation") -> Path:
    out = ARTIFACTS / subdir / name
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    return out


def load_event(path: str | Path) -> dict:
    """Load a captured notification, unwrapping however many layers it arrived in.

    A captured event is nested three deep, which the topic schema alone does not reveal:

        EventBridge envelope   -> detail
        Genesys notification   -> eventBody      (alongside topicName, metadata, timestamp)
        the fields that matter -> executionId, endpoint, execution[], ...

    Unwrapping only `detail` leaves the caller looking at topicName/eventBody/metadata and
    concluding the event has no executionId, so both layers are peeled here. A bare notification
    body is still accepted so hand-made fixtures keep working.
    """
    raw = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if isinstance(raw, dict) and isinstance(raw.get("detail"), dict):
        raw = raw["detail"]
    if isinstance(raw, dict) and isinstance(raw.get("eventBody"), dict):
        raw = raw["eventBody"]
    return raw


def require_field(event: dict, name: str) -> Any:
    if name not in event or event[name] in (None, ""):
        raise SystemExit(
            f"captured event has no '{name}'. Keys present: {sorted(event.keys())}"
        )
    return event[name]


def banner(text: str) -> None:
    print()
    print("=" * 78)
    print(text)
    print("=" * 78)
