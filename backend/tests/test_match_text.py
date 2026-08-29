import io
import unittest
from unittest.mock import AsyncMock, patch

try:
    from fastapi import HTTPException, UploadFile
    from PIL import Image
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.recognize import _numbers_match, match_card_text
    from database import Base
    from models import User
    from services.scan_trace import create_scan_trace
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    HTTPException = Exception
    API_TEST_DEPS_AVAILABLE = False


def _jpeg() -> bytes:
    image = Image.new("RGB", (250, 350), "red")
    output = io.BytesIO()
    image.save(output, format="JPEG")
    return output.getvalue()


def _upload() -> "UploadFile":
    return UploadFile(filename="crop.jpg", file=io.BytesIO(_jpeg()))


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class OcrNumberNormalizationTests(unittest.TestCase):
    """docs/plans/live-card-scanner.md Phase 2, build step 9: check whether
    the existing normalizer tolerates OCR-shaped noise before assuming it
    "just works" unchanged."""

    def test_stray_whitespace_and_case_already_tolerated(self):
        self.assertTrue(_numbers_match("  052 ", "52"))
        self.assertTrue(_numbers_match("tg04", "TG4"))

    def test_ocr_letter_o_zero_confusion_is_not_tolerated_today(self):
        # A card actually numbered "052", misread by OCR as "O52" (letter O
        # for the leading zero — a real Tesseract failure mode, unlike
        # Gemini's vision path this endpoint doesn't share the risk with).
        # This documents a genuine, real gap: it does NOT match today.
        # That's why the plan assigns this specific cleanup to cardOcr.js's
        # own field parsing (frontend/src/utils/cardOcr.js), not this shared
        # matcher — normalize_recognized_card_info() is also relied on by
        # the trusted Gemini-vision path, which doesn't produce this kind of
        # glyph confusion, so the fix belongs at the OCR-specific source.
        self.assertFalse(_numbers_match("O52", "052"))


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class MatchCardTextRouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(username="ash", hashed_password="x", role="trainer", is_active=True)
        self.db.add(self.user)
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    async def test_never_allows_visual_verification_regardless_of_confidence(self):
        # The whole point of this tier is that it can never trigger a paid
        # vision call (see "never costs more than pHash's own free local
        # compute" in the plan) — assert the route's own wiring, not
        # match_card_info's already-tested internal branching.
        with patch(
            "api.recognize.match_card_info",
            new=AsyncMock(return_value={
                "recognized": {}, "matches": [], "_number_match_count": 0,
                "_identity_confident": False, "_identity_decision": None,
            }),
        ) as mock_match:
            await match_card_text(
                name="Pikachu", name_en=None, number_local="25", number_total=None,
                set_code=None, regulation_mark=None, card_type=None, hp=None,
                language=None, artist=None, file=_upload(), source="live_auto_scan",
                db=self.db, current_user=self.user,
            )
        self.assertEqual(mock_match.call_args.kwargs["allow_visual_verification"], False)
        self.assertIsNotNone(mock_match.call_args.kwargs["photo_bytes"])

    async def test_labels_the_trace_as_ocr_sourced_for_later_measurement(self):
        # The only way to eventually answer the plan's build step 11 ("how
        # often does OCR alone resolve confidently vs. fall back") is if
        # these traces are told apart from vision-API scans up front.
        with patch(
            "api.recognize.create_scan_trace",
            wraps=create_scan_trace,
        ) as mock_trace, patch(
            "api.recognize.match_card_info",
            new=AsyncMock(return_value={
                "recognized": {}, "matches": [], "_number_match_count": 0,
                "_identity_confident": False, "_identity_decision": None,
            }),
        ):
            await match_card_text(
                name="Pikachu", name_en=None, number_local="25", number_total=None,
                set_code=None, regulation_mark=None, card_type=None, hp=None,
                language=None, artist=None, file=_upload(), source="live_auto_scan",
                db=self.db, current_user=self.user,
            )
        self.assertEqual(mock_trace.call_args.kwargs["provider"], "ocr")
        self.assertEqual(mock_trace.call_args.kwargs["source"], "live_auto_scan")

    async def test_resolves_confidently_from_ocr_style_metadata_end_to_end(self):
        # Not mocking match_card_info here — exercises the real deterministic
        # matcher (see "The verified backend seam" in the plan) with
        # OCR-shaped input, only stubbing the TCGdex/DB candidate search.
        candidates = [
            {"id": "right", "tcg_card_id": "sv1-25", "number": "025", "_lang": "en"},
            {"id": "wrong", "tcg_card_id": "sv1-26", "number": "26", "_lang": "en"},
        ]
        with patch(
            "api.recognize._search_and_rank_candidates",
            new=AsyncMock(return_value=(candidates, 1)),
        ):
            result = await match_card_text(
                name="Pikachu", name_en=None, number_local="25", number_total=None,
                set_code=None, regulation_mark=None, card_type=None, hp=None,
                language=None, artist=None, file=_upload(), source=None,
                db=self.db, current_user=self.user,
            )
        self.assertTrue(result["_identity_confident"])
        self.assertEqual(result["matches"][0]["id"], "right")
        # Confirms this really was the free metadata path, not a vision call.
        self.assertNotIn("visual", result["_identity_decision"])

    async def test_blank_ocr_name_surfaces_the_existing_422_not_a_crash(self):
        # Simulates OCR finding no usable name at all — cardOcr.js should
        # fall back to Phase 1's recognizeCard() before ever calling this
        # endpoint with nothing, but the backend's existing safety net
        # (_search_and_rank_candidates raises 422 without a name) must still
        # be what surfaces, not an unrelated 500.
        with self.assertRaises(HTTPException) as ctx:
            await match_card_text(
                name="", name_en=None, number_local=None, number_total=None,
                set_code=None, regulation_mark=None, card_type=None, hp=None,
                language=None, artist=None, file=_upload(), source=None,
                db=self.db, current_user=self.user,
            )
        self.assertEqual(ctx.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
