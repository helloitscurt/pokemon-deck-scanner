import datetime
from typing import List

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload

from api.auth import get_current_user
from api.collection import ensure_card_exists
from database import get_db
from models import Card, Deck, DeckCard, DeckInstance, ScannedCard, User
from schemas import (
    DeckCreate, DeckInstanceDetailResponse, DeckInstanceResponse, DeckCardResponse,
    DeckSearchResult, DeckParseRequest, DeckParseResponse, DeckParseBlock, DeckParseEntry,
)
from services import bulbapedia

router = APIRouter()


def _instance_response(db: Session, instance: DeckInstance, detail: bool = False):
    deck = instance.deck
    deck_cards = db.query(DeckCard).filter(DeckCard.deck_id == deck.id).all()
    scanned_by_card = {
        sc.card_id: sc
        for sc in db.query(ScannedCard).filter(ScannedCard.deck_instance_id == instance.id).all()
    }

    total_count = len(deck_cards)
    scanned_count = 0
    card_rows = []
    for dc in deck_cards:
        sc = scanned_by_card.get(dc.card_id)
        scanned_qty = min(sc.scanned_quantity if sc else 0, dc.expected_quantity)
        if scanned_qty >= dc.expected_quantity:
            scanned_count += 1
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


def register_scan(db: Session, user_id: int, deck_instance_id: int, card_id: str, quantity: int = 1) -> None:
    """Count a confirmed collection add toward one deck instance's scan progress.

    Silently no-ops if the instance isn't this user's, or the card isn't part of
    that deck's template — a scanned card that doesn't match the active deck
    still lands in the general collection (see api/collection.py), it just
    doesn't move deck progress.
    """
    instance = db.query(DeckInstance).filter(
        DeckInstance.id == deck_instance_id,
        DeckInstance.user_id == user_id,
    ).first()
    if not instance:
        return

    deck_card = db.query(DeckCard).filter(
        DeckCard.deck_id == instance.deck_id,
        DeckCard.card_id == card_id,
    ).first()
    if not deck_card:
        return

    now = datetime.datetime.utcnow()
    scanned = db.query(ScannedCard).filter(
        ScannedCard.deck_instance_id == instance.id,
        ScannedCard.card_id == card_id,
    ).first()
    if scanned:
        scanned.scanned_quantity = min(scanned.scanned_quantity + quantity, deck_card.expected_quantity)
        scanned.last_scanned_at = now
    else:
        db.add(ScannedCard(
            deck_instance_id=instance.id,
            card_id=card_id,
            scanned_quantity=min(quantity, deck_card.expected_quantity),
            last_scanned_at=now,
        ))
    db.commit()


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

    Nothing is saved here — the frontend shows this for the user to review/fix
    before calling POST /api/decks/ with the confirmed card list.
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


@router.post("/", response_model=DeckInstanceDetailResponse)
def create_deck(
    deck_in: DeckCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Save a confirmed deck template and start tracking it for the current user.

    Reuses an existing template by source_url if one was already saved (by any
    user, since deck templates are shared catalogue data like Set/Card), and
    reopens the current user's existing instance rather than duplicating it.
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
        for entry in deck_in.cards:
            ensure_card_exists(db, entry.card_id)
            db.add(DeckCard(deck_id=deck.id, card_id=entry.card_id, expected_quantity=entry.expected_quantity))
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
