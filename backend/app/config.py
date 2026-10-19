"""Application settings loaded from environment / .env."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration. Secrets come from the environment, never the repo."""

    model_config = SettingsConfigDict(
        # Commands run from backend/, but the README puts .env at the repo root.
        # Both are read; backend/.env wins if present.
        env_file=("../.env", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "NatureX"
    # development | test | production. Cookies drop `Secure` only when this is explicitly
    # development or test (see secure_cookies); every deployment must set production.
    environment: str = "development"
    use_mocks: bool = True
    demo_mode: bool = True
    local_jobs: bool = True
    database_url: str = "postgresql+psycopg://naturex:naturex@localhost:5432/naturex"
    llm_budget_usd: float = 20.0
    # Cap on new demo sandbox worlds per hour (T55's POST /demo/start), so the DB can't be filled.
    sandbox_max_new_worlds_per_hour: int = 300
    # Create the live world at startup if `make seed` hasn't (ADR-0005 §2); requests never do.
    live_world_on_startup: bool = True
    event_stream_max_concurrent: int = 40
    # Rating runs (T27): each visitor world may start this many per rolling hour (429 after);
    # LLM_BUDGET_USD stays the global hard cap.
    rating_runs_per_world_per_hour: int = Field(default=6, ge=1)
    # ...and at most this many across all worlds, since visitor worlds are free (429 after).
    rating_runs_global_per_hour: int = Field(default=60, ge=1)
    # Once LLM_BUDGET_USD minus spend falls below this, API-triggered runs use the fixed
    # pipeline without any model, keeping the rest for Time Machine and listings. 0 = off.
    llm_reserve_usd: float = Field(default=0.0, ge=0)
    # Exact origins (scheme://host[:port], comma separated) allowed to send POST, PUT, PATCH and
    # DELETE requests (T66, ADR-0005). Every deployment must set its public frontend origin.
    allowed_origins: str = "http://localhost:3000"
    # Reverse proxies in front of the API that each append to X-Forwarded-For. 0 ignores the
    # header, so a client can't choose its own rate-limit bucket.
    trusted_proxy_hops: int = Field(default=0, ge=0, le=10)
    # HMAC key for the rate-limit buckets, so a guessed email can't be matched to a row.
    auth_rate_limit_secret: str = ""

    nebius_api_key: str = ""
    token_factory_base_url: str = "https://api.tokenfactory.nebius.com/v1/"
    model_orchestrator: str = ""
    model_auditor: str = ""
    model_fast: str = ""
    model_multimodal: str = ""
    model_embed: str = ""

    tavily_api_key: str = ""
    nominatim_user_agent: str = "NatureX/0.1 (https://github.com/melvin1117/naturex)"
    ee_service_account_json: str = ""


INSECURE_COOKIE_ENVIRONMENTS = frozenset({"development", "test"})


def secure_cookies(settings: Settings) -> bool:
    """Fail closed: cookies are `Secure` unless ENVIRONMENT is *explicitly* development or test.

    The `development` default keeps local work simple, but an unset ENVIRONMENT never turns
    `Secure` off, so a deployment that forgets the variable still protects its cookies.
    """
    explicit = "environment" in settings.model_fields_set
    return not (explicit and settings.environment in INSECURE_COOKIE_ENVIRONMENTS)


@lru_cache
def get_settings() -> Settings:
    return Settings()


# Only ever used when ENVIRONMENT is explicitly development or test.
DEV_RATE_LIMIT_SECRET = "naturex-dev-only-rate-limit-secret"


def rate_limit_secret(settings: Settings) -> str:
    """The HMAC key for rate-limit buckets. Fails closed outside explicit development or test."""
    if settings.auth_rate_limit_secret:
        return settings.auth_rate_limit_secret
    if not secure_cookies(settings):
        return DEV_RATE_LIMIT_SECRET
    raise RuntimeError(
        "AUTH_RATE_LIMIT_SECRET must be set (ENVIRONMENT is not development or test)"
    )
