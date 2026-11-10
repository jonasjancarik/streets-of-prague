"""Pinned graph heights must stay continuous instead of changing nearest-anchor pairs."""
import copy
import unittest
from unittest.mock import patch

import numpy as np
import structures


def way(ident, nodes, points, layer=2):
    return {'id':ident,'nodes':nodes,'pts':points,'kind':'bridge','layer':layer}


def branch():
    return [way(1,[1,10],[[-306,-2],[0,0]]),way(2,[2,10],[[-306.7,2],[0,0]]),
            way(3,[10,30],[[0,0],[1305,0]])]


class PadTests(unittest.TestCase):
    def test_a_street_s_pad_reaches_a_little_under_its_bridge(self):
        # A bridge from (0, 0) east, drawn from 5 m past its wall's edge: the pad is the
        # street's last 5 m west of it at the bridge's height, and PAD_INTO under the deck.
        import shapely
        way = {"pts": [(0.0, 0.0), (20.0, 0.0)], "w": 8.0, "raised": {0: (5.0, 264.0)}}
        (pad, height), = structures.pads([way])
        assert height == 264.0
        inside = shapely.contains_xy(pad, [-4.0, 1.5, 3.0], [0.0, 0.0, 0.0]).tolist()
        assert inside == [True, True, False], inside

    def test_a_street_under_the_bridge_s_end_keeps_its_own_height(self):
        # The street the bridge runs on into (west) is lifted; one ending under the
        # north half of the deck's first metres (x = 1.5, 1 m wide) isn't, nor the
        # ground within PAD_CLEAR of it, but the deck's south corner is.
        import shapely
        from shapely.geometry import LineString
        way = {"pts": [(0.0, 0.0), (20.0, 0.0)], "w": 8.0, "raised": {0: (5.0, 264.0)}}
        streets = [(LineString([(-30.0, 0.0), (0.0, 0.0)]), 4.0), (LineString([(1.5, 3.0), (1.5, 20.0)]), 0.5)]
        (pad, _), = structures.pads([way], streets, clear=1.5)
        inside = shapely.contains_xy(pad, [-4.0, 1.5, 1.0, 1.0], [0.0, 3.5, 1.5, -4.0]).tolist()
        assert inside == [True, False, False, True], inside


