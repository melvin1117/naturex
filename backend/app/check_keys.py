"""Check that this person's API keys work (T01), without spending any credits.

    make check-keys        # or: cd backend && uv run python -m app.check_keys

Reads the same .env as the app. Token Factory and Tavily are required; Earth Engine is
optional (only D2 needs it in week 1, and full sign-in is tested in T03). Keys are never
printed, only their last four characters.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final

from app.config import Settings, get_settings

OK: Final = "ok"
WARN: Final = "warn"
MISSING: Final = "missing"
FAIL: Final = "fail"

TAVILY_USAGE_URL = "https://api.tavily.com/usage"
TIMEOUT_S = 15
MODEL_SETTINGS = (
    "model_orchestrator",
    "model_auditor",
    "model_fast",
    "model_multimodal",
    "model_embed",
)


@dataclass(frozen=True, slots=True)
class Response:
    status: int
    body: Any


Http = Callable[[str, dict[str, str]], Response]


@dataclass(frozen=True, slots=True)
class Result:
    name: str
    status: str
    detail: str
    extra: list[str] = field(default_factory=list)


def mask(secret: str) -> str:
    return "…" + secret[-4:] if len(secret) > 8 else "…"


def http_get(url: str, headers: dict[str, str]) -> Response:
    """GET a JSON endpoint. HTTP errors become a Response; network errors raise."""
    request = urllib.request.Request(url, headers={"Accept": "application/json", **headers})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as reply:
            return Response(reply.status, json.loads(reply.read() or b"null"))
    except urllib.error.HTTPError as exc:
        return Response(exc.code, None)
    except (urllib.error.URLError, TimeoutError) as exc:
        raise ConnectionError(str(getattr(exc, "reason", exc))) from exc


def _get(http: Http, name: str, url: str, key: str) -> Response | Result:
    try:
        response = http(url, {"Authorization": f"Bearer {key}"})
    except ConnectionError as exc:
        return Result(name, FAIL, f"Couldn't reach {url}: {exc}")
    if response.status in (401, 403):
        return Result(name, FAIL, f"HTTP {response.status}: key {mask(key)} was rejected")
    if response.status != 200:
        return Result(name, FAIL, f"HTTP {response.status} from {url}")
    return response


def check_token_factory(settings: Settings, http: Http) -> Result:
    name = "Token Factory"
    key = settings.nebius_api_key
    if not key:
        return Result(name, MISSING, "Set NEBIUS_API_KEY in .env")
    url = settings.token_factory_base_url.rstrip("/") + "/models"
    response = _get(http, name, url, key)
    if isinstance(response, Result):
        return response

    served = {str(m.get("id")) for m in (response.body or {}).get("data", [])}
    nemotron = sorted(m for m in served if "nemotron" in m.lower())
    unknown = [
        f"{attr.upper()}={value}"
        for attr in MODEL_SETTINGS
        if (value := getattr(settings, attr)) and value not in served
    ]
    if unknown:
        return Result(
            name, WARN, "Key works, but not served: " + ", ".join(unknown), extra=nemotron
        )
    return Result(
        name, OK, f"Key {mask(key)} works; {len(nemotron)} Nemotron models", extra=nemotron
    )


def check_tavily(settings: Settings, http: Http) -> Result:
    name = "Tavily"
    key = settings.tavily_api_key
    if not key:
        return Result(name, MISSING, "Set TAVILY_API_KEY in .env")
    response = _get(http, name, TAVILY_USAGE_URL, key)
    if isinstance(response, Result):
        return response
    usage = (response.body or {}).get("key", {})
    limit = usage.get("limit")
    used = f"{usage.get('usage', '?')} / {'unlimited' if limit is None else limit}"
    return Result(name, OK, f"Key {mask(key)} works; credits used {used}")


def check_earth_engine(settings: Settings) -> Result:
    """Structure check only: valid service-account JSON (inline or a file path)."""
    name = "Earth Engine"
    value = settings.ee_service_account_json.strip()
    if not value:
        return Result(name, MISSING, "Optional: set EE_SERVICE_ACCOUNT_JSON (D2, T03)")
    try:
        text = value if value.startswith("{") else Path(value).expanduser().read_text()
        info = json.loads(text)
    except OSError:
        return Result(name, FAIL, "EE_SERVICE_ACCOUNT_JSON is not JSON or a readable file")
    except json.JSONDecodeError:
        return Result(name, FAIL, "EE_SERVICE_ACCOUNT_JSON is not valid JSON")
    if not isinstance(info, dict) or info.get("type") != "service_account":
        return Result(name, FAIL, 'Expected a service-account key ("type": "service_account")')
    if not info.get("client_email") or not info.get("private_key"):
        return Result(name, FAIL, "The key file is missing client_email or private_key")
    return Result(name, OK, f"Service account {info['client_email']} (sign-in is tested in T03)")


def run(settings: Settings, http: Http = http_get) -> tuple[list[Result], bool]:
    """Run every check; ok is False if a required service is missing or failing."""
    required = [check_token_factory(settings, http), check_tavily(settings, http)]
    results = [*required, check_earth_engine(settings)]
    ok = all(r.status in (OK, WARN) for r in required) and results[-1].status != FAIL
    return results, ok


def main() -> None:
    icons = {OK: "✅", WARN: "⚠️ ", MISSING: "⬜", FAIL: "❌"}
    results, ok = run(get_settings())
    for result in results:
        print(f"{icons[result.status]} {result.name:<14} {result.detail}")
        for model in result.extra:
            print(f"     {model}")
    if not ok:
        print("\nFix the ❌/⬜ lines above, then run `make check-keys` again.")
        sys.exit(1)
    print("\nAll required keys work. Copy the model IDs you need into MODEL_* in .env.")


if __name__ == "__main__":
    main()
