"""Deck discovery: search Bulbapedia and best-effort parse a deck's wikitext.

Preconstructed-deck card lists exist nowhere in the TCGdex/pokemontcg.io APIs —
only on wiki pages. Bulbapedia's TCG product pages consistently use a
{{halfdecklist/header}} ... {{halfdecklist/entry|...}} ... {{halfdecklist/footer}}
template convention (verified directly against real pages — "Ex Battle
Decks—Ampharos & Lucario (TCG)", "Battle Academy 2024 (TCG)" — before writing
this), so this parses that specific convention rather than attempting to
handle arbitrary wikitext. A single page can contain more than one deck (e.g.
a two-deck box), so parsing returns every block found; callers let the user
pick which one if there's more than one.
"""
import datetime
import html
import re
from typing import Any, Dict, List, Optional

import httpx
from sqlalchemy.orm import Session

from models import Card, Set
from services import pokemon_api
from services.card_numbers import card_number_matches
from services.card_upsert import upsert_card

BULBAPEDIA_API = "https://bulbapedia.bulbagarden.net/w/api.php"
BULBAPEDIA_WIKI = "https://bulbapedia.bulbagarden.net/wiki/"
_HTTP_TIMEOUT = 10.0

# Bulbapedia's {{TCG ID|SetName|...}} set names don't always match TCGdex's
# Set.name for promo/energy subsets (verified against live synced data —
# e.g. "SVP Promo" vs TCGdex's "SVP Black Star Promos", "SVE Energy" vs
# "Scarlet & Violet Energy"). Numbered expansion sets ("Scarlet & Violet",
# "Paldea Evolved", ...) match exactly and don't need this.
_KNOWN_SET_NAME_ALIASES = {
    "sve energy": "scarlet & violet energy",
    "svp promo": "svp black star promos",
    "swshe energy": "sword & shield energy",
    "swshp promo": "swsh black star promos",
    "smp promo": "sm black star promos",
    "xyp promo": "xy black star promos",
    "dpp promo": "dp black star promos",
    "hgssp promo": "hgss black star promos",
    "bwp promo": "bw black star promos",
    "svp black star promos": "svp black star promos",
}


