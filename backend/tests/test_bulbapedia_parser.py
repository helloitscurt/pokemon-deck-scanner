import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import Card, Set
    from services import bulbapedia
    API_TEST_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    API_TEST_DEPS_AVAILABLE = False


# A trimmed fixture in the same {{halfdecklist}} template convention verified
# against real Bulbapedia pages ("Ex Battle Decks—Ampharos & Lucario (TCG)",
# "Battle Academy 2024 (TCG)") — two decks on one page, a normal {{TCG ID}}
# entry, an energy entry whose Bulbapedia set name doesn't match TCGdex's
# (exercises the alias table), and a promo entry using a bare [[wikilink]]
# instead of {{TCG ID}} (exercises the low-confidence path).
FIXTURE_WIKITEXT = """
Some intro prose that isn't part of any deck list.

==Deck lists==
{{halfdecklist/header|title=Fire Deck|type=Fire|symbol=no}}
{{halfdecklist/entry|033/198|G|{{TCG ID|Scarlet & Violet|Houndour|33}}|Fire||3}}
{{halfdecklist/entry|[[Image:SVP.png|24px|link=SVP Black Star Promos (TCG)]] 105|H|[[Armarouge ex (SVP Promo 105)|Armarouge]]{{ex}}|Fire||1}}
{{halfdecklist/entry|[[Image:SVE.png|24px|link=SVE Basic Energies (TCG)]] 002|G|{{TCG ID|SVE Energy|Basic Fire Energy|2}}|Energy|Fire|18}}
{{halfdecklist/footer}}
{{-}}
{{halfdecklist/header|title=Water Deck|type=Water|symbol=no}}
{{halfdecklist/entry|034/198|G|{{TCG ID|Scarlet & Violet|Houndoom|34}}|Fire||2}}
{{halfdecklist/footer}}
"""


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class BulbapediaParserTests(unittest.TestCase):
    def test_split_top_level_respects_nested_braces_and_brackets(self):
        parts = bulbapedia._split_top_level("a|{{TCG ID|Set|Name|1}}|[[link|text]]|b")
        self.assertEqual(parts, ["a", "{{TCG ID|Set|Name|1}}", "[[link|text]]", "b"])

    def test_extract_balanced_stops_at_matching_close(self):
        text = "{{outer|{{inner}}}} trailing"
        content, end = bulbapedia._extract_balanced(text, 2)
        self.assertEqual(content, "outer|{{inner}}")
        self.assertEqual(text[end:], " trailing")

    def test_parse_name_field_tcg_id_template(self):
        parsed = bulbapedia._parse_name_field("{{TCG ID|Scarlet & Violet|Houndour|33}}")
        self.assertEqual(parsed, {
            "set_name": "Scarlet & Violet",
            "card_name": "Houndour",
            "number": "33",
            "confident": True,
        })

    def test_parse_name_field_promo_wikilink_is_unconfident(self):
        parsed = bulbapedia._parse_name_field("[[Armarouge ex (SVP Promo 105)|Armarouge]]{{ex}}")
        self.assertFalse(parsed["confident"])
        self.assertIsNone(parsed["set_name"])
        self.assertIsNone(parsed["number"])
        self.assertEqual(parsed["card_name"], "Armarouge ex")

    def test_parse_number_field_strips_image_markup_and_total(self):
        self.assertEqual(bulbapedia._parse_number_field("033/198"), "033")
        self.assertEqual(bulbapedia._parse_number_field("[[Image:SVP.png|24px|link=X]] 105"), "105")

    def test_parse_decklists_finds_both_blocks_with_correct_quantities(self):
        blocks = bulbapedia.parse_decklists(FIXTURE_WIKITEXT)
        self.assertEqual(len(blocks), 2)
        self.assertEqual(blocks[0]["name"], "Fire Deck")
        self.assertEqual(blocks[1]["name"], "Water Deck")

        fire_entries = {e["raw_name"]: e for e in blocks[0]["entries"]}
        self.assertEqual(fire_entries["Houndour"]["expected_quantity"], 3)
        self.assertEqual(fire_entries["Houndour"]["set_name"], "Scarlet & Violet")
        self.assertEqual(fire_entries["Houndour"]["number"], "33")
        self.assertTrue(fire_entries["Houndour"]["confident"])

        self.assertFalse(fire_entries["Armarouge ex"]["confident"])
        self.assertIsNone(fire_entries["Armarouge ex"]["set_name"])

        energy = fire_entries["Basic Fire Energy"]
        self.assertEqual(energy["expected_quantity"], 18)
        self.assertEqual(energy["set_name"], "SVE Energy")

        self.assertEqual(len(blocks[1]["entries"]), 1)
        self.assertEqual(blocks[1]["entries"][0]["raw_name"], "Houndoom")


