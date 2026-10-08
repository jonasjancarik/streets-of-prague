"""Developer overlay data (src/iprdebug.ts, game opened with ?ipr): the technical map's marks
round Újezd, in the area's local metres.

    uv run ipr_debug.py praha
"""
import sys, json, requests, collections
sys.path.insert(0, '.')
import layers
from pyproj import Transformer
area = sys.argv[1] if len(sys.argv) > 1 else 'praha'
m = layers.read_meta(area)
tf = Transformer.from_crs("EPSG:4326", m["crs"], always_xy=True)
URL = "https://mp.iprpraha.cz/arcgis/rest/services/Hosted/DTMP_CUR_TMISZNAK_B/FeatureServer/0/query"
env = "14.4005,50.0785,14.4090,50.0840"
out, off = [], 0
while True:
    r = requests.get(URL, params={"where": "1=1", "geometry": env, "geometryType": "esriGeometryEnvelope", "inSR": 4326, "outSR": 4326,
        "outFields": "ctmtp_kod,ctmtp_popis", "f": "json", "resultOffset": off, "resultRecordCount": 2000, "orderByFields": "objectid"}, timeout=120).json()
    fs = r.get("features", [])
    out += fs; off += len(fs)
    if not fs or not r.get("exceededTransferLimit"): break
c = collections.Counter((f["attributes"]["ctmtp_kod"], f["attributes"]["ctmtp_popis"]) for f in out)
for k, v in c.most_common(): print(v, k)
codes = {}
pts = []
for f in out:
    a = f["attributes"]; g = f.get("geometry")
    if not g: continue
    x, y = tf.transform(g["x"], g["y"])
    pts.append([round(x, 1), round(y, 1), a["ctmtp_kod"]]); codes[a["ctmtp_kod"]] = a["ctmtp_popis"]
json.dump({"marks": pts, "codes": codes}, open(f"../public/data/{area}_now/ipr_debug.json", "w"))
print(len(pts))
