"""The packed atlas must place every visible stem on the geometry's centre line."""
from pathlib import Path
import unittest

from PIL import Image


class StreetTreeAtlasTests(unittest.TestCase):
    def test_stems_are_centred(self):
        path = Path(__file__).resolve().parents[1] / "public" / "street-trees.webp"
        with Image.open(path) as atlas:
            self.assertEqual(atlas.size, (1536, 512))
            alpha = atlas.getchannel("A")
            for column, name in enumerate(("leaf", "twig", "needle")):
                with self.subTest(name=name):
                    card = alpha.crop((column * 512, 0, (column + 1) * 512, 512))
                    bottom = card.point(lambda a: 255 if a > 140 else 0).getbbox()[3]
                    xs = [x for y in range(bottom - 3, bottom)
                          for x in range(512) if card.getpixel((x, y)) > 140]
                    self.assertLess(abs(sum(xs) / len(xs) - 256), 3,
                                    "a stem beside the centre floats off its wooden branch")