class StructureHeightTests(unittest.TestCase):
    def pins(self, net, heights):
        return {net.key['n',node]:h for node,h in heights.items()}

    def test_same_side_anchor_switch_is_continuous_at_junction_and_along_span(self):
        net=structures.Net(branch());pins=self.pins(net,{1:197.088,2:198.638,30:242.912})
        near=net.spread(pins);path=net.paths[2];length=np.hypot(*(np.diff(net.xy[path],axis=0)).T)
        self.assertLess(np.max(np.abs(np.diff(net.h[path]))/length),.1)
        arms=[np.hypot(*(np.array(w['pts'][1])-w['pts'][0])) for w in branch()]
        expected=sum(h/L for h,L in zip([197.088,198.638,242.912],arms))/sum(1/L for L in arms)
        self.assertAlmostEqual(net.h[net.key['n',10]],expected,8)
        for i,h in pins.items():self.assertEqual(net.h[i],h);self.assertEqual(near[i],0)

    def test_unequal_edge_lengths_are_linear_on_a_chain(self):
        net=structures.Net([way(1,[1,2,3,4],[[0,0],[17,0],[60,0],[103,0]])])
        near=net.spread(self.pins(net,{1:190,4:240}))
        np.testing.assert_allclose(net.h,190+50*net.xy[:,0]/103,atol=1e-8)
        np.testing.assert_allclose(near,np.minimum(net.xy[:,0],103-net.xy[:,0]),atol=1e-10)

    def test_multiple_pinned_samples_bracket_a_gap_without_nearest_cluster_switch(self):
        net=structures.Net([way(1,[1,2,3,4,5],[[0,0],[5,0],[95,0],[100,0],[200,0]])])
        pins=self.pins(net,{1:200,2:200.1,3:220,4:220.1,5:230})
        net.spread(pins)
        expected=np.interp(net.xy[:,0],[0,5,95,100,200],[200,200.1,220,220.1,230])
        np.testing.assert_allclose(net.h,expected,atol=1e-8)
        for i,h in pins.items():self.assertEqual(net.h[i],h)

    def test_empty_zero_one_anchor_and_disconnected_components(self):
        empty=structures.Net([]);self.assertEqual(len(empty.spread({})),0)
        net=structures.Net([way(1,[1,2],[[0,0],[20,0]]),way(2,[3,4],[[100,0],[120,0]])])
        self.assertTrue(np.isinf(net.spread({})).all());self.assertTrue(np.isnan(net.h).all())
        near=net.spread(self.pins(net,{1:210}))
        np.testing.assert_array_equal(net.h[net.paths[0]],210)
        self.assertTrue(np.isnan(net.h[net.paths[1]]).all());self.assertTrue(np.isinf(near[net.paths[1]]).all())
        self.assertTrue(np.isnan(net.h[net.paths[1]]).all())
        net.spread({});self.assertTrue(np.isnan(net.h).all())  # no stale previous estimate

    def test_nonfinite_anchor_leaves_free_heights_unknown_and_preserves_known_pins(self):
        net=structures.Net([way(1,[1,2],[[0,0],[20,0]])]);pins=self.pins(net,{1:210,2:np.nan})
        near=net.spread(pins)
        self.assertEqual(net.h[net.key['n',1]],210);self.assertTrue(np.isnan(net.h[net.paths[0][1:]]).all())
        np.testing.assert_allclose(near,np.minimum(net.xy[:,0],20-net.xy[:,0]))

    def test_path_reversal_and_way_order_do_not_change_physical_heights(self):
        original=branch();reverse=copy.deepcopy(original[::-1])
        for w in reverse:w['nodes'].reverse();w['pts'].reverse()
        out=[]
        for ways in [original,reverse]:
            net=structures.Net(ways);net.spread(self.pins(net,{1:197.088,2:198.638,30:242.912}))
            out.append(sorted((round(x,9),round(y,9),h)for (x,y),h in zip(net.xy,net.h)))
        np.testing.assert_allclose(out[0],out[1],atol=1e-8)

    def test_long_chain_and_genuine_steep_anchors_are_not_capped(self):
        for length,high in [(20000,250),(10,390)]:
            net=structures.Net([way(1,[1,2],[[0,0],[length,0]])]);net.spread(self.pins(net,{1:190,2:high}))
            np.testing.assert_allclose(net.h,190+(high-190)*net.xy[:,0]/length,atol=1e-6)
            self.assertEqual(net.h[net.key['n',2]],high)

    def test_separate_deck_layers_do_not_share_graph_constraints(self):
        net=structures.Net([way(1,[1,2],[[0,0],[100,0]],1),way(2,[3,4],[[0,0],[100,0]],2)])
        net.spread(self.pins(net,{1:190,2:200,3:220,4:230}))
        np.testing.assert_allclose(net.h[net.paths[0]],190+net.xy[net.paths[0],0]/10)
        np.testing.assert_allclose(net.h[net.paths[1]],220+net.xy[net.paths[1],0]/10)

    def test_many_disconnected_components_keep_their_own_anchor_ranges(self):
        ways=[way(k,[2*k,2*k+1],[[k*100,0],[k*100+20,0]]) for k in range(200)]
        net=structures.Net(ways);heights={}
        for k in range(200):heights[2*k]=190+k/10;heights[2*k+1]=191+k/10
        net.spread(self.pins(net,heights))
        for k,path in enumerate(net.paths):
            np.testing.assert_allclose(net.h[path],190+k/10+(net.xy[path,0]-k*100)/20,atol=1e-8)

    def test_nonfinite_sparse_result_is_rejected_without_assignment(self):
        net=structures.Net([way(1,[1,2],[[0,0],[20,0]])]);pins=self.pins(net,{1:190,2:220})
        with patch.object(structures,'spsolve',return_value=np.full(3,np.nan)):
            with self.assertRaisesRegex(RuntimeError,'component 0 returned a non-finite height at node'):
                net.spread(pins)
        self.assertTrue(np.isnan(net.h[net.paths[0][1:-1]]).all())
        for i,h in pins.items():self.assertEqual(net.h[i],h)

    def test_gross_maximum_principle_violation_is_rejected_not_clamped(self):
        for value in [189,221]:
            net=structures.Net([way(1,[1,2],[[0,0],[20,0]])])
            with patch.object(structures,'spsolve',return_value=np.full(3,value)):
                with self.assertRaisesRegex(RuntimeError,r'outside fixed range \[190, 220\].*tolerance'):
                    net.spread(self.pins(net,{1:190,2:220}))

    def test_tiny_roundoff_and_valid_steep_anchor_range_are_accepted(self):
        net=structures.Net([way(1,[1,2],[[0,0],[20,0]])])
        with patch.object(structures,'spsolve',return_value=np.array([190-1e-7,200,220+1e-7])):
            net.spread(self.pins(net,{1:190,2:220}))
        self.assertLess(net.h[net.paths[0][1]],190)  # no clamp within numerical tolerance
        steep=structures.Net([way(1,[1,2],[[0,0],[10,0]])])
        steep.spread(self.pins(steep,{1:190,2:390}))
        np.testing.assert_allclose(steep.h,190+20*steep.xy[:,0])

    def test_validation_uses_each_components_range_not_the_global_range(self):
        net=structures.Net([way(1,[1,2],[[0,0],[20,0]]),way(2,[3,4],[[100,0],[120,0]])])
        with patch.object(structures,'spsolve',return_value=np.array([245,205,210,285,290,295])):
            with self.assertRaisesRegex(RuntimeError,r'component 0 returned 245.*outside fixed range \[190, 220\]'):
                net.spread(self.pins(net,{1:190,2:220,3:280,4:300}))

    def test_unknown_anchor_does_not_erase_nodes_with_two_nearer_finite_anchors(self):
        ways=[way(1,[1,10],[[-500,0],[0,0]]),way(2,[2,10],[[0,5],[0,0]]),way(3,[10,30],[[0,0],[400,0]])]
        net=structures.Net(ways);net.spread(self.pins(net,{1:np.nan,2:190,30:200}))
        self.assertTrue(np.isnan(net.h[net.key['n',1]]))
        self.assertTrue(np.isfinite(net.h[net.paths[2]]).all())
        for i in net.paths[2]:
            x=net.xy[i,0];self.assertAlmostEqual(net.h[i],(190*(400-x)+200*(x+5))/405)

    def test_tunnel_and_connected_bridge_use_one_legacy_component(self):
        ways=branch();ways[2]['kind']='tunnel';net=structures.Net(ways)
        net.spread(self.pins(net,{1:197.088,2:198.638,30:242.912}))
        # At the joint the two nearest anchors are the two short arms, as before.
        a,b=306.0065358779,306.7065209623
        expected=(197.088*b+198.638*a)/(a+b)
        self.assertAlmostEqual(net.h[net.key['n',10]],expected,7)
        self.assertLess(net.h[net.key['n',10]],200)

    def test_short_tunnel_between_preexisting_bridge_nodes_still_selects_legacy(self):
        ways=branch();ways.append(way(5,[10,11],[[0,0],[1,0]]))
        ways.append({'id':4,'nodes':[10,11],'pts':[[0,0],[1,0]],'kind':'tunnel','layer':-1})
        net=structures.Net(ways);self.assertNotIn('tunnel',net.kind)
        net.spread(self.pins(net,{1:197.088,2:198.638,30:242.912}))
        self.assertIn(int(net._components[net.key['n',10]]),net._legacy_components)

    def test_disconnected_tunnel_does_not_disable_complete_bridge_harmonics(self):
        bridge=branch();tunnel=way(9,[90,91],[[5000,0],[5100,0]]);tunnel['kind']='tunnel'
        a=structures.Net(bridge);a.spread(self.pins(a,{1:197.088,2:198.638,30:242.912}))
        b=structures.Net([tunnel,*bridge]);b.spread(self.pins(b,{90:190,91:200,1:197.088,2:198.638,30:242.912}))
        for wa,wb in zip(a.paths,b.paths[1:]):np.testing.assert_array_equal(a.h[wa],b.h[wb])

    def test_domain_selection_can_change_with_anchor_validity_without_stale_heights(self):
        net=structures.Net(branch());pins=self.pins(net,{1:197.088,2:198.638,30:242.912});net.spread(pins);good=net.h.copy()
        net.spread({**pins,net.key['n',1]:np.nan});self.assertTrue(np.isnan(net.h).any())
        net.spread(pins);np.testing.assert_array_equal(net.h,good)


if __name__=='__main__':unittest.main()
