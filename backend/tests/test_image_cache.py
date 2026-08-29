import unittest

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import ImageCache
    from services.image_cache import get_cached_image, image_cache_key, store_cached_image

    DEPS_AVAILABLE = True
except ImportError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "SQLAlchemy is not installed in this lightweight test environment")
class ImageCacheTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()

    def test_get_cached_image_returns_none_on_miss(self):
        self.assertIsNone(get_cached_image(self.db, "https://assets.tcgdex.net/x.webp"))

    def test_store_then_get_round_trips(self):
        url = "https://assets.tcgdex.net/x.webp"
        stored = store_cached_image(self.db, url, b"bytes", "image/webp")
        self.assertEqual(stored, (b"bytes", "image/webp"))
        self.assertEqual(get_cached_image(self.db, url), (b"bytes", "image/webp"))

    def test_key_is_a_pure_function_of_the_url(self):
        url = "https://assets.tcgdex.net/en/base/base1/1/low.webp"
        self.assertEqual(image_cache_key(url), image_cache_key(url))
        self.assertNotEqual(image_cache_key(url), image_cache_key(url + "x"))

    def test_two_different_urls_do_not_collide(self):
        store_cached_image(self.db, "https://assets.tcgdex.net/a.webp", b"a", "image/webp")
        store_cached_image(self.db, "https://assets.tcgdex.net/b.webp", b"b", "image/webp")
        self.assertEqual(
            get_cached_image(self.db, "https://assets.tcgdex.net/a.webp"), (b"a", "image/webp")
        )
        self.assertEqual(
            get_cached_image(self.db, "https://assets.tcgdex.net/b.webp"), (b"b", "image/webp")
        )

    def test_a_losing_concurrent_write_returns_the_winners_row(self):
        # store_cached_image always inserts a fresh row rather than checking
        # first, so calling it twice for the same URL simulates two writers
        # racing: the second commit hits the unique constraint on image_key
        # and must roll back to the first writer's already-committed bytes,
        # not raise.
        url = "https://assets.tcgdex.net/x.webp"
        first = store_cached_image(self.db, url, b"first", "image/webp")
        second = store_cached_image(self.db, url, b"second", "image/webp")

        self.assertEqual(first, (b"first", "image/webp"))
        self.assertEqual(second, (b"first", "image/webp"))
        self.assertEqual(get_cached_image(self.db, url), (b"first", "image/webp"))
        self.assertEqual(
            self.db.query(ImageCache).filter(ImageCache.image_key == image_cache_key(url)).count(),
            1,
        )


if __name__ == "__main__":
    unittest.main()
