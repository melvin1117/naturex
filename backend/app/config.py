"""Application settings loaded from environment / .env."""

from functools import lru_cache

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
    environment: str = "development"
    use_mocks: bool = True
    demo_mode: bool = True
    local_jobs: bool = True
    database_url: str = "postgresql+psycopg://naturex:naturex@localhost:5432/naturex"
    llm_budget_usd: float = 20.0
    # Cap on new sandbox worlds per hour, so clients that drop the cookie can't fill the DB.
    sandbox_max_new_worlds_per_hour: int = 300
    event_stream_max_concurrent: int = 40

    nebius_api_key: str = ""
    token_factory_base_url: str = "https://api.tokenfactory.nebius.com/v1/"
    model_orchestrator: str = ""
    model_auditor: str = ""
    model_fast: str = ""
    model_multimodal: str = ""
    model_embed: str = ""

    tavily_api_key: str = ""
    ee_service_account_json: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
