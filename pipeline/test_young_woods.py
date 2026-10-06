"""Young woods are found where a mapped wood has a low canopy in the surface model, and go stale with the wood outlines and heights."""

import unittest
from unittest import mock

import numpy as np

import layers
import young_woods

BOX = [0.0, 0.0, 120.0, 120.0]
TILE = {"i": 0, "j": 0, "box": BOX}
WOOD = [[[[0, 0], [120, 0], [120, 120], [0, 120], [0, 0]]]]


def surface(low_left_half, ground=300.0):
    """A 120 m square wood on flat ground: 3 m canopy in the left half, 18 m in the right."""
    dsm = np.full((120, 120), ground + 18.0, np.float32)
    if low_left_half:
        dsm[:, :60] = ground + 3.0
    return dsm


def photo_of(colour):
    return np.full((120, 120, 3), colour, np.float32)


GRASS, CANOPY, ROCK = (0.55, 0.6, 0.35), (0.22, 0.3, 0.2), (0.6, 0.6, 0.58)


def mask_for(dsm, ground=300.0, photo=GRASS):
    with mock.patch.object(young_woods.gc, "ipr_dsm", return_value=dsm), \
         mock.patch.object(young_woods.gc, "photo", return_value=photo_of(photo)), \
         mock.patch.object(young_woods.gc, "terrain", return_value=(np.full((31, 31), ground, np.float32), 4.0)):
        return young_woods.young_mask("x", {}, TILE, WOOD)


class YoungMaskTests(unittest.TestCase):
    def test_a_low_canopy_is_young_and_a_tall_one_is_not(self):
        young, _, in_wood = mask_for(surface(True))
        self.assertTrue(in_wood.all())
        self.assertTrue(young[:, 5:55].all())
        self.assertFalse(young[:, 65:].any())

    def test_where_the_surface_model_has_nothing_nothing_is_young(self):
        young, _, _ = mask_for(np.zeros((120, 120), np.float32))
        self.assertFalse(young.any())

    def test_low_growth_outside_the_wood_is_left_alone(self):
        with mock.patch.object(young_woods.gc, "ipr_dsm", return_value=surface(True)), \
             mock.patch.object(young_woods.gc, "terrain", return_value=(np.full((31, 31), 300.0, np.float32), 4.0)):
            young, _, _ = young_woods.young_mask("x", {}, TILE, [[[[60, 0], [120, 0], [120, 120], [60, 120], [60, 0]]]])
        self.assertFalse(young[:, :55].any())

    def test_patches_under_the_minimum_are_dropped(self):
        dsm = surface(False)
        dsm[50:60, 50:60] = 303.0  # 100 m2
        self.assertFalse(mask_for(dsm)[0].any())

    def test_bare_ground_inside_the_wood_is_a_clearing_not_a_young_wood(self):
        dsm = surface(False)
        dsm[30:70, 30:70] = 300.3  # 1,600 m2 of grass
        dsm[90:100, 90:100] = 300.3  # 100 m2: a gap between crowns
        young, clear, _ = mask_for(dsm)
        self.assertFalse(young.any())
        self.assertTrue(clear[36:64, 36:64].all())
        self.assertFalse(clear[85:105, 85:105].any())
        polys = young_woods.vectorise(clear, TILE, WOOD, young_woods.CLEAR_MIN)
        self.assertEqual(len(polys), 1)

    def test_a_low_surface_under_a_canopy_or_over_rock_is_not_a_clearing(self):
        dsm = surface(False)
        dsm[30:70, 30:70] = 300.3
        self.assertFalse(mask_for(dsm, photo=CANOPY)[1].any())
        self.assertFalse(mask_for(dsm, photo=ROCK)[1].any())
        with mock.patch.object(young_woods.gc, "ipr_dsm", return_value=dsm), \
             mock.patch.object(young_woods.gc, "photo", side_effect=OSError("offline")), \
             mock.patch.object(young_woods.gc, "terrain", return_value=(np.full((31, 31), 300.0, np.float32), 4.0)):
            self.assertFalse(young_woods.young_mask("x", {}, TILE, WOOD)[1].any())

    def test_a_steep_slope_is_not_a_clearing(self):
        rows = np.arange(120, dtype=np.float32)[:, None] * np.ones((1, 120), np.float32)
        ground = np.arange(31, dtype=np.float32)[:, None] * np.ones((1, 31), np.float32) * 4.0  # 45 degrees
        with mock.patch.object(young_woods.gc, "ipr_dsm", return_value=300.0 + 119 - rows + 0.3), \
             mock.patch.object(young_woods.gc, "photo", return_value=photo_of(GRASS)), \
             mock.patch.object(young_woods.gc, "terrain", return_value=(300.0 + ground, 4.0)):
            young, clear, _ = young_woods.young_mask("x", {}, TILE, WOOD)
        self.assertFalse(clear[8:-8].any())  # (the smoothed slope flattens at the tile's very edge)

    def test_polygons_stay_inside_the_wood_and_tile(self):
        young, _, _ = mask_for(surface(True))
        polys = young_woods.vectorise(young, TILE, WOOD)
        self.assertEqual(len(polys), 1)
        xs = [x for ring in polys[0] for x, _ in ring]
        self.assertGreaterEqual(min(xs), 0)
        self.assertEqual(min(xs), 0)  # it reaches the tile's edge, where it goes on next door
        ys = [y for ring in polys[0] for _, y in ring]
        self.assertEqual((min(ys), max(ys)), (0, 120))
        self.assertTrue(55 < max(xs) < 65)


class YoungLayerTests(unittest.TestCase):
    def tile(self, **areas):
        return {"areas": areas}

    def test_key_follows_the_wood_outlines_and_heights_but_not_the_young_woods(self):
        t = self.tile(wood=WOOD)
        key = layers.young_key(t, "h1")
        t["areas"] = {**t["areas"], "young_wood": WOOD, "wood_clearing": WOOD}
        self.assertEqual(layers.young_key(t, "h1"), key)
        self.assertNotEqual(layers.young_key(t, "h2"), key)
        self.assertNotEqual(layers.young_key(self.tile(wood=WOOD, dtm_wood=WOOD), "h1"), key)

    def test_key_agrees_with_the_one_the_build_makes(self):
        t = self.tile(wood=WOOD)
        self.assertEqual(young_woods.tile_key(young_woods.wood_of(t), "h1"), layers.young_key(t, "h1"))


if __name__ == "__main__":
    unittest.main()
