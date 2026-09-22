(function attachCityRegistry(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.CityRegistry = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function buildCityRegistry() {
  // One description per city this app covers, so that adding the second one is a second entry here
  // plus its own data rather than a search through public/app.js for the word "Denver". Everything
  // on a record is something the client used to hardcode: the rectangle the map is clamped to, the
  // published inventory it fetches, the boundary module that draws the city line, and the address
  // grid that turns a house number into a point.
  //
  // What is deliberately NOT here is the user-facing copy that names the sweeping authority. Those
  // strings are asserted as source text by test/not-maintained-ui.test.js, which exists to protect
  // the meaning of the pink and gray curb states -- "we found no schedule, use caution" and "not
  // city-maintained" are safety claims, not chrome. Templating them is its own careful pass with
  // that test updated deliberately, not something to fold into a structural move.
  //
  // This is a UMD module in the shape of public/curb-geometry.js and public/denver-city-limits.js:
  // a plain <script> tag loads it for the map and Node tests require it. There is no bundler.
  const DENVER = {
    id: "denver",
    name: "Denver",
    // Appended to a typed address before it goes out to a geocoder. Denver's own address lookup has
    // answered HTTP 400 since before 2026-08-22, so in practice the local matcher below carries the
    // search; this is still what the query is normalised with.
    geocodeSuffix: "Denver, CO",
    // The rectangle the map is clamped to, and the test for "is this point somewhere we cover".
    // It is the bounding box of the published inventory, not the city line -- the line itself is
    // the boundary module's job.
    bounds: {
      north: 39.8275,
      south: 39.6145,
      west: -105.1095,
      east: -104.5995
    },
    minZoom: 11,
    // The published inventory, about 12 MB. Its "?v=" is rewritten by
    // scripts/lib/asset-versions.js on every pipeline bump and has to keep agreeing with the copy
    // in public/index.html and public/sw.js; test/static-cache-version.test.js reads this literal.
    inventoryUrl: "./denver-west-routes.json?v=97",
    // The module holding this city's boundary rings, named rather than referenced because a plain
    // <script> tag is what loads it for the map. public/denver-city-limits.js assigns the global,
    // and requiring it in Node assigns the same one, so getCityLimits resolves in both.
    cityLimitsGlobal: "DenverCityLimits",
    // Denver numbers most of the city off named streets, not numbered ones: an
    // east-west avenue counts its hundreds by the north-south streets it crosses
    // (3509 W 23rd Ave sits between King, the 3500 block, and Lowell), and a south
    // street counts them by the named avenues below Ellsworth. The inventory has no
    // house numbers, so without this table those addresses could only match the
    // street, and the map centered on the middle of W 23rd Ave — about four blocks
    // from 3509.
    //
    // Derived 2026-09-18 from about 210,000 OpenStreetMap addresses in and around
    // Denver. Each address voted for the crossing just before it, toward lower
    // numbers; where the votes split, the value kept is the one that placed nearby
    // addresses closest to where OpenStreetMap has them, and an entry that placed
    // them no better than leaving it out was dropped. Keys are
    // normalizeSearchStreetText keys, values the hundred block the street opens on
    // that side of the grid. Every "w" and "e" key runs north-south and every "s"
    // and "n" key east-west: a stretch of Colorado Blvd once voted its way into "s"
    // as if it were an avenue, and dragged S Harrison addresses 2 km north.
    // Measured over 5,600 addresses inside the city line, a searched address lands
    // a median 40 m from its door, against 1.1 km before.
    addressGrid: {
      w: {
        "broadway": 0, "acoma": 1, "bannock": 1, "cherokee": 3, "delaware": 4, "elati": 5, "fox": 6,
        "galapago": 7, "inca": 8, "santa fe": 9, "kalamath": 10, "lipan": 11, "mariposa": 12, "navajo": 13,
        "pecos": 14, "raritan": 15, "quieto": 17, "quivas": 17, "shoshone": 18, "umatilla": 19, "tejon": 21,
        "vallejo": 22, "wyandot": 23, "yuma": 23, "zuni": 24, "alcott": 25, "bryant": 26, "clay": 27, "dale": 27,
        "decatur": 28, "eliot": 29, "federal": 30, "grove": 31, "hazel": 31, "hooker": 32, "irving": 33,
        "julian": 34, "julian way": 34, "knox": 34, "king": 35, "king way": 35, "linley": 36, "lowell": 36,
        "meade": 37, "newton": 38, "osceola": 39, "patton": 40, "perry": 40, "quitman": 41, "raleigh": 42,
        "stuart": 43, "tennyson": 44, "tennyson way": 44, "utica": 45, "vrain": 46, "winona": 47, "wolcott": 48,
        "wolff": 48, "xavier": 49, "yates": 50, "zenobia": 51, "zurich": 51, "sheridan": 52
      },
      wNorth: {
        "inca": 9, "jason": 11, "kalamath": 12, "lipan": 12, "mariposa": 14, "navajo": 15, "osage": 16,
        "pecos": 17, "quivas": 18, "shoshone": 19, "tejon": 20, "umatilla": 21, "fife": 25, "elm": 28, "java": 33,
        "stuart": 44, "sheridan": 53
      },
      e: {
        "broadway": 0, "lincoln": 1, "sherman": 2, "grant": 3, "logan": 4, "pennsylvania": 5, "pearl": 6,
        "washington": 7, "clarkson": 8, "emerson": 9, "ogden": 10, "corona": 11, "downing": 12, "lafayette": 13,
        "humboldt": 15, "franklin": 16, "gilpin": 17, "williams": 18, "high": 19, "race": 20, "vine": 21,
        "gaylord": 22, "university": 23, "york": 23, "josephine": 24, "columbine": 25, "elizabeth": 26,
        "clayton": 27, "detroit": 28, "fillmore": 29, "milwaukee": 30, "saint paul": 31, "steele": 32,
        "adams": 33, "biscayne": 33, "cook": 34, "madison": 35, "monroe": 36, "garfield": 37, "jackson": 38,
        "harrison": 39, "colorado": 40, "albion": 41, "ash": 42, "bellaire": 43, "birch": 44, "clermont": 45,
        "brook": 46, "cherry": 46, "dexter": 47, "dexter way": 47, "dahlia": 48, "elm": 50, "eudora": 51,
        "fairfax": 51, "forest": 52, "glencoe": 53, "grape": 54, "hudson": 55, "holly": 56, "ivanhoe": 57,
        "ivy": 58, "jersey": 59, "kearney": 60, "jasmine": 61, "jasmine way": 61, "krameria": 62, "leyden": 63,
        "locust": 64, "monaco pkwy": 65, "magnolia": 66, "niagara": 67, "newport": 68, "oneida": 69,
        "oneida way": 70, "pontiac": 71, "olive": 72, "poplar": 73, "poplar way": 73, "quince": 74, "quebec": 75,
        "rosemary": 76, "roslyn": 76, "reading way": 77, "sebring": 77, "syracuse": 77, "7550 hampden": 78,
        "spruce": 78, "spruce way": 79, "trenton": 79, "tamarac": 80, "ulster": 81, "uinta": 82,
        "tamarac pkwy": 83, "valentia": 83, "central park": 84, "vincennes": 84, "verbena": 85, "wabash": 85,
        "wilding": 86, "willow": 86, "xanthia": 87, "xenia": 88, "akron": 90, "yosemite": 90, "alton": 91,
        "beeler": 92, "boston": 92, "clinton": 96, "dayton way": 97, "dayton": 98, "emporia": 99, "elmira": 100,
        "florence": 100, "fulton": 101, "havana": 106, "kenton": 111
      },
      s: {
        "archer": 0, "ellsworth": 0, "bayaud": 1, "maple": 1, "byers": 2, "cedar": 2, "alameda": 3, "nevada": 3,
        "alaska": 4, "dakota": 4, "custer": 5, "virginia": 5, "center": 6, "gill": 6, "new york": 6,
        "exposition": 7, "walsh": 7, "ada": 8, "ohio": 8, "ohio way": 8, "kentucky": 9, "ford": 10,
        "tennessee": 10, "mississippi": 11, "alabama": 12, "arizona": 12, "missouri": 12, "mosier": 12,
        "louisiana": 13, "wyoming": 13, "arkansas": 14, "florida": 15, "gunnison": 16, "iowa": 16, "oregon": 16,
        "mexico": 17, "bails": 18, "montana": 18, "utah": 18, "atlantic": 19, "buchtel": 19, "jewell": 19,
        "asbury": 20, "evans": 21, "evans service": 21, "warren": 22, "iliff": 23, "dickenson": 24, "wesley": 24,
        "harvard": 25, "lasalle": 25, "lakeridge": 26, "vassar": 26, "linvale": 27, "yale": 27, "amherst": 28,
        "brown": 28, "yale way": 28, "bates": 29, "campus": 29, "columbia": 30, "cornell": 30, "plum": 30,
        "dartmouth": 31, "doane": 31, "eastman": 32, "eldorado": 32, "flora": 32, "floyd": 33, "floyd cir": 33,
        "girard": 34, "greenwood": 34, "hampden": 35, "ithaca": 36, "jarvis": 36, "jefferson": 36,
        "forest way": 37, "kenyon": 37, "lehigh": 38, "mansfield": 39, "napa": 40, "nassau": 40, "oxford": 41,
        "princeton": 42, "quincy": 43, "union": 47, "saratoga": 48, "chenango": 49, "monmouth": 50,
        "belleview": 52
      },
      n: {
        "bayaud": 0, "ellsworth": 0, "kearney lane": 0, "southmoor": 0, "colfax": 15, "montview": 20,
        "26 pkwy": 26, "martin luther king jr": 30, "martin luther king": 32, "bruce randolph": 34, "thrill": 34,
        "sandown": 41
      }
    },
    // West of Broadway the grid does not survive the Platte. South of the river
    // Kalamath opens the 1000 block and Inca the 800; north of it, on the same
    // streets, they open the 1200 and the 1000. Nothing is addressed on these
    // streets between 39.741 and 39.759 — downtown, the rail yards and the river —
    // so the line is drawn there. "wNorth" overrides "w" for a crossing north of it.
    westGridNorthLatitude: 39.75
  };

  const CITIES = [DENVER];
  const DEFAULT_CITY_ID = DENVER.id;

  // A registry of one still has an "active city", because that is the seam a picker or a
  // location-based choice plugs into later. Until there is a second city it never moves.
  let activeCityId = DEFAULT_CITY_ID;

  function listCities() {
    return CITIES.slice();
  }

  function getCity(id) {
    return CITIES.find((city) => city.id === id) || null;
  }

  function getActiveCity() {
    return getCity(activeCityId) || CITIES[0];
  }

  function setActiveCity(id) {
    const city = getCity(id);
    if (!city) {
      throw new Error(`Unknown city ${JSON.stringify(id)}`);
    }

    activeCityId = city.id;
    return city;
  }

  function isWithinCityBounds(city, lat, lon) {
    if (!city || !city.bounds) return false;

    return (
      lat <= city.bounds.north &&
      lat >= city.bounds.south &&
      lon >= city.bounds.west &&
      lon <= city.bounds.east
    );
  }

  // Which city a point falls in, for choosing from the phone's position rather than asking. Returns
  // null outside every city, which is the case a picker exists to answer.
  function getCityForPoint(lat, lon) {
    return CITIES.find((city) => isWithinCityBounds(city, lat, lon)) || null;
  }

  // The boundary module for a city, or null when its script has not loaded. The map degrades to
  // drawing no city line rather than failing, which is what loadCityBoundary already did.
  function getCityLimits(city) {
    if (!city || !city.cityLimitsGlobal) return null;
    const scope = typeof globalThis !== "undefined" ? globalThis : null;
    return (scope && scope[city.cityLimitsGlobal]) || null;
  }

  return {
    CITIES,
    DEFAULT_CITY_ID,
    listCities,
    getCity,
    getActiveCity,
    setActiveCity,
    isWithinCityBounds,
    getCityForPoint,
    getCityLimits
  };
});
