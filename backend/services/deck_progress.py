"""Deck-instance scan progress, shared between api/collection.py and api/decks.py.

Lives here (not in api/decks.py) so api/collection.py can import it normally at
module load time instead of via a deferred import — api/decks.py depending on
api/collection.py's ensure_card_exists is the natural direction (a niche
feature reaching into the core collection module), not the other way around.
"""
import datetime

from sqlalchemy.orm import Session

from models import DeckCard, DeckInstance, ScannedCard


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


def unregister_scan(db: Session, user_id: int, deck_instance_id: int, card_id: str, quantity: int = 1) -> bool:
    """Reverse one register_scan call — decrement-or-delete the matching
    ScannedCard row. Returns whether a row was found to reverse.

    Same ownership/deck-membership checks as register_scan, so this is safe
    to call on its own. Deliberately does NOT commit (unlike register_scan)
    — the caller (api/decks.py's scan-undo route) commits this together
    with the collection-side decrement in one transaction, so undo can't
    half-succeed. That's a stricter consistency model than register_scan's
    own caller uses (_apply_deck_scan deliberately isolates its failure
    from the collection add it follows) — a half-reversed undo is a more
    confusing state than a half-applied add, so undo doesn't get the same
    isolation.
    """
    instance = db.query(DeckInstance).filter(
        DeckInstance.id == deck_instance_id,
        DeckInstance.user_id == user_id,
    ).first()
    if not instance:
        return False

    deck_card = db.query(DeckCard).filter(
        DeckCard.deck_id == instance.deck_id,
        DeckCard.card_id == card_id,
    ).first()
    if not deck_card:
        return False

    scanned = db.query(ScannedCard).filter(
        ScannedCard.deck_instance_id == instance.id,
        ScannedCard.card_id == card_id,
    ).first()
    if not scanned or scanned.scanned_quantity <= 0:
        return False

    if scanned.scanned_quantity <= quantity:
        db.delete(scanned)
    else:
        scanned.scanned_quantity -= quantity
    return True
