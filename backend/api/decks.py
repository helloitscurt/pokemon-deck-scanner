import datetime
import logging
from typing import List

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload

from api.auth import get_current_user
from api.collection import ensure_card_exists, find_matching_collection_item
from database import get_db
from models import Card, Deck, DeckCard, DeckInstance, ScannedCard, User
from schemas import (
    CollectionItemCreate, DeckCreate, DeckInstanceDetailResponse, DeckInstanceResponse, DeckCardResponse,
    DeckSearchResult, DeckParseRequest, DeckParseResponse, DeckParseBlock, DeckParseEntry,
)
from services import bulbapedia
from services.deck_progress import unregister_scan
from services.scan_trace import record_scan_reversed

logger = logging.getLogger(__name__)

router = APIRouter()


def _instance_response(db: Session, instance: DeckInstance, detail: bool = False):
    deck = instance.deck
    # A DeckCard's card_id is nulled (ON DELETE SET NULL) if its Card is ever
    # deleted (only realistic path: a custom card). Exclude those rather than
    # count them — an entry with no card left can never be completed, so
    # counting it would silently cap a deck's progress below 100% forever.
    deck_cards = db.query(DeckCard).filter(
        DeckCard.deck_id == deck.id,
        DeckCard.card_id.isnot(None),
    ).all()
    scanned_by_card = {
        sc.card_id: sc
        for sc in db.query(ScannedCard).filter(ScannedCard.deck_instance_id == instance.id).all()
    }

    # Counted in physical cards (sum of expected_quantity), not unique card
    # rows — a 60-card deck should read "0/60", not "0/22", even though only
    # 22 of those are distinct card types (the rest are extra energy/trainer
    # copies). is_complete still requires every row individually satisfied.
    total_count = 0
    scanned_count = 0
    card_rows = []
    for dc in deck_cards:
        sc = scanned_by_card.get(dc.card_id)
        scanned_qty = min(sc.scanned_quantity if sc else 0, dc.expected_quantity)
        total_count += dc.expected_quantity
        scanned_count += scanned_qty
        if detail:
            card_rows.append(DeckCardResponse(
                card_id=dc.card_id,
                expected_quantity=dc.expected_quantity,
                scanned_quantity=scanned_qty,
                card=dc.card,
            ))

    payload = {
        "id": instance.id,
        "deck_id": deck.id,
        "name": deck.name,
        "product_type": deck.product_type,
        "source_url": deck.source_url,
        "created_at": instance.created_at,
        "total_count": total_count,
        "scanned_count": scanned_count,
        "progress": round((scanned_count / total_count * 100) if total_count else 0, 1),
        "is_complete": total_count > 0 and scanned_count == total_count,
    }
    if detail:
        payload["cards"] = card_rows
        return DeckInstanceDetailResponse(**payload)
    return DeckInstanceResponse(**payload)


@router.get("/search", response_model=List[DeckSearchResult])
def search_decks(
    q: str = Query(..., min_length=2),
    current_user: User = Depends(get_current_user),
):
    """Search Bulbapedia for candidate deck pages, for the user to confirm before anything is saved."""
    try:
        return bulbapedia.search_bulbapedia(q)
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Could not reach Bulbapedia")


