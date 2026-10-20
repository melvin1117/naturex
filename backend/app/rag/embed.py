"""Embeddings for Copilot retrieval (T39).

- `LlmEmbedder`: `MODEL_EMBED` (Qwen3-Embedding-8B, `dimensions=1024`) on Token Factory through
  `LLMClient.embed`, so every call is budgeted and logged (ADR-0003). Queries get Qwen3's
  instruction prefix; documents are embedded as they are.
- `HashEmbedder`: a deterministic bag-of-words stand-in for `USE_MOCKS=true` and tests (no key,
  no network, no cost). It hashes words and a few hand-written concept groups (decline, price,
  value…) into 1024 dimensions, so "why did the price drop?" lands near a negative news event.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections.abc import Sequence
from typing import Literal, Protocol
from uuid import UUID

from app.llm import EMBED_DIMENSIONS, LLMClient, Tier

Purpose = Literal["document", "query"]

EMBED_AGENT = "copilot_embed"
# Qwen3-Embedding: queries carry a one-line task instruction, documents don't (model card).
QUERY_INSTRUCTION = (
    "Instruct: Given an investor's question about a nature site, retrieve the report or news "
    "passages that answer it\nQuery: "
)
# Batch size per embeddings request.
EMBED_BATCH = 32


class Embedder(Protocol):
    model: str
    """Stored with every vector; retrieval only compares vectors of the same model."""
    min_similarity: float
    """Below this cosine similarity a chunk is not context for the question."""

    def embed(
        self, texts: Sequence[str], *, purpose: Purpose, world_id: UUID | None
    ) -> list[list[float]]: ...


class LlmEmbedder:
    # Qwen3 similarities of unrelated text are low but not zero; the model's own
    # `insufficient` answer is the main guard, this only skips clearly unrelated chunks.
    min_similarity = 0.1

    def __init__(self, client: LLMClient) -> None:
        self._client = client
        self.model = client.model_for(Tier.EMBED)

    def embed(
        self, texts: Sequence[str], *, purpose: Purpose, world_id: UUID | None
    ) -> list[list[float]]:
        prefix = QUERY_INSTRUCTION if purpose == "query" else ""
        vectors: list[list[float]] = []
        for start in range(0, len(texts), EMBED_BATCH):
            batch = [prefix + t for t in texts[start : start + EMBED_BATCH]]
            vectors += self._client.embed(agent=EMBED_AGENT, texts=batch, world_id=world_id).value
        return vectors


_WORD = re.compile(r"[a-z0-9]+")
_STOPWORDS = frozenset(
    (  # noqa: SIM905
        "a an and are as at be been but by can could did do does for from had has have how i if "
        "in into is it its me my of on or our so than that the their them then there these they "
        "this to was we were what when where which who why will with would you your about tell"
    ).split()
)
_CONCEPTS: dict[str, tuple[str, ...]] = {
    "decline": (
        "drop",
        "dropped",
        "drops",
        "fall",
        "fell",
        "falls",
        "fallen",
        "down",
        "decline",
        "declined",
        "decrease",
        "decreased",
        "lower",
        "lowers",
        "lowered",
        "negative",
        "worse",
        "loss",
        "lost",
        "damage",
        "damaged",
        "encroachment",
        "fire",
        "drought",
        "downgrade",
        "downgraded",
        "cut",
        "threat",
        "degradation",
    ),
    "rise": (
        "rise",
        "rose",
        "up",
        "increase",
        "increased",
        "higher",
        "positive",
        "better",
        "improve",
        "improved",
        "restoration",
        "recovery",
        "upgrade",
        "upgraded",
        "protection",
    ),
    "price": ("price", "prices", "share", "shares", "stake", "fair", "trading", "market"),
    "value": ("value", "worth", "valued", "dollar", "dollars", "services", "estimate"),
    "rating": ("rating", "grade", "health", "score", "rated", "report"),
    "news": ("news", "event", "events", "happened", "reported", "article"),
    "confidence": ("confidence", "sure", "certain", "trust", "reliable"),
}
_CONCEPT_OF = {word: concept for concept, words in _CONCEPTS.items() for word in words}


def _features(text: str) -> list[str]:
    features: list[str] = []
    for word in _WORD.findall(text.lower()):
        if word in _STOPWORDS:
            continue
        features.append(f"w:{word}")
        if concept := _CONCEPT_OF.get(word):
            features.append(f"c:{concept}")
    return features


def _slot(feature: str) -> tuple[int, float]:
    digest = hashlib.sha256(feature.encode()).digest()
    index = int.from_bytes(digest[:4], "big") % EMBED_DIMENSIONS
    return index, 1.0 if digest[4] % 2 == 0 else -1.0


class HashEmbedder:
    model = "mock-hash-embed-v1"
    # Above the similarity a stray hash collision gives an unrelated question (about 0.08).
    min_similarity = 0.12

    def embed(
        self, texts: Sequence[str], *, purpose: Purpose, world_id: UUID | None
    ) -> list[list[float]]:
        del purpose, world_id
        return [hash_vector(text) for text in texts]


def hash_vector(text: str) -> list[float]:
    vector = [0.0] * EMBED_DIMENSIONS
    for feature in _features(text):
        index, sign = _slot(feature)
        # Concepts weigh more than single words: they carry the question's intent.
        vector[index] += sign * (2.0 if feature.startswith("c:") else 1.0)
    norm = math.sqrt(sum(x * x for x in vector))
    return [x / norm for x in vector] if norm else vector


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0
