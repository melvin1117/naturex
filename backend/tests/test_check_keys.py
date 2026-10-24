"""`make check-keys` (T01): each person's keys work, without spending credits."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.check_keys import (
    FAIL,
    MISSING,
    OK,
    WARN,
    Response,
    check_earth_engine,
    check_tavily,
    check_token_factory,
    mask,
    run,
)
from app.config import Settings

# Obviously fake, built at runtime so secret scanners (gitleaks) do not flag the test.
KEY = "fake-nebius-" + "0" * 8 + "7890"
TAVILY_KEY = "fake-tavily-" + "0" * 8 + "4321"


class FakeHttp:
    """Records requests and replays canned responses keyed by URL."""

    def __init__(self, responses: dict[str, Response | Exception]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict[str, str]]] = []

    def __call__(self, url: str, headers: dict[str, str]) -> Response:
        self.calls.append((url, headers))
        result = self.responses[url]
        if isinstance(result, Exception):
            raise result
        return result


def settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "nebius_api_key": KEY,
        "token_factory_base_url": "https://api.tokenfactory.nebius.com/v1/",
        "tavily_api_key": TAVILY_KEY,
        "model_orchestrator": "nvidia/nemotron-3-super",
        "model_fast": "nvidia/nemotron-3-nano",
    }
    return Settings(_env_file=None, **{**base, **overrides})


MODELS_URL = "https://api.tokenfactory.nebius.com/v1/models"
MODELS = Response(
    200,
    {
        "data": [
            {"id": "nvidia/nemotron-3-super"},
            {"id": "nvidia/nemotron-3-nano"},
            {"id": "meta-llama/Llama-3.3-70B-Instruct"},
        ]
    },
)


# --- Masking --------------------------------------------------------------------------------


def test_mask_never_reveals_more_than_the_last_four_characters() -> None:
    assert mask(KEY) == "…7890"
    assert mask("abc") == "…"


# --- Token Factory --------------------------------------------------------------------------


def test_token_factory_ok_lists_nemotron_models_with_a_bearer_key() -> None:
    http = FakeHttp({MODELS_URL: MODELS})

    result = check_token_factory(settings(), http)

    assert result.status == OK
    assert http.calls == [(MODELS_URL, {"Authorization": f"Bearer {KEY}"})]
    assert result.extra == ["nvidia/nemotron-3-nano", "nvidia/nemotron-3-super"]


def test_token_factory_base_url_without_trailing_slash_still_works() -> None:
    http = FakeHttp({MODELS_URL: MODELS})

    check_token_factory(
        settings(token_factory_base_url="https://api.tokenfactory.nebius.com/v1"), http
    )

    assert http.calls[0][0] == MODELS_URL


def test_token_factory_warns_about_configured_models_it_does_not_serve() -> None:
    http = FakeHttp({MODELS_URL: MODELS})

    result = check_token_factory(settings(model_auditor="nvidia/nemotron-9-typo"), http)

    assert result.status == WARN
    assert "MODEL_AUDITOR=nvidia/nemotron-9-typo" in result.detail


def test_token_factory_missing_key_makes_no_request() -> None:
    http = FakeHttp({})

    result = check_token_factory(settings(nebius_api_key=""), http)

    assert result.status == MISSING
    assert http.calls == []


def test_token_factory_rejected_key_fails_without_echoing_it() -> None:
    http = FakeHttp({MODELS_URL: Response(401, {"detail": "Invalid key"})})

    result = check_token_factory(settings(), http)

    assert result.status == FAIL
    assert "401" in result.detail
    assert KEY not in result.detail


def test_token_factory_network_error_fails_cleanly() -> None:
    http = FakeHttp({MODELS_URL: ConnectionError("no route to host")})

    result = check_token_factory(settings(), http)

    assert result.status == FAIL
    assert "no route to host" in result.detail


# --- Tavily ---------------------------------------------------------------------------------

USAGE_URL = "https://api.tavily.com/usage"


def test_tavily_ok_reports_credits_used_without_spending_any() -> None:
    http = FakeHttp({USAGE_URL: Response(200, {"key": {"usage": 12, "limit": 1000}})})

    result = check_tavily(settings(), http)

    assert result.status == OK
    assert http.calls == [(USAGE_URL, {"Authorization": f"Bearer {TAVILY_KEY}"})]
    assert "12 / 1000" in result.detail


def test_tavily_unlimited_plan_is_reported() -> None:
    http = FakeHttp({USAGE_URL: Response(200, {"key": {"usage": 3, "limit": None}})})

    assert "3 / unlimited" in check_tavily(settings(), http).detail


def test_tavily_missing_key() -> None:
    assert check_tavily(settings(tavily_api_key=""), FakeHttp({})).status == MISSING


def test_tavily_rejected_key_fails() -> None:
    http = FakeHttp({USAGE_URL: Response(401, {"detail": {"error": "Unauthorized"}})})

    assert check_tavily(settings(), http).status == FAIL


# --- Earth Engine ---------------------------------------------------------------------------

SERVICE_ACCOUNT = {
    "type": "service_account",
    "client_email": "wildworth@ee-project.iam.gserviceaccount.com",
    "private_key": "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
}


def test_earth_engine_accepts_inline_json() -> None:
    result = check_earth_engine(settings(ee_service_account_json=json.dumps(SERVICE_ACCOUNT)))

    assert result.status == OK
    assert "wildworth@ee-project.iam.gserviceaccount.com" in result.detail


def test_earth_engine_accepts_a_file_path(tmp_path: Path) -> None:
    key_file = tmp_path / "ee.json"
    key_file.write_text(json.dumps(SERVICE_ACCOUNT))

    assert check_earth_engine(settings(ee_service_account_json=str(key_file))).status == OK


def test_earth_engine_is_optional_for_people_who_do_not_need_it() -> None:
    assert check_earth_engine(settings(ee_service_account_json="")).status == MISSING


@pytest.mark.parametrize(
    "value",
    ["not json at all", json.dumps({"type": "authorized_user"}), "/no/such/file.json"],
    ids=["garbage", "wrong-type", "missing-file"],
)
def test_earth_engine_rejects_bad_credentials(value: str) -> None:
    assert check_earth_engine(settings(ee_service_account_json=value)).status == FAIL


# --- Overall --------------------------------------------------------------------------------


def test_run_fails_when_a_required_key_is_missing() -> None:
    http = FakeHttp({USAGE_URL: Response(200, {"key": {"usage": 0, "limit": 1000}})})

    results, ok = run(settings(nebius_api_key=""), http)

    assert not ok
    assert [r.name for r in results] == ["Token Factory", "Tavily", "Earth Engine"]


def test_run_passes_without_earth_engine() -> None:
    http = FakeHttp(
        {
            MODELS_URL: MODELS,
            USAGE_URL: Response(200, {"key": {"usage": 0, "limit": 1000}}),
        }
    )

    _, ok = run(settings(ee_service_account_json=""), http)

    assert ok