@unittest.skipUnless(API_TEST_DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment")
class BulbapediaResolveEntryTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.set_row = Set(id="sv1_en", tcg_set_id="sv1", name="Scarlet & Violet", lang="en")
        # TCGdex's real name for this subset doesn't match Bulbapedia's {{TCG ID}}
        # set name ("SVE Energy") — this is exactly what the alias table is for.
        self.energy_set = Set(id="sve_en", tcg_set_id="sve", name="Scarlet & Violet Energy", lang="en")
        self.card = Card(id="sv1-33_en", tcg_card_id="sv1-33", name="Houndour", set_id="sv1", number="33", lang="en")
        self.energy_card = Card(id="sve-2_en", tcg_card_id="sve-2", name="Basic Fire Energy", set_id="sve", number="2", lang="en")
        self.db.add_all([self.set_row, self.energy_set, self.card, self.energy_card])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_resolve_entry_matches_exact_set_name(self):
        entry = {"raw_name": "Houndour", "set_name": "Scarlet & Violet", "number": "33", "expected_quantity": 3, "confident": True}
        resolved = bulbapedia.resolve_entry(self.db, entry)
        self.assertTrue(resolved["confident"])
        self.assertEqual(resolved["card_id"], self.card.id)

    def test_resolve_entry_matches_via_known_set_name_alias(self):
        entry = {"raw_name": "Basic Fire Energy", "set_name": "SVE Energy", "number": "2", "expected_quantity": 18, "confident": True}
        resolved = bulbapedia.resolve_entry(self.db, entry)
        self.assertTrue(resolved["confident"])
        self.assertEqual(resolved["card_id"], self.energy_card.id)

    def test_resolve_entry_falls_back_to_live_search_when_set_unmatched(self):
        entry = {"raw_name": "Armarouge ex", "set_name": None, "number": "105", "expected_quantity": 1, "confident": False}
        live_result = {"data": [{"id": "svp-105", "name": "Armarouge ex", "image": "https://example/img"}], "totalCount": 1}
        with patch("services.bulbapedia.pokemon_api.search_cards", return_value=live_result), \
             patch("services.bulbapedia.pokemon_api.parse_card_for_db", return_value={
                 "id": "svp-105_en", "tcg_card_id": "svp-105", "name": "Armarouge ex",
                 "set_id": "svp", "number": "105", "lang": "en",
             }):
            resolved = bulbapedia.resolve_entry(self.db, entry)
        self.assertTrue(resolved["confident"])
        self.assertEqual(resolved["card_id"], "svp-105_en")

    def test_resolve_entry_leaves_ambiguous_live_search_unresolved_with_candidates(self):
        entry = {"raw_name": "Lucario ex", "set_name": None, "number": "017", "expected_quantity": 1, "confident": False}
        live_result = {"data": [
            {"id": "svp-017", "name": "Lucario ex", "image": "https://example/a"},
            {"id": "sv2-100", "name": "Lucario ex", "image": "https://example/b"},
        ], "totalCount": 2}
        with patch("services.bulbapedia.pokemon_api.search_cards", return_value=live_result):
            resolved = bulbapedia.resolve_entry(self.db, entry)
        self.assertFalse(resolved["confident"])
        self.assertIsNone(resolved["card_id"])
        self.assertEqual(len(resolved["candidates"]), 2)

    def test_resolve_entry_unresolved_when_live_search_finds_nothing(self):
        entry = {"raw_name": "Totally Unknown Card", "set_name": None, "number": None, "expected_quantity": 1, "confident": False}
        with patch("services.bulbapedia.pokemon_api.search_cards", return_value={"data": [], "totalCount": 0}):
            resolved = bulbapedia.resolve_entry(self.db, entry)
        self.assertFalse(resolved["confident"])
        self.assertIsNone(resolved["card_id"])
        self.assertEqual(resolved["candidates"], [])


if __name__ == "__main__":
    unittest.main()