@router.post("/parse", response_model=DeckParseResponse)
def parse_deck(
    request: DeckParseRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Fetch a confirmed Bulbapedia page and best-effort parse it into draft deck(s) for review.

    No Deck/DeckInstance is created here — the frontend shows this for the user
    to review/fix before calling POST /api/decks/ with the confirmed card list.
    Note: resolving an ambiguous entry against TCGdex (services.bulbapedia.
    resolve_entry) can still upsert a Card catalogue row as a side effect,
    same as browsing or searching cards elsewhere in the app already does —
    that's shared reference data, not user-facing deck state.
    """
    try:
        wikitext = bulbapedia.fetch_wikitext(request.title)
    except ValueError:
        raise HTTPException(status_code=404, detail="Bulbapedia page not found")
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Could not reach Bulbapedia")

    raw_blocks = bulbapedia.parse_decklists(wikitext)
    if not raw_blocks:
        raise HTTPException(status_code=422, detail="No deck list found on that page")

    page_url = bulbapedia.BULBAPEDIA_WIKI + request.title.replace(" ", "_")

    blocks = []
    for raw_block in raw_blocks:
        entries = []
        for raw_entry in raw_block["entries"]:
            resolved = bulbapedia.resolve_entry(db, raw_entry)
            card = None
            if resolved["card_id"]:
                card = db.query(Card).options(joinedload(Card.set_ref)).filter(
                    Card.id == resolved["card_id"]
                ).first()
            entries.append(DeckParseEntry(
                raw_name=resolved["raw_name"],
                expected_quantity=resolved["expected_quantity"],
                card_id=resolved["card_id"],
                confident=resolved["confident"],
                candidates=resolved["candidates"],
                card=card,
            ))
        # A page can hold more than one deck, so the saved source_url must be
        # unique per block, not just per page — otherwise saving a second deck
        # from the same page would incorrectly reuse the first one's template.
        block_url = f"{page_url}#{raw_block['name'].replace(' ', '_')}"
        blocks.append(DeckParseBlock(name=raw_block["name"], source_url=block_url, entries=entries))

    return DeckParseResponse(
        title=request.title,
        page_url=page_url,
        product_type=request.product_type,
        blocks=blocks,
    )


def _sync_deck_cards(db: Session, deck: Deck, cards_in: list) -> None:
    """Make a deck template's DeckCard rows match a submitted card list exactly.

    Used both when a deck is first created and when an existing template
    (matched by source_url) is saved again — e.g. the user re-parsed a page
    and corrected an entry that failed to auto-resolve the first time. Without
    this, re-saving under the same source_url would silently keep the old,
    wrong card list forever.
    """
    existing = {dc.card_id: dc for dc in db.query(DeckCard).filter(DeckCard.deck_id == deck.id).all()}
    submitted_card_ids = set()
    for entry in cards_in:
        ensure_card_exists(db, entry.card_id)
        submitted_card_ids.add(entry.card_id)
        current = existing.get(entry.card_id)
        if current:
            current.expected_quantity = entry.expected_quantity
        else:
            db.add(DeckCard(deck_id=deck.id, card_id=entry.card_id, expected_quantity=entry.expected_quantity))
    for card_id, deck_card in existing.items():
        if card_id not in submitted_card_ids:
            db.delete(deck_card)


@router.post("/", response_model=DeckInstanceDetailResponse)
def create_deck(
    deck_in: DeckCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Save a confirmed deck template and start tracking it for the current user.

    Reuses an existing template by source_url if one was already saved (by any
    user, since deck templates are shared catalogue data like Set/Card) —
    reopening the current user's existing instance rather than duplicating it —
    but always syncs the template's card list to what was just submitted, so
    correcting and re-saving a previously-imperfect deck actually takes effect.
    """
    deck = None
    if deck_in.source_url:
        deck = db.query(Deck).filter(Deck.source_url == deck_in.source_url).first()

    if not deck:
        deck = Deck(
            name=deck_in.name,
            product_type=deck_in.product_type,
            source_url=deck_in.source_url,
            created_by_id=current_user.id,
            created_at=datetime.datetime.utcnow(),
        )
        db.add(deck)
        db.flush()

    _sync_deck_cards(db, deck, deck_in.cards)
    db.commit()
    db.refresh(deck)

    instance = db.query(DeckInstance).filter(
        DeckInstance.deck_id == deck.id,
        DeckInstance.user_id == current_user.id,
    ).first()
    if not instance:
        instance = DeckInstance(deck_id=deck.id, user_id=current_user.id, created_at=datetime.datetime.utcnow())
        db.add(instance)
        db.commit()
        db.refresh(instance)

    return _instance_response(db, instance, detail=True)


@router.get("/instances", response_model=List[DeckInstanceResponse])
def list_deck_instances(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    instances = db.query(DeckInstance).options(joinedload(DeckInstance.deck)).filter(
        DeckInstance.user_id == current_user.id,
    ).order_by(DeckInstance.created_at.desc()).all()
    return [_instance_response(db, instance) for instance in instances]


@router.get("/instances/{instance_id}", response_model=DeckInstanceDetailResponse)
def get_deck_instance(
    instance_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    instance = db.query(DeckInstance).options(joinedload(DeckInstance.deck)).filter(
        DeckInstance.id == instance_id,
        DeckInstance.user_id == current_user.id,
    ).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Deck instance not found")
    return _instance_response(db, instance, detail=True)


@router.post("/instances/{instance_id}/reset", response_model=DeckInstanceDetailResponse)
def reset_deck_instance(
    instance_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    instance = db.query(DeckInstance).options(joinedload(DeckInstance.deck)).filter(
        DeckInstance.id == instance_id,
        DeckInstance.user_id == current_user.id,
    ).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Deck instance not found")
    db.query(ScannedCard).filter(ScannedCard.deck_instance_id == instance.id).delete()
    db.commit()
    return _instance_response(db, instance, detail=True)


@router.post("/instances/{instance_id}/scans/{card_id}/undo", response_model=DeckInstanceDetailResponse)
def undo_scan(
    instance_id: int,
    card_id: str,
    # Round-tripped from the /cards/recognize response that produced this
    # scan (only present at all when that user has scan diagnostics
    # enabled — see services/scan_trace.py) so the reversal can be marked
    # on the original trace for auto-save-accuracy analysis. Optional and
    # separate from everything else this route does: a missing, stale, or
    # invalid trace_id must never block the actual undo.
    # Plain default, not Query(default=None): FastAPI infers a simple typed
    # param as a query param automatically without needing the wrapper, and
    # this route is called directly (bypassing FastAPI's own request
    # handling, which resolves Query(...) markers into real values) by
    # every test in this file — Query(default=None) stays a truthy
    # sentinel object rather than None when the function is called that
    # way directly, which a plain default doesn't have.
    trace_id: str | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Reverse one scan: decrement-or-delete both the CollectionItem row
    add_to_collection incremented and the ScannedCard row register_scan
    incremented, in one transaction — unlike _apply_deck_scan (which
    deliberately isolates the collection add from the deck-progress update
    that follows it), this deliberately does NOT isolate the two sides'
    failures from each other. A half-reversed undo (one side decremented,
    the other not) is a more confusing state than a half-applied add.

    Two checks, not the one instance-ownership check reset_deck_instance
    uses: that check alone never validates card_id at all (it has none).
    Without also requiring card_id to be part of THIS deck's template (the
    same check register_scan already does), a card_id that isn't in this
    deck — but that the same user owns elsewhere — would still pass the
    instance-ownership check and could decrement an unrelated collection
    item that happens to match the deterministic defaults below.
    """
    instance = db.query(DeckInstance).options(joinedload(DeckInstance.deck)).filter(
        DeckInstance.id == instance_id,
        DeckInstance.user_id == current_user.id,
    ).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Deck instance not found")

    # The scanner always adds with CollectionItemCreate's own defaults (it
    # never sends variant/condition/lang/purchase_price at all) — read
    # from the schema itself rather than duplicating the literals here, so
    # this can't silently drift from add_to_collection's matching rule if
    # a default value is ever changed in only one place.
    default_fields = CollectionItemCreate.model_fields
    matching_item = find_matching_collection_item(
        db, current_user.id,
        card_id=card_id,
        variant=default_fields["variant"].default,
        lang=default_fields["lang"].default,
        condition=default_fields["condition"].default,
        purchase_price=default_fields["purchase_price"].default,
    )
    if not matching_item:
        raise HTTPException(status_code=404, detail="No matching scan found to undo")

    # Checks card_id is part of this deck's template internally — see its
    # own docstring for why this route still checks instance ownership
    # itself above rather than relying solely on this.
    reversed_progress = unregister_scan(db, current_user.id, instance_id, card_id)
    if not reversed_progress:
        raise HTTPException(status_code=404, detail="No matching scan found to undo")

    if matching_item.quantity <= 1:
        db.delete(matching_item)
    else:
        matching_item.quantity -= 1

    db.commit()

    # Best-effort, file-based, and independent of the transaction just
    # committed above — matches _apply_deck_scan's own rule that a
    # diagnostics side-effect must never make an already-committed action
    # look like it failed.
    try:
        record_scan_reversed(current_user.id, trace_id)
    except Exception:
        logger.exception("Failed to mark scan trace %s as undone", trace_id)

    return _instance_response(db, instance, detail=True)


@router.delete("/instances/{instance_id}")
def delete_deck_instance(
    instance_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    instance = db.query(DeckInstance).filter(
        DeckInstance.id == instance_id,
        DeckInstance.user_id == current_user.id,
    ).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Deck instance not found")
    db.delete(instance)
    db.commit()
    return {"message": "Deck instance removed"}