def search_bulbapedia(query: str, limit: int = 8) -> List[dict]:
    """Search Bulbapedia for candidate deck pages, for the user to confirm."""
    resp = httpx.get(BULBAPEDIA_API, params={
        "action": "query",
        "list": "search",
        "srsearch": query,
        "srlimit": limit,
        "format": "json",
    }, timeout=_HTTP_TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    results = []
    for row in data.get("query", {}).get("search", []):
        title = row["title"]
        # MediaWiki's search snippet is HTML: strip the <span> highlight tags,
        # then decode entities (its own &amp; escaping) so "&" doesn't render
        # literally as "&amp;" in the UI.
        snippet = html.unescape(re.sub(r"<[^>]+>", "", row.get("snippet", "")))
        results.append({
            "title": title,
            "url": BULBAPEDIA_WIKI + title.replace(" ", "_"),
            "snippet": snippet,
        })
    return results


def fetch_wikitext(title: str) -> str:
    """Fetch the raw wikitext of one Bulbapedia page by its exact title."""
    resp = httpx.get(BULBAPEDIA_API, params={
        "action": "query",
        "prop": "revisions",
        "titles": title,
        "rvslots": "main",
        "rvprop": "content",
        "format": "json",
    }, timeout=_HTTP_TIMEOUT)
    resp.raise_for_status()
    pages = resp.json().get("query", {}).get("pages", {})
    for page in pages.values():
        revisions = page.get("revisions")
        if revisions:
            return revisions[0]["slots"]["main"]["*"]
    raise ValueError(f"Bulbapedia page not found: {title}")


def _extract_balanced(text: str, start: int) -> tuple[str, int]:
    """text[start] is right after an opening '{{'. Returns (inner_content, index_after_closing_'}}')."""
    depth = 1
    i = start
    n = len(text)
    while i < n and depth > 0:
        two = text[i:i + 2]
        if two == "{{":
            depth += 1
            i += 2
        elif two == "}}":
            depth -= 1
            i += 2
        else:
            i += 1
    return text[start:i - 2], i


def _split_top_level(text: str) -> List[str]:
    """Split on '|' at brace/bracket depth 0 only, so nested {{..|..}} / [[..|..]] survive intact."""
    parts: List[str] = []
    current: List[str] = []
    depth = 0
    i = 0
    n = len(text)
    while i < n:
        two = text[i:i + 2]
        if two in ("{{", "[["):
            depth += 1
            current.append(two)
            i += 2
            continue
        if two in ("}}", "]]"):
            depth -= 1
            current.append(two)
            i += 2
            continue
        if text[i] == "|" and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(text[i])
        i += 1
    parts.append("".join(current))
    return parts


_TCG_ID_RE = re.compile(r"^\{\{TCG ID\|(.+)\}\}$", re.DOTALL)
_TCG_RE = re.compile(r"^\{\{TCG\|(.+)\}\}$", re.DOTALL)
_WIKILINK_RE = re.compile(r"^\[\[([^\]|]+)(?:\|([^\]]+))?\]\](.*)$", re.DOTALL)


def _parse_name_field(name_field: str) -> dict:
    """Best-effort parse of one entry's card-name field.

    Three shapes seen on real pages: a {{TCG ID|Set|Name|Number}} template
    (high confidence — exact set + name + number), a plain {{TCG|Name}}
    template (name only, no set/number — verified on real pages for basic
    energy lines, e.g. Battle Academy 2024's Pikachu Deck uses
    {{TCG|Basic Lightning Energy}} while its other entries all use the
    {{TCG ID|...}} form), or a raw [[wikilink]], typically for promo cards
    not covered by either TCG template (lower confidence — name only).
    """
    stripped = name_field.strip()
    match = _TCG_ID_RE.match(stripped)
    if match:
        fields = _split_top_level(match.group(1))
        if len(fields) >= 3:
            return {
                "set_name": fields[0].strip(),
                "card_name": fields[1].strip(),
                "number": fields[2].strip(),
                "confident": True,
                "use_number_fallback": True,
            }
    tcg_match = _TCG_RE.match(stripped)
    if tcg_match:
        # The plain {{TCG|Name}} form (verified on real pages: basic-energy
        # lines like {{TCG|Basic Lightning Energy}}) never carries its own
        # set/number, and the entry's leading image-link number (if any)
        # belongs to whatever set that image happens to link to — not
        # necessarily the set TCGdex's name search will actually match.
        # Passing it through as a search filter can incorrectly exclude the
        # real match (verified: Battle Academy 2024's Pikachu Deck energy
        # line links "SVE Basic Energies (TCG) #004", but the card that
        # actually matches by name is sv01-257, a different set/number
        # entirely) — so this shape explicitly opts out of that fallback.
        return {
            "set_name": None,
            "card_name": tcg_match.group(1).strip(),
            "number": None,
            "confident": False,
            "use_number_fallback": False,
        }
    link_match = _WIKILINK_RE.match(stripped)
    if link_match:
        display = (link_match.group(2) or link_match.group(1)).strip()
        suffix = re.sub(r"\{\{(\w+)\}\}", lambda m: " " + m.group(1), link_match.group(3)).strip()
        return {
            "set_name": None,
            "card_name": (display + (" " + suffix if suffix else "")).strip(),
            "number": None,
            "confident": False,
            "use_number_fallback": True,
        }
    return {
        "set_name": None,
        "card_name": re.sub(r"\{\{|\}\}", "", stripped),
        "number": None,
        "confident": False,
        "use_number_fallback": True,
    }


def _parse_number_field(number_field: str) -> Optional[str]:
    """Extract a bare local card number from the entry's first field.

    Real examples: "066/198" -> "066", "[[Image:SVP.png|...]] 016" -> "016".
    """
    cleaned = re.sub(r"\[\[.*?\]\]", "", number_field).strip()
    cleaned = cleaned.split("/")[0].strip()
    return cleaned or None


def parse_decklists(wikitext: str) -> List[dict]:
    """Parse every {{halfdecklist/header}}...{{halfdecklist/footer}} block on a page."""
    blocks: List[dict] = []
    current: Optional[dict] = None
    i = 0
    n = len(wikitext)
    while i < n:
        if wikitext[i:i + 2] == "{{":
            content, end = _extract_balanced(wikitext, i + 2)
            if content.startswith("halfdecklist/header"):
                fields = _split_top_level(content)
                title = None
                for field in fields[1:]:
                    if field.strip().startswith("title="):
                        title = field.strip()[len("title="):].strip()
                current = {"name": title or "Deck", "entries": []}
            elif content.startswith("halfdecklist/entry") and current is not None:
                fields = _split_top_level(content)[1:]  # drop the "halfdecklist/entry" tag itself
                if len(fields) >= 4:
                    number_field, name_field = fields[0], fields[2]
                    quantity_field = fields[-1]
                    try:
                        quantity = int(re.sub(r"[^0-9]", "", quantity_field) or "0")
                    except ValueError:
                        quantity = 0
                    parsed_name = _parse_name_field(name_field)
                    if quantity > 0:
                        number = parsed_name["number"]
                        if not number and parsed_name["use_number_fallback"]:
                            number = _parse_number_field(number_field)
                        current["entries"].append({
                            "raw_name": parsed_name["card_name"],
                            "set_name": parsed_name["set_name"],
                            "number": number,
                            "expected_quantity": quantity,
                            "confident": parsed_name["confident"],
                        })
            elif content.startswith("halfdecklist/footer") and current is not None:
                blocks.append(current)
                current = None
            i = end
        else:
            i += 1
    return blocks


def _find_set(db: Session, set_name: str, lang: str) -> Optional[Set]:
    normalized = set_name.strip().lower()
    set_row = db.query(Set).filter(Set.lang == lang, Set.name.ilike(set_name.strip())).first()
    if set_row:
        return set_row
    alias = _KNOWN_SET_NAME_ALIASES.get(normalized)
    if alias:
        return db.query(Set).filter(Set.lang == lang, Set.name.ilike(alias)).first()
    return None


def _resolve_via_live_search(db: Session, card_name: str, number: Optional[str], lang: str) -> tuple[Optional[Card], List[dict]]:
    """Fall back to a live TCGdex name search when the set name doesn't map locally.

    Returns (resolved_card_or_None, raw_candidates). Only resolves automatically
    when exactly one live result matches — otherwise the candidates are handed
    back for manual review rather than guessing.
    """
    try:
        results = pokemon_api.search_cards(name=card_name, local_id=number, lang=lang, page_size=10)
    except Exception:
        return None, []
    cards_data = results.get("data", [])
    if not cards_data:
        return None, []
    if len(cards_data) == 1:
        parsed = pokemon_api.parse_card_for_db(cards_data[0], lang=lang)
        card = upsert_card(db, parsed)
        db.commit()
        return card, []
    return None, cards_data[:5]


def resolve_entry(db: Session, entry: dict, lang: str = "en") -> dict:
    """Best-effort resolve one parsed entry to a local catalogue Card row.

    Tries the set named in the {{TCG ID}} template first (exact/aliased match
    + number), then falls back to a live TCGdex name search. Anything that
    still doesn't resolve to exactly one card is left for manual correction —
    that's expected to happen regularly (promo cards especially), not an edge case.
    """
    result = dict(entry)
    result["card_id"] = None
    result["candidates"] = []

    set_name = entry.get("set_name")
    number = entry.get("number")
    card = None

    if set_name and number:
        set_row = _find_set(db, set_name, lang)
        if set_row:
            tcg_set_id = set_row.tcg_set_id or set_row.id
            for candidate in db.query(Card).filter(Card.set_id == tcg_set_id, Card.lang == lang).all():
                if card_number_matches(candidate.number, number):
                    card = candidate
                    break

    if not card:
        card, raw_candidates = _resolve_via_live_search(db, entry["raw_name"], number, lang)
        if not card:
            result["candidates"] = [
                {
                    "id": f"{c.get('id')}_{lang}",
                    "name": c.get("name"),
                    "image": c.get("image"),
                }
                for c in raw_candidates
            ]

    # "confident" here means a specific card was resolved, regardless of
    # whether that came from the structured {{TCG ID}} template or the live
    # search fallback — either way the frontend can pre-fill it and the user
    # only needs to review the rows that are still unresolved.
    result["confident"] = bool(card)
    result["card_id"] = card.id if card else None
    return result
