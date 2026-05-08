# Demo Data

- `demo_prefecture_routes.json`: UI development data hand-authored for this project. It is not copied from NAVITIME API responses.
- `prefectures-lite.geojson`: simplified prefecture polygons derived from `piuccio/open-data-jp-prefectures-geojson`, MIT License. The upstream data is based on National Land Information Division administrative-area data.
- `railway-background.geojson`: detailed background railway geometries from OpenStreetMap contributors via Overpass API, ODbL. It covers Shinkansen and the commuter rail routes used to reach nearby prefectural offices. This is a background rail-network layer; live mode should still draw selected route geometry from the transit shape response.
