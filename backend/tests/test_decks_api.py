import unittest
from unittest.mock import patch

try:
    from fastapi import HTTPException
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.collection import add_to_collection, bulk_add_to_collection
    from api.decks import (
        create_deck,
        delete_deck_instance,
        get_deck_instance,
        list_deck_instances,
        reset_deck_instance,
        undo_scan,
    )
    from database import Base
    from models import Card, CollectionItem, Deck, DeckCard, DeckInstance, ScannedCard, User
    from schemas import (
        BulkCollectionAddRequest,
        CollectionItemCreate,
        DeckCardEntry,
        DeckCreate,
    )
    from services.deck_progress import register_scan, unregister_scan
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    HTTPException = Exception
    API_TEST_DEPS_AVAILABLE = False


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class DeckTrackingApiTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.other_user = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        # A 2-card "deck": one qty-1 card, one qty-2 (energy-like) card.
        self.card_a = Card(id="sv1-1_en", tcg_card_id="sv1-1", name="Sprigatito", set_id="sv1", number="1", lang="en")
        self.card_b = Card(id="sv1-2_en", tcg_card_id="sv1-2", name="Floragato", set_id="sv1", number="2", lang="en")
        self.card_c = Card(id="sv1-3_en", tcg_card_id="sv1-3", name="Meowscarada", set_id="sv1", number="3", lang="en")
        self.db.add_all([self.user, self.other_user, self.card_a, self.card_b, self.card_c])
        self.db.commit()
        self.db.refresh(self.user)
        self.db.refresh(self.other_user)

    def tearDown(self):
        self.db.close()

    def _create_deck(self, user=None, source_url="https://bulbapedia.bulbagarden.net/wiki/Test_Deck", cards=None):
        cards = cards if cards is not None else [
            DeckCardEntry(card_id=self.card_a.id, expected_quantity=1),
            DeckCardEntry(card_id=self.card_b.id, expected_quantity=2),
        ]
        return create_deck(
            DeckCreate(name="Test Deck", product_type="battle_deck", source_url=source_url, cards=cards),
            current_user=user or self.user,
            db=self.db,
        )

    def test_create_deck_progress_starts_at_zero(self):
        instance = self._create_deck()
        self.assertEqual(instance.total_count, 3)  # physical cards: card_a x1 + card_b x2
        self.assertEqual(instance.scanned_count, 0)
        self.assertEqual(instance.progress, 0.0)
        self.assertFalse(instance.is_complete)

    def test_register_scan_caps_at_expected_quantity_and_completes_deck(self):
        instance = self._create_deck()

        register_scan(self.db, self.user.id, instance.id, self.card_a.id, 1)
        register_scan(self.db, self.user.id, instance.id, self.card_b.id, 1)
        mid = get_deck_instance(instance.id, current_user=self.user, db=self.db)
        # Progress is physical cards found (2 of 3: card_a done 1/1, card_b 1/2),
        # not "card types satisfied" (which would read 1/2 = 50%).
        self.assertEqual(mid.progress, round(2 / 3 * 100, 1))
        self.assertFalse(mid.is_complete)

        register_scan(self.db, self.user.id, instance.id, self.card_b.id, 1)
        register_scan(self.db, self.user.id, instance.id, self.card_b.id, 1)  # extra scan past the cap
        done = get_deck_instance(instance.id, current_user=self.user, db=self.db)
        card_b_row = next(c for c in done.cards if c.card_id == self.card_b.id)
        self.assertEqual(card_b_row.scanned_quantity, 2)  # capped at expected_quantity, not 3
        self.assertEqual(done.progress, 100.0)
        self.assertTrue(done.is_complete)

    def test_register_scan_ignores_card_not_in_deck(self):
        instance = self._create_deck()
        register_scan(self.db, self.user.id, instance.id, self.card_c.id, 1)  # not in this deck
        result = get_deck_instance(instance.id, current_user=self.user, db=self.db)
        self.assertEqual(result.scanned_count, 0)
        self.assertEqual(self.db.query(ScannedCard).count(), 0)

    def test_register_scan_ignores_another_users_instance(self):
        instance = self._create_deck(user=self.user)
        register_scan(self.db, self.other_user.id, instance.id, self.card_a.id, 1)
        result = get_deck_instance(instance.id, current_user=self.user, db=self.db)
        self.assertEqual(result.scanned_count, 0)

    def test_reset_zeroes_progress(self):
        instance = self._create_deck()
        register_scan(self.db, self.user.id, instance.id, self.card_a.id, 1)
        self.assertEqual(get_deck_instance(instance.id, current_user=self.user, db=self.db).scanned_count, 1)

        reset = reset_deck_instance(instance.id, current_user=self.user, db=self.db)
        self.assertEqual(reset.scanned_count, 0)
        self.assertEqual(reset.progress, 0.0)

    def test_adding_same_deck_twice_reuses_instance_not_duplicate(self):
        first = self._create_deck()
        second = self._create_deck()
        self.assertEqual(first.id, second.id)
        self.assertEqual(self.db.query(DeckInstance).filter(DeckInstance.user_id == self.user.id).count(), 1)

    def test_two_different_decks_track_independently(self):
        deck_1 = self._create_deck(source_url="https://bulbapedia.bulbagarden.net/wiki/Deck_One")
        deck_2 = self._create_deck(
            source_url="https://bulbapedia.bulbagarden.net/wiki/Deck_Two",
            cards=[DeckCardEntry(card_id=self.card_c.id, expected_quantity=1)],
        )
        register_scan(self.db, self.user.id, deck_1.id, self.card_a.id, 1)

        instances = list_deck_instances(current_user=self.user, db=self.db)
        by_id = {i.id: i for i in instances}
        self.assertEqual(by_id[deck_1.id].scanned_count, 1)
        self.assertEqual(by_id[deck_2.id].scanned_count, 0)

    def test_resaving_deck_under_same_source_url_updates_card_list(self):
        """Regression test for the create_deck reuse bug: saving a deck a second
        time under the same source_url (e.g. after correcting a mis-parsed
        entry) must update the template's card list, not silently keep the old
        one — this used to be a silent no-op."""
        first = self._create_deck(cards=[DeckCardEntry(card_id=self.card_a.id, expected_quantity=1)])
        self.assertEqual(first.total_count, 1)

        second = self._create_deck(cards=[
            DeckCardEntry(card_id=self.card_a.id, expected_quantity=1),
            DeckCardEntry(card_id=self.card_b.id, expected_quantity=3),
        ])
        self.assertEqual(second.id, first.id)  # still the same instance
        self.assertEqual(second.deck_id, first.deck_id)  # still the same template
        self.assertEqual(second.total_count, 4)  # physical cards: card_a x1 + card_b x3
        card_b_row = next(c for c in second.cards if c.card_id == self.card_b.id)
        self.assertEqual(card_b_row.expected_quantity, 3)

        # Dropping card_a from a re-save should remove its DeckCard row entirely.
        third = self._create_deck(cards=[DeckCardEntry(card_id=self.card_b.id, expected_quantity=3)])
        self.assertEqual(third.total_count, 3)  # physical cards: card_b x3 only
        self.assertEqual(self.db.query(DeckCard).filter(DeckCard.deck_id == first.deck_id).count(), 1)

    def test_deck_card_with_null_card_id_excluded_from_progress(self):
        """DeckCard.card_id is nulled (ON DELETE SET NULL) if its Card is ever
        deleted. That entry can never be completed again, so it must not be
        counted — otherwise a deck could never reach 100%."""
        instance = self._create_deck()
        orphaned = DeckCard(deck_id=instance.deck_id, card_id=None, expected_quantity=1)
        self.db.add(orphaned)
        self.db.commit()

        register_scan(self.db, self.user.id, instance.id, self.card_a.id, 1)
        register_scan(self.db, self.user.id, instance.id, self.card_b.id, 2)
        result = get_deck_instance(instance.id, current_user=self.user, db=self.db)
        self.assertEqual(result.total_count, 3)  # not 4 — the orphaned row's quantity is excluded
        self.assertTrue(result.is_complete)

    def test_instance_scoped_endpoints_reject_other_users(self):
        instance = self._create_deck(user=self.user)
        with self.assertRaises(HTTPException):
            get_deck_instance(instance.id, current_user=self.other_user, db=self.db)
        with self.assertRaises(HTTPException):
            reset_deck_instance(instance.id, current_user=self.other_user, db=self.db)
        with self.assertRaises(HTTPException):
            delete_deck_instance(instance.id, current_user=self.other_user, db=self.db)

    def test_delete_instance_keeps_shared_deck_template(self):
        instance = self._create_deck()
        deck_id = instance.deck_id
        delete_deck_instance(instance.id, current_user=self.user, db=self.db)
        self.assertIsNone(self.db.query(DeckInstance).filter(DeckInstance.id == instance.id).first())
        self.assertIsNotNone(self.db.query(Deck).filter(Deck.id == deck_id).first())

    def test_collection_add_with_deck_instance_id_updates_progress(self):
        instance = self._create_deck()
        add_to_collection(
            CollectionItemCreate(card_id=self.card_a.id, quantity=1, deck_instance_id=instance.id),
            current_user=self.user,
            db=self.db,
        )
        result = get_deck_instance(instance.id, current_user=self.user, db=self.db)
        self.assertEqual(result.scanned_count, 1)

    def test_bulk_add_deck_scan_failure_does_not_mark_item_failed(self):
        """Regression test: if register_scan raises, bulk-add must still report
        the card as added — the collection write already committed successfully
        and must not be reported as failed just because the secondary deck-
        progress update blew up."""
        instance = self._create_deck()
        with patch("api.collection.register_scan", side_effect=RuntimeError("boom")):
            result = bulk_add_to_collection(
                BulkCollectionAddRequest(items=[
                    CollectionItemCreate(card_id=self.card_a.id, quantity=1, deck_instance_id=instance.id),
                ]),
                current_user=self.user,
                db=self.db,
            )
        self.assertEqual(result.added, 1)
        self.assertEqual(result.failed, 0)
        self.assertEqual(self.db.query(ScannedCard).count(), 0)  # the scan update itself didn't happen


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class UnregisterScanTests(unittest.TestCase):
    """unregister_scan is the deck-progress side of undo, in isolation —
    see UndoScanTests below for the full route (both sides, one
    transaction)."""

    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.card_a = Card(id="sv1-1_en", tcg_card_id="sv1-1", name="Sprigatito", set_id="sv1", number="1", lang="en")
        self.card_b = Card(id="sv1-2_en", tcg_card_id="sv1-2", name="Floragato", set_id="sv1", number="2", lang="en")
        self.db.add_all([self.user, self.card_a, self.card_b])
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def _create_deck(self):
        return create_deck(
            DeckCreate(
                name="Test Deck", product_type="battle_deck",
                source_url="https://bulbapedia.bulbagarden.net/wiki/Test_Deck",
                cards=[
                    DeckCardEntry(card_id=self.card_a.id, expected_quantity=1),
                    DeckCardEntry(card_id=self.card_b.id, expected_quantity=2),
                ],
            ),
            current_user=self.user,
            db=self.db,
        )

    def test_decrements_a_row_above_one_without_deleting_it(self):
        instance = self._create_deck()
        register_scan(self.db, self.user.id, instance.id, self.card_b.id, 2)

        reversed_ = unregister_scan(self.db, self.user.id, instance.id, self.card_b.id)
        self.db.commit()

        self.assertTrue(reversed_)
        row = self.db.query(ScannedCard).filter(
            ScannedCard.deck_instance_id == instance.id, ScannedCard.card_id == self.card_b.id,
        ).first()
        self.assertEqual(row.scanned_quantity, 1)

    def test_deletes_the_row_at_zero(self):
        instance = self._create_deck()
        register_scan(self.db, self.user.id, instance.id, self.card_a.id, 1)

        reversed_ = unregister_scan(self.db, self.user.id, instance.id, self.card_a.id)
        self.db.commit()

        self.assertTrue(reversed_)
        self.assertIsNone(self.db.query(ScannedCard).filter(
            ScannedCard.deck_instance_id == instance.id, ScannedCard.card_id == self.card_a.id,
        ).first())

    def test_returns_false_for_a_card_not_in_the_deck(self):
        instance = self._create_deck()
        self.assertFalse(unregister_scan(self.db, self.user.id, instance.id, "not-in-deck_en"))

    def test_returns_false_with_no_scan_progress_to_reverse(self):
        instance = self._create_deck()  # card_a/card_b in the deck, but never scanned
        self.assertFalse(unregister_scan(self.db, self.user.id, instance.id, self.card_a.id))

    def test_returns_false_for_another_users_instance(self):
        other_user = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        self.db.add(other_user)
        self.db.commit()
        instance = self._create_deck()
        register_scan(self.db, self.user.id, instance.id, self.card_a.id, 1)

        self.assertFalse(unregister_scan(self.db, other_user.id, instance.id, self.card_a.id))
        # untouched
        row = self.db.query(ScannedCard).filter(ScannedCard.deck_instance_id == instance.id).first()
        self.assertEqual(row.scanned_quantity, 1)

    def test_does_not_commit_the_caller_must(self):
        """Deliberately not self-committing — the undo route needs this
        change and the collection-side decrement in one transaction. If
        this ever started committing on its own, that guarantee would
        silently break."""
        instance = self._create_deck()
        register_scan(self.db, self.user.id, instance.id, self.card_a.id, 1)

        unregister_scan(self.db, self.user.id, instance.id, self.card_a.id)
        self.db.rollback()

        row = self.db.query(ScannedCard).filter(ScannedCard.deck_instance_id == instance.id).first()
        self.assertEqual(row.scanned_quantity, 1)  # the rollback undid it


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class UndoScanTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.other_user = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        self.card_a = Card(id="sv1-1_en", tcg_card_id="sv1-1", name="Sprigatito", set_id="sv1", number="1", lang="en")
        self.card_b = Card(id="sv1-2_en", tcg_card_id="sv1-2", name="Floragato", set_id="sv1", number="2", lang="en")
        self.card_c = Card(id="sv1-3_en", tcg_card_id="sv1-3", name="Meowscarada", set_id="sv1", number="3", lang="en")
        self.db.add_all([self.user, self.other_user, self.card_a, self.card_b, self.card_c])
        self.db.commit()
        self.db.refresh(self.user)
        self.db.refresh(self.other_user)

    def tearDown(self):
        self.db.close()

    def _create_deck(self, user=None):
        return create_deck(
            DeckCreate(
                name="Test Deck", product_type="battle_deck",
                source_url="https://bulbapedia.bulbagarden.net/wiki/Test_Deck",
                cards=[
                    DeckCardEntry(card_id=self.card_a.id, expected_quantity=1),
                    DeckCardEntry(card_id=self.card_b.id, expected_quantity=2),
                ],
            ),
            current_user=user or self.user,
            db=self.db,
        )

    def _confirm_scan(self, instance, card, user=None):
        # Mirrors exactly what the live scanner sends — no variant/lang/
        # condition/purchase_price, only card_id/quantity/deck_instance_id
        # (see DeckDetail.jsx's scanMutation) — so the schema's own
        # defaults (variant="Normal", condition="NM", purchase_price=None,
        # lang effectively "en") are what undo_scan's deterministic lookup
        # below has to match.
        return add_to_collection(
            CollectionItemCreate(card_id=card.id, quantity=1, deck_instance_id=instance.id),
            current_user=user or self.user,
            db=self.db,
        )

    def _collection_item(self, card, user=None):
        return self.db.query(CollectionItem).filter(
            CollectionItem.card_id == card.id,
            CollectionItem.user_id == (user or self.user).id,
        ).first()

    def test_decrements_a_grouped_row_without_deleting_it(self):
        instance = self._create_deck()
        self._confirm_scan(instance, self.card_b)  # expects 2
        self._confirm_scan(instance, self.card_b)  # quantity now 2, scanned_quantity 2

        result = undo_scan(instance.id, self.card_b.id, current_user=self.user, db=self.db)

        self.assertEqual(self._collection_item(self.card_b).quantity, 1)
        card_b_row = next(c for c in result.cards if c.card_id == self.card_b.id)
        self.assertEqual(card_b_row.scanned_quantity, 1)

    def test_deletes_the_row_at_zero_on_both_sides(self):
        instance = self._create_deck()
        self._confirm_scan(instance, self.card_a)  # expects 1, quantity=1

        undo_scan(instance.id, self.card_a.id, current_user=self.user, db=self.db)

        self.assertIsNone(self._collection_item(self.card_a))
        self.assertIsNone(self.db.query(ScannedCard).filter(
            ScannedCard.deck_instance_id == instance.id, ScannedCard.card_id == self.card_a.id,
        ).first())

    def test_atomic_neither_side_changes_if_the_deck_progress_side_fails(self):
        instance = self._create_deck()
        self._confirm_scan(instance, self.card_a)

        with patch("api.decks.unregister_scan", return_value=False):
            with self.assertRaises(HTTPException):
                undo_scan(instance.id, self.card_a.id, current_user=self.user, db=self.db)

        # The collection row was found and validated before the
        # deck-progress side failed — it must still be untouched, not
        # decremented while its counterpart wasn't.
        self.assertEqual(self._collection_item(self.card_a).quantity, 1)

    def test_rejects_a_card_id_not_in_this_deck(self):
        instance = self._create_deck()  # only card_a, card_b
        add_to_collection(
            CollectionItemCreate(card_id=self.card_c.id, quantity=1),  # owned, but not via this deck
            current_user=self.user, db=self.db,
        )

        with self.assertRaises(HTTPException):
            undo_scan(instance.id, self.card_c.id, current_user=self.user, db=self.db)

        self.assertEqual(self._collection_item(self.card_c).quantity, 1)  # untouched

    def test_rejects_when_no_matching_scan_exists(self):
        instance = self._create_deck()
        with self.assertRaises(HTTPException):
            undo_scan(instance.id, self.card_a.id, current_user=self.user, db=self.db)

    def test_rejects_another_users_instance(self):
        instance = self._create_deck(user=self.user)
        self._confirm_scan(instance, self.card_a)
        with self.assertRaises(HTTPException):
            undo_scan(instance.id, self.card_a.id, current_user=self.other_user, db=self.db)
        self.assertEqual(self._collection_item(self.card_a).quantity, 1)  # untouched

    def test_repeated_undo_calls_each_decrement_by_one(self):
        """Not double-tap protection (that's the frontend's in-flight
        disable) — this is the "safe to call more than once, always
        relative to current state" property the plan calls for: two
        genuine undo calls for the same card must each take effect, not
        have the second one silently no-op."""
        instance = self._create_deck()
        self._confirm_scan(instance, self.card_b)
        self._confirm_scan(instance, self.card_b)  # quantity 2

        undo_scan(instance.id, self.card_b.id, current_user=self.user, db=self.db)
        undo_scan(instance.id, self.card_b.id, current_user=self.user, db=self.db)

        self.assertIsNone(self._collection_item(self.card_b))
        self.assertIsNone(self.db.query(ScannedCard).filter(
            ScannedCard.deck_instance_id == instance.id, ScannedCard.card_id == self.card_b.id,
        ).first())

    def test_passes_trace_id_through_to_scan_trace_when_given(self):
        instance = self._create_deck()
        self._confirm_scan(instance, self.card_a)

        with patch("api.decks.record_scan_reversed") as mock_record:
            undo_scan(instance.id, self.card_a.id, trace_id="abc123def456", current_user=self.user, db=self.db)

        mock_record.assert_called_once_with(self.user.id, "abc123def456")

    def test_omitting_trace_id_calls_scan_trace_with_none_not_a_sentinel(self):
        """Regression test: trace_id used to default via Query(default=None),
        which resolves to a truthy Query(None) marker object (not None) when
        this route is called directly rather than through a real FastAPI
        request — exactly how every test in this file calls it. A plain
        default fixes that; this pins the actual value passed through."""
        instance = self._create_deck()
        self._confirm_scan(instance, self.card_a)

        with patch("api.decks.record_scan_reversed") as mock_record:
            undo_scan(instance.id, self.card_a.id, current_user=self.user, db=self.db)

        mock_record.assert_called_once_with(self.user.id, None)

    def test_undo_succeeds_even_if_recording_the_trace_reversal_fails(self):
        """Regression test for the same isolation _apply_deck_scan already
        gets right: a diagnostics-only failure must never make an
        already-committed undo look like it failed."""
        instance = self._create_deck()
        self._confirm_scan(instance, self.card_a)

        with patch("api.decks.record_scan_reversed", side_effect=RuntimeError("boom")):
            result = undo_scan(instance.id, self.card_a.id, trace_id="abc123", current_user=self.user, db=self.db)

        self.assertEqual(result.scanned_count, 0)
        self.assertIsNone(self._collection_item(self.card_a))


if __name__ == "__main__":
    unittest.main()
