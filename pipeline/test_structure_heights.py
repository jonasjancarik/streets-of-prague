"""Pinned graph heights must stay continuous instead of changing nearest-anchor pairs."""
import copy
import unittest

import numpy as np
import structures


def way(ident, nodes, points, layer=2):
    return {'id':ident,'nodes':nodes,'pts':points,'kind':'bridge','layer':layer}


def branch():
    return [way(1,[1,10],[[-306,-2],[0,0]]),way(2,[2,10],[[-306.7,2],[0,0]]),
            way(3,[10,30],[[0,0],[1305,0]])]


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


if __name__=='__main__':unittest.main()
