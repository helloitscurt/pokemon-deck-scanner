import io
import random
import unittest
from unittest.mock import AsyncMock, patch

try:
    from fastapi import HTTPException, UploadFile
    from PIL import Image
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.decks import match_deck_image
    from database import Base
    from models import Card, Deck, DeckCard, DeckInstance, ScannedCard, User
    from services.scan_trace import create_scan_trace
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    HTTPException = Exception
    API_TEST_DEPS_AVAILABLE = False


def _image(seed: int) -> bytes:
    rng = random.Random(seed)
    image = Image.new("RGB", (64, 64))
    image.putdata([
        (rng.randrange(256), rng.randrange(256), rng.randrange(256))
        for _ in range(64 * 64)
    ])
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _upload(seed=7) -> "UploadFile":
    return UploadFile(filename="crop.jpg", file=io.BytesIO(_image(seed)))


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class DeckImageMatchTests(unittest.IsolatedAsyncioTestCase):
    """docs/plans/live-card-scanner.md's pipeline redesign: OCR -> pHash
    match against ONLY this deck instance's still-missing cards -> paid
    Gemini call, replacing a broad TCGdex catalog search for the live
    deck-tracking scanner specifically."""

    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.other_user = User(username="misty", hashed_password="x", role="trainer", is_active=True)
        # Three missing cards by default — enough for pHash to run (needs
        # >=2) with room for one test to narrow to exactly 1 or 2.
        self.card_a = Card(
            id="sv1-1_en", tcg_card_id="sv1-1", name="Sprigatito", set_id="sv1",
            number="1", lang="en", images_small="https://assets.tcgdex.net/en/sv/sv1/1/low.webp",
        )
        self.card_b = Card(
            id="sv1-2_en", tcg_card_id="sv1-2", name="Floragato", set_id="sv1",
            number="2", lang="en", images_small="https://assets.tcgdex.net/en/sv/sv1/2/low.webp",
        )
        self.card_c = Card(
            id="sv1-3_en", tcg_card_id="sv1-3", name="Meowscarada", set_id="sv1",
            number="3", lang="en", images_small="https://assets.tcgdex.net/en/sv/sv1/3/low.webp",
        )
        self.deck = Deck(name="Test Deck", product_type="battle_deck", source_url="https://example.com")
        self.db.add_all([self.user, self.other_user, self.card_a, self.card_b, self.card_c, self.deck])
        self.db.commit()
        self.db.add_all([
            DeckCard(deck_id=self.deck.id, card_id=self.card_a.id, expected_quantity=1),
            DeckCard(deck_id=self.deck.id, card_id=self.card_b.id, expected_quantity=1),
            DeckCard(deck_id=self.deck.id, card_id=self.card_c.id, expected_quantity=1),
        ])
        self.instance = DeckInstance(deck_id=self.deck.id, user_id=self.user.id)
        self.db.add(self.instance)
        self.db.commit()
        self.db.refresh(self.instance)

    def tearDown(self):
        self.db.close()

    def _mark_scanned(self, card_id):
        self.db.add(ScannedCard(deck_instance_id=self.instance.id, card_id=card_id, scanned_quantity=1))
        self.db.commit()

    async def test_resolves_confidently_via_phash_against_this_decks_missing_cards(self):
        photo = _image(7)
        with patch(
            "api.decks.download_candidate_images",
            new=AsyncMock(return_value={
                self.card_a.id: photo, self.card_b.id: _image(99), self.card_c.id: _image(50),
            }),
        ):
            result = await match_deck_image(
                self.instance.id, file=_upload(7), number_local=None, name=None, source=None,
                skip_phash=False, current_user=self.user, db=self.db,
            )
        self.assertTrue(result["_identity_confident"])
        self.assertEqual(result["matches"][0]["id"], self.card_a.id)
        self.assertEqual(result["_identity_decision"], "deck_phash")

    async def test_never_compares_against_an_already_fully_scanned_card(self):
        self._mark_scanned(self.card_c.id)
        with patch(
            "api.decks.download_candidate_images",
            new=AsyncMock(return_value={}),
        ) as mock_download:
            await match_deck_image(
                self.instance.id, file=_upload(7), number_local=None, name=None, source=None,
                skip_phash=False, current_user=self.user, db=self.db,
            )
        passed_candidates = mock_download.call_args.args[1]
        self.assertEqual(
            sorted(c["id"] for c in passed_candidates),
            sorted([self.card_a.id, self.card_b.id]),
        )

    async def test_falls_back_to_a_unique_ocr_number_match_when_phash_cannot_run(self):
        # Only one card left missing — pHash structurally cannot run (needs
        # 2+ scored candidates for a confidence margin); OCR's number
        # should still resolve it.
        self._mark_scanned(self.card_b.id)
        self._mark_scanned(self.card_c.id)
        result = await match_deck_image(
            self.instance.id, file=_upload(7), number_local="1", name=None, source=None,
            skip_phash=False, current_user=self.user, db=self.db,
        )
        self.assertTrue(result["_identity_confident"])
        self.assertEqual(result["matches"][0]["id"], self.card_a.id)
        self.assertEqual(result["_identity_decision"], "deck_number_unique")

    async def test_does_not_trust_an_ambiguous_ocr_number_match(self):
        # A second printing sharing the same local number as card_a — OCR's
        # number alone must not pick between them.
        card_a_reprint = Card(
            id="sv1-1_de", tcg_card_id="sv1-1", name="Sprigatito", set_id="sv1",
            number="1", lang="de", images_small="https://assets.tcgdex.net/de/sv/sv1/1/low.webp",
        )
        self.db.add(card_a_reprint)
        self.db.commit()
        self.db.add(DeckCard(deck_id=self.deck.id, card_id=card_a_reprint.id, expected_quantity=1))
        self.db.commit()
        self._mark_scanned(self.card_b.id)
        self._mark_scanned(self.card_c.id)
        with patch("api.decks.download_candidate_images", new=AsyncMock(return_value={})):
            result = await match_deck_image(
                self.instance.id, file=_upload(7), number_local="1", name=None, source=None,
                skip_phash=False, current_user=self.user, db=self.db,
            )
        self.assertFalse(result["_identity_confident"])

    async def test_falls_back_to_a_unique_name_substring_match_when_number_is_missing(self):
        # OCR's own real-device failure mode: adjacent noise words it
        # couldn't confidently drop, e.g. a real "Sprigatito" card read as
        # "bern PRALINE Fe Sprigatito" (see cardOcr.js's pickCardName). A
        # flat equality check would miss this; substring containment
        # shouldn't.
        self._mark_scanned(self.card_b.id)
        self._mark_scanned(self.card_c.id)
        with patch("api.decks.download_candidate_images", new=AsyncMock(return_value={})):
            result = await match_deck_image(
                self.instance.id, file=_upload(7), number_local=None,
                name="bern PRALINE Fe Sprigatito", source=None,
                skip_phash=False, current_user=self.user, db=self.db,
            )
        self.assertTrue(result["_identity_confident"])
        self.assertEqual(result["matches"][0]["id"], self.card_a.id)
        self.assertEqual(result["_identity_decision"], "deck_name_unique")

    async def test_falls_back_to_a_unique_name_match_despite_a_single_character_ocr_misread(self):
        # OCR's other real-device failure mode: a misread character
        # *inside* the name itself, not just noise around it (e.g.
        # Tesseract reading "Picnicker" as "Picnicken"). A strict
        # substring check would miss this entirely; a small edit-distance
        # tolerance should still resolve it uniquely.
        self._mark_scanned(self.card_b.id)
        self._mark_scanned(self.card_c.id)
        with patch("api.decks.download_candidate_images", new=AsyncMock(return_value={})):
            result = await match_deck_image(
                self.instance.id, file=_upload(7), number_local=None,
                name="bern PRALINE Fe Sprigadito", source=None,
                skip_phash=False, current_user=self.user, db=self.db,
            )
        self.assertTrue(result["_identity_confident"])
        self.assertEqual(result["matches"][0]["id"], self.card_a.id)
        self.assertEqual(result["_identity_decision"], "deck_name_unique")

    async def test_does_not_trust_an_ambiguous_name_substring_match(self):
        # Two of this deck's still-missing cards both happen to have their
        # name contained in the OCR'd text — must not guess between them.
        with patch("api.decks.download_candidate_images", new=AsyncMock(return_value={})):
            result = await match_deck_image(
                self.instance.id, file=_upload(7), number_local=None,
                name="Sprigatito Floragato evolution line", source=None,
                skip_phash=False, current_user=self.user, db=self.db,
            )
        self.assertFalse(result["_identity_confident"])

    async def test_returns_not_confident_with_no_missing_cards_instead_of_crashing(self):
        self._mark_scanned(self.card_a.id)
        self._mark_scanned(self.card_b.id)
        self._mark_scanned(self.card_c.id)
        result = await match_deck_image(
            self.instance.id, file=_upload(7), number_local=None, name=None, source=None,
            skip_phash=False, current_user=self.user, db=self.db,
        )
        self.assertFalse(result["_identity_confident"])
        self.assertEqual(result["matches"], [])

    async def test_rejects_access_to_another_users_deck_instance(self):
        with self.assertRaises(HTTPException) as ctx:
            await match_deck_image(
                self.instance.id, file=_upload(7), number_local=None, name=None, source=None,
                skip_phash=False, current_user=self.other_user, db=self.db,
            )
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_labels_the_trace_as_deck_image_sourced(self):
        with patch(
            "api.decks.create_scan_trace",
            wraps=create_scan_trace,
        ) as mock_trace, patch("api.decks.download_candidate_images", new=AsyncMock(return_value={})):
            await match_deck_image(
                self.instance.id, file=_upload(7), number_local=None, name=None, source="live_auto_scan",
                skip_phash=False, current_user=self.user, db=self.db,
            )
        self.assertEqual(mock_trace.call_args.kwargs["provider"], "deck_image")
        self.assertEqual(mock_trace.call_args.kwargs["source"], "live_auto_scan")

    async def test_skip_phash_bypasses_phash_even_with_enough_candidates_to_run_it(self):
        # Phase 3's Path B (docs/plans/live-card-scanner.md) uploads a
        # number-only crop, not a full-card photo — pHash on a fragment
        # could land closer to the wrong candidate than to no candidate at
        # all, so skip_phash must skip the comparison entirely rather than
        # relying on pHash naturally declining to match. Falls through to
        # the number tier instead, same candidates (3) that would
        # otherwise be enough for pHash to run.
        with patch("api.decks.download_candidate_images", new=AsyncMock(return_value={})) as mock_download:
            result = await match_deck_image(
                self.instance.id, file=_upload(7), number_local="1", name=None, source="live_zoom_scan",
                skip_phash=True, current_user=self.user, db=self.db,
            )
        mock_download.assert_not_called()
        self.assertTrue(result["_identity_confident"])
        self.assertEqual(result["matches"][0]["id"], self.card_a.id)
        self.assertEqual(result["_identity_decision"], "deck_number_unique")


if __name__ == "__main__":
    unittest.main()
