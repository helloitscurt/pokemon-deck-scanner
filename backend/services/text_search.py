"""Text search helpers for user-facing filters."""

from __future__ import annotations

import unicodedata

from sqlalchemy import event, func, literal, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

# Keep a small per-engine cache so PostgreSQL extension probing is cheap and so
# installs where CREATE EXTENSION is not permitted gracefully use the portable
# fallback instead of failing every search request.
_UNACCENT_AVAILABLE_BY_BIND: dict[int, bool] = {}

_SQLITE_STRIP_DIACRITICS_FN = "strip_diacritics_portable"

# Nested-replace() fallback for engines where the SQLite custom function
# below isn't available — PostgreSQL installs where the unaccent extension
# cannot be enabled (CREATE EXTENSION not permitted). Kept deliberately
# small; unlike SQLite (see below), nothing has shown PostgreSQL's parser
# hitting an expression-depth limit from this, so this stays as it was
# rather than being touched to chase a SQLite-specific bug.
_LATIN_REPLACEMENTS = {
    "a": "áàâäãåÁÀÂÄÃÅ",
    "c": "çÇ",
    "e": "éèêëÉÈÊË",
    "i": "íìîïÍÌÎÏ",
    "n": "ñÑ",
    "o": "óòôöõøÓÒÔÖÕØ",
    "u": "úùûüÚÙÛÜ",
    "y": "ýÿÝŸ",
}


def strip_diacritics(value: str | None) -> str:
    """Return a case-folded, accent-insensitive representation of text."""
    if value is None:
        return ""
    normalized = unicodedata.normalize("NFKD", str(value))
    stripped = "".join(char for char in normalized if not unicodedata.combining(char))
    return stripped.casefold()


@event.listens_for(Engine, "connect")
def _register_sqlite_strip_diacritics(dbapi_connection, connection_record):
    """Expose strip_diacritics() as a SQL function on every new SQLite
    connection, for _portable_unaccent_expr below to call directly instead
    of chaining ~56 nested SQL replace() calls per column (one call per
    accented character across every base letter) — deep enough to hit
    SQLITE_MAX_EXPR_DEPTH on some SQLite builds once two or more columns are
    OR'd together in one query. Verified: it does on the SQLite linked into
    GitHub Actions' actions/setup-python 3.11.16 ("parser stack overflow"),
    though not on the one bundled with the python:3.11-slim Docker image
    used for local development — a real, silent portability gap the old
    nested-replace() approach had no way to surface until CI actually ran
    against a stricter build.

    hasattr-gated, not a dialect check, so this safely no-ops for every
    other DBAPI (psycopg2's connection has no create_function) — this fires
    for every engine created anywhere in the process, including ad-hoc test
    engines that never go through database.py.
    """
    if hasattr(dbapi_connection, "create_function"):
        dbapi_connection.create_function(_SQLITE_STRIP_DIACRITICS_FN, 1, strip_diacritics)


def _portable_unaccent_expr(db: Session, column):
    """Portable fallback used for SQLite and PostgreSQL installs where the
    unaccent extension cannot be enabled. PostgreSQL unaccent (in
    accent_insensitive_contains below) is still the full production path
    when available.

    Dialect-dispatched: the SQLite custom function registered above doesn't
    exist on a PostgreSQL connection (psycopg2 has no create_function at
    all), so calling it there would raise "function ... does not exist",
    not just be slower — this must stay two real implementations, not one
    path with a silent gap for the other engine.
    """
    if db.get_bind().dialect.name == "sqlite":
        return func.strip_diacritics_portable(column)

    expr = func.lower(column)
    for replacement, characters in _LATIN_REPLACEMENTS.items():
        for character in characters:
            expr = func.replace(expr, character, replacement)
    return expr


def _postgres_unaccent_available(db: Session) -> bool:
    bind = db.get_bind()
    if bind.dialect.name != "postgresql":
        return False

    cache_key = id(bind)
    if cache_key in _UNACCENT_AVAILABLE_BY_BIND:
        return _UNACCENT_AVAILABLE_BY_BIND[cache_key]

    try:
        db.execute(text("SELECT unaccent('Pokégear')")).scalar()
        available = True
    except Exception:
        db.rollback()
        available = False

    _UNACCENT_AVAILABLE_BY_BIND[cache_key] = available
    return available


def accent_insensitive_contains(db: Session, column, value: str | None):
    """Build a SQL predicate for accent-insensitive substring search."""
    if not value:
        return None

    if _postgres_unaccent_available(db):
        pattern = f"%{value}%"
        return func.unaccent(func.lower(column)).like(func.unaccent(func.lower(literal(pattern))))

    normalized = strip_diacritics(value)
    if not normalized:
        return None
    return _portable_unaccent_expr(db, column).like(f"%{normalized}%")
