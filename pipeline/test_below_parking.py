"""Car parks on a level under the streets (layer < 0) are told apart by OSM's layer tag."""
import unittest

from osm_area import _below


class BelowTests(unittest.TestCase):
    def test_negative_layers_are_below(self):
        for layer in ("-1", "-2", "-1;0", -1):
            with self.subTest(layer=layer):
                self.assertTrue(_below(layer))

    def test_ground_and_above_and_junk_are_not(self):
        for layer in (None, "0", "1", "", "yes", 2):
            with self.subTest(layer=layer):
                self.assertFalse(_below(layer))


if __name__ == "__main__":
    unittest.main()
