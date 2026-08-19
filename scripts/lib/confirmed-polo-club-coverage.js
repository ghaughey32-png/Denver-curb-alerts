const NOT_MAINTAINED = "Street is not maintained by the City and County of Denver.";

function makeNotMaintainedRoute({ id, streetName, from, to, path, sourceNote }) {
  const horizontal = Math.abs(path.at(-1)[1] - path[0][1]) >= Math.abs(path.at(-1)[0] - path[0][0]);
  const left = horizontal ? "South" : "West";
  const right = horizontal ? "North" : "East";
  return {
    id,
    streetName,
    from,
    to,
    sweepType: "Private",
    leftSweepDirection: left,
    rightSweepDirection: right,
    leftSweepingRule: `${left} side: No schedules: ${NOT_MAINTAINED}`,
    rightSweepingRule: `${right} side: No schedules: ${NOT_MAINTAINED}`,
    schedules: [],
    isPosted: false,
    subscriptions: {},
    map: { staticMapUrl: "", center: path[Math.floor(path.length / 2)], path },
    sourceNote
  };
}

// Polo Club is a gated private community south of E Alameda Ave, straddling the
// alameda-e7-lincoln-colorado and dakota-louisiana-broadway-colorado pilot areas.
// Every way here is tagged access=private in OpenStreetMap and none of it appears
// in Denver's public street sweeping system, so these blocks are excluded from the
// expected-block manifest. Without an explicit route they would render as blank,
// unlabeled gaps on the map; publishing them as "Private" routes instead shows the
// same gray not-maintained treatment used elsewhere (see confirmed-regis-area-coverage.js)
// so residents see an explicit "no Denver sweeping" state rather than nothing at all.
const routes = [
  {
    id: "alameda-e7-lincoln-colorado-osm-16985218-176086460-5033357061-0",
    streetName: "Polo Club West",
    from: "EAST ALAMEDA AVENUE",
    to: "OSM node 5033357061",
    path: [[39.7111006, -104.9580936], [39.7110171, -104.9580937], [39.7108629, -104.9580953], [39.7108356, -104.9580902], [39.7108078, -104.9580758], [39.7107766, -104.9580497], [39.7107528, -104.9580195], [39.7107092, -104.9579501]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "alameda-e7-lincoln-colorado-osm-16985371-176086457-5033357030-0",
    streetName: "Polo Club Road",
    from: "EAST ALAMEDA AVENUE",
    to: "OSM node 5033357030",
    path: [[39.7111015, -104.9586687], [39.7110298, -104.9586688], [39.7109107, -104.9586702], [39.7107796, -104.9586715], [39.7107428, -104.9586696], [39.710709, -104.9586623], [39.7107, -104.95865824656488]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "alameda-e7-lincoln-colorado-osm-515369207-5033334678-176086464-0",
    streetName: "Polo Field Lane",
    from: "OSM node 5033334678",
    to: "EAST ALAMEDA AVENUE",
    path: [[39.7107, -104.9557998404092], [39.710898, -104.9558006], [39.7109179, -104.9558], [39.7109475, -104.955804], [39.7109712, -104.9558119], [39.7110251, -104.9558464]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "alameda-e7-lincoln-colorado-osm-515376360-176086464-5033334682-0",
    streetName: "Polo Field Lane",
    from: "EAST ALAMEDA AVENUE",
    to: "OSM node 5033334682",
    path: [[39.7110251, -104.9558464], [39.710974, -104.9558926], [39.7109491, -104.9559017], [39.7109207, -104.955907], [39.7107, -104.95590908020647]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "alameda-e7-lincoln-colorado-osm-515378254-5033357061-5033334699-0",
    streetName: "Polo Club West",
    from: "OSM node 5033357061",
    to: "OSM node 5033334699",
    path: [[39.7107092, -104.9579501], [39.7107, -104.95794097688024]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "alameda-e7-lincoln-colorado-osm-515378256-5033357061-5033357083-0",
    streetName: "Polo Club West",
    from: "OSM node 5033357061",
    to: "EAST ALAMEDA AVENUE",
    path: [[39.7107092, -104.9579501], [39.7107534, -104.9579707], [39.7107784, -104.9579782], [39.7107998, -104.9579824], [39.710834, -104.9579865], [39.7108626, -104.9579878], [39.7109775, -104.9579875], [39.7110118, -104.957987], [39.7110985, -104.9579873]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-16982774-176076139-176076140-0",
    streetName: "Polo Club Circle",
    from: "OSM node 176076139",
    to: "OSM node 176076140",
    path: [[39.7049423, -104.9520787], [39.7056188, -104.9518767], [39.7057021, -104.9518035], [39.705796, -104.9516835], [39.7059411, -104.9514082], [39.705992, -104.9513117], [39.706025, -104.9512075], [39.7060432, -104.9510854], [39.7060366, -104.9509877], [39.7060073, -104.9508873]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-16983749-176084203-176084204-0",
    streetName: "Polo Club Road South",
    from: "OSM node 176084203",
    to: "OSM node 176084204",
    path: [[39.70904, -104.9525705], [39.7092414, -104.9525605], [39.7092922, -104.9525594], [39.7093319, -104.9525601], [39.7093669, -104.9525625], [39.709408, -104.9525669], [39.7094865, -104.9525736], [39.7095393, -104.9525757], [39.709598, -104.9525763], [39.7096959, -104.9525745]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-16983751-176083137-176083162-0",
    streetName: "Polo Club Road South",
    from: "OSM node 176083137",
    to: "OSM node 176083162",
    path: [[39.7098, -104.9552806923913], [39.709761, -104.9552631], [39.7097077, -104.955232], [39.7096625, -104.9552029], [39.7096291, -104.9551741], [39.7095922, -104.9551372], [39.70942, -104.9549465], [39.7092694, -104.9547806], [39.7091813, -104.9546675], [39.7091414, -104.9546027], [39.709114, -104.9545354], [39.7090935, -104.9544557], [39.7090836, -104.954379], [39.7090807, -104.9542983], [39.709092, -104.9539866], [39.709096, -104.953842], [39.7090966, -104.9537333], [39.7090958, -104.9536627], [39.7090933, -104.9535504], [39.7090662, -104.9531131], [39.709046, -104.9528014], [39.7090409, -104.9526805], [39.70904, -104.9525705], [39.7090739, -104.9519629], [39.7090772, -104.9518771], [39.7090813, -104.9516441], [39.7090821, -104.9511979], [39.7090864, -104.9510996], [39.7090962, -104.9510164], [39.7091141, -104.9509386], [39.7091419, -104.9508634], [39.7091923, -104.9507652], [39.7092514, -104.9506988], [39.7093111, -104.9506443], [39.7093739, -104.9506023], [39.7094227, -104.9505803], [39.7094735, -104.950569], [39.7095237, -104.9505619], [39.7095818, -104.9505626], [39.7097177, -104.9505713]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-16983752-2874036080-2874036081-0",
    streetName: "Polo Club Road South",
    from: "OSM node 2874036080",
    to: "OSM node 2874036081",
    path: [[39.7094623, -104.9554838], [39.7096625, -104.9552029]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-16983754-176084229-176084215-0",
    streetName: "Polo Club Road South",
    from: "OSM node 176084229",
    to: "OSM node 176084215",
    path: [[39.7095762, -104.9515866], [39.7094943, -104.9516174], [39.7094613, -104.9516267], [39.7094394, -104.9516311], [39.7094007, -104.9516351], [39.7090813, -104.9516441]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-16983755-176084219-371278687-0",
    streetName: "Polo Club Road South",
    from: "OSM node 176084219",
    to: "SOUTH STEELE STREET",
    path: [[39.7091923, -104.9507652], [39.709083, -104.9506102], [39.7090627, -104.9505765], [39.7090406, -104.9505309], [39.7090302, -104.9505038], [39.7090232, -104.9504731], [39.709016, -104.9504085], [39.7090139, -104.9503585], [39.7090139, -104.950107], [39.7090128, -104.9500274]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-16983917-364366527-176085502-0",
    streetName: "Polo Club Lane",
    from: "SOUTH UNIVERSITY BOULEVARD",
    to: "OSM node 176085502",
    path: [[39.7073181, -104.9593405], [39.7073167, -104.9590126], [39.7073123, -104.958639], [39.7073059, -104.9581057], [39.7073604, -104.9575744], [39.7073901, -104.9573844], [39.7074192, -104.9571994], [39.7074217, -104.9571729], [39.7074637, -104.9567222], [39.707487, -104.9562375], [39.7074995, -104.9559259], [39.7075026, -104.9558581], [39.707512, -104.9557214], [39.7075233, -104.9556394], [39.7075384, -104.9555906], [39.7075696, -104.9555503], [39.7076664, -104.9554882]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-16985371-176086457-5033357030-0",
    streetName: "Polo Club Road",
    from: "OSM node 176086457",
    to: "OSM node 5033357030",
    path: [[39.7098, -104.9576135167894], [39.7096437, -104.957421], [39.7095687, -104.9573287], [39.7093019, -104.95701], [39.7089202, -104.9565509], [39.7084259, -104.9559791], [39.7080821, -104.9555509], [39.7080332, -104.9554779], [39.7080012, -104.9554292], [39.7079758, -104.955391], [39.7079695, -104.9553825], [39.7079202, -104.9553039], [39.707861, -104.9551863]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-16985446-1497882272-176096444-0",
    streetName: "Polo Field Lane",
    from: "OSM node 1497882272",
    to: "SOUTH STEELE STREET",
    path: [[39.7083361, -104.9510935], [39.7083289, -104.9509436], [39.7083171, -104.9507001], [39.7083115, -104.9505359], [39.7083113, -104.9502077], [39.7083112, -104.9501418], [39.7083111, -104.9500181]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-16986710-1497882319-176084234-0",
    streetName: "Hyde Park Circle",
    from: "OSM node 1497882319",
    to: "SOUTH STEELE STREET",
    path: [[39.70924, -104.9487408], [39.7092392, -104.9495192], [39.7092391, -104.9496724], [39.7092385, -104.9499084], [39.7092382, -104.9500303]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-16986713-1497882296-1497882319-0",
    streetName: "Hyde Park Circle",
    from: "OSM node 1497882296",
    to: "OSM node 1497882319",
    path: [[39.7091316, -104.9495201], [39.7092392, -104.9495192], [39.7098, -104.94951897269779]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-16986713-1497882296-1497882319-1",
    streetName: "Hyde Park Circle",
    from: "OSM node 1497882296",
    to: "OSM node 1497882319",
    path: [[39.7098, -104.94841040082954], [39.7097623, -104.948464], [39.7096234, -104.9486519], [39.7095978, -104.9486816], [39.7095628, -104.9487048], [39.7095027, -104.9487293], [39.7094721, -104.9487371], [39.7094446, -104.94874], [39.7093835, -104.9487427], [39.70924, -104.9487408]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-16988938-176107902-176086792-0",
    streetName: "Polo Club Drive",
    from: "SOUTH STEELE STREET",
    to: "EAST EXPOSITION AVENUE",
    path: [[39.7074886, -104.9499895], [39.7074864, -104.950148], [39.7074864, -104.9502131], [39.7074861, -104.9505187], [39.7074856, -104.9511959], [39.7074749, -104.9527957], [39.7074709, -104.9531666], [39.7074607, -104.953282], [39.7074229, -104.9533872], [39.7073794, -104.9534676], [39.7072783, -104.9535781], [39.7071941, -104.9536355], [39.7071056, -104.9536689], [39.7069964, -104.9536887], [39.7067907, -104.9536805], [39.7065987, -104.9536721], [39.7064684, -104.9536589], [39.7062951, -104.9536313], [39.7061636, -104.9535963], [39.7058227, -104.9534947], [39.7056842, -104.9534684], [39.705542, -104.9534583], [39.7054122, -104.9534601], [39.70518, -104.9534977], [39.7050855, -104.9535138], [39.7049583, -104.9535589], [39.704787, -104.9536438], [39.7047439, -104.953665], [39.7046846, -104.9537002], [39.7045422, -104.9537805], [39.7043543, -104.9538881], [39.7042619, -104.953931], [39.7041958, -104.9539654], [39.704077, -104.9539825], [39.7038447, -104.9540083]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-32970535-371279373-176083162-0",
    streetName: "Polo Club Road North",
    from: "OSM node 371279373",
    to: "OSM node 176083162",
    path: [[39.7098, -104.95057569069478], [39.7097177, -104.9505713]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-32970604-371280984-371281191-0",
    streetName: "Polo Club Circle",
    from: "OSM node 371280984",
    to: "OSM node 371281191",
    path: [[39.7050001, -104.9531843], [39.7049342, -104.9533216], [39.704888, -104.9534246], [39.704822, -104.9535534], [39.704787, -104.9536438]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-136548953-2873981417-1497882265-0",
    streetName: "Hyde Park Circle",
    from: "SOUTH STEELE STREET",
    to: "OSM node 1497882265",
    path: [[39.709128, -104.9500289], [39.70913, -104.9496764], [39.7091316, -104.9495201], [39.7091371, -104.94874]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-283553490-2874036079-2874036078-0",
    streetName: "Polo Club Road South",
    from: "OSM node 2874036079",
    to: "OSM node 2874036078",
    path: [[39.7091813, -104.9546675], [39.708974, -104.9549025]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-283553491-176084225-176084209-0",
    streetName: "Polo Club Road South",
    from: "OSM node 176084225",
    to: "OSM node 176084209",
    path: [[39.709405, -104.9535262], [39.7090933, -104.9535504]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-515369756-1497882272-5033279718-0",
    streetName: "Polo Field Lane",
    from: "OSM node 1497882272",
    to: "OSM node 5033279718",
    path: [[39.7083361, -104.9510935], [39.7083683, -104.9513072], [39.7083766, -104.9513944], [39.7083848, -104.9515151], [39.7083889, -104.9516344], [39.7083889, -104.9516894], [39.7083848, -104.9517444], [39.7083786, -104.9517977], [39.7083683, -104.951845], [39.7083495, -104.9519175]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-515369759-176096455-5033279718-0",
    streetName: "Polo Field Lane",
    from: "OSM node 176096455",
    to: "OSM node 5033279718",
    path: [[39.7096161, -104.9560212], [39.7095603, -104.9561142], [39.7095444, -104.9561324], [39.7095173, -104.9561581], [39.709501, -104.9561711], [39.7094852, -104.9561811], [39.70946, -104.9561935], [39.7094378, -104.9562013], [39.7094094, -104.956207], [39.7093921, -104.9562091], [39.7093618, -104.9562093], [39.7093422, -104.9562079], [39.7093153, -104.9562029], [39.7092969, -104.9561977], [39.709261, -104.9561818], [39.709246, -104.9561735], [39.7092248, -104.9561583], [39.70921, -104.9561457], [39.7091849, -104.9561212], [39.7091565, -104.9560901], [39.7088931, -104.9557613], [39.7087288, -104.9555803], [39.7085674, -104.9554127], [39.7085042, -104.9553385], [39.7084576, -104.9552663], [39.7084116, -104.9551768], [39.7083822, -104.9550885], [39.7083625, -104.9549969], [39.7083511, -104.9549024], [39.7083486, -104.954837], [39.7083487, -104.9547176], [39.7083632, -104.9542047], [39.7083774, -104.9538492], [39.7083779, -104.9536789], [39.7083743, -104.9535082], [39.7083399, -104.9530267], [39.7083303, -104.9528417], [39.7083268, -104.9526832], [39.7083495, -104.9519175]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-515369762-5033279718-1497882272-0",
    streetName: "Polo Field Lane",
    from: "OSM node 5033279718",
    to: "OSM node 1497882272",
    path: [[39.7083495, -104.9519175], [39.7083273, -104.9518216], [39.7083195, -104.9517786], [39.7083102, -104.9517057], [39.7083014, -104.9516142], [39.7082973, -104.9515206], [39.7082972, -104.9514427], [39.7083001, -104.9513825], [39.7083054, -104.9513195], [39.7083151, -104.9512377], [39.7083361, -104.9510935]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-515376361-5033334695-176096455-0",
    streetName: "Polo Field Lane",
    from: "OSM node 5033334695",
    to: "OSM node 176096455",
    path: [[39.7098, -104.95591607318435], [39.7097931, -104.9559166], [39.709758, -104.9559233], [39.709726, -104.955934], [39.7097023, -104.9559447], [39.7096769, -104.9559624], [39.7096161, -104.9560212]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-515376364-176096455-5033334678-0",
    streetName: "Polo Field Lane",
    from: "OSM node 176096455",
    to: "OSM node 5033334678",
    path: [[39.7096161, -104.9560212], [39.7097018, -104.9558781], [39.7097213, -104.9558502], [39.70973, -104.9558397], [39.7097414, -104.9558297], [39.7097536, -104.9558222], [39.7097761, -104.9558116], [39.7097994, -104.9558033], [39.7098, -104.95580319411765]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-515376365-5033334710-176103458-0",
    streetName: "Hyde Park Circle",
    from: "OSM node 5033334710",
    to: "OSM node 176103458",
    path: [[39.7098, -104.94850984832271], [39.7097623, -104.948464]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-515377530-176076140-176076139-0",
    streetName: "Polo Club Circle",
    from: "OSM node 176076140",
    to: "OSM node 176076139",
    path: [[39.7060073, -104.9508873], [39.7058971, -104.9507583], [39.7058124, -104.9507296], [39.7056738, -104.9507296], [39.7050711, -104.9507403], [39.7049902, -104.950762], [39.7049294, -104.9508173], [39.7048803, -104.9508839], [39.7048556, -104.9509892], [39.704855, -104.9511845], [39.7048617, -104.9514519], [39.704912, -104.9518568], [39.7049423, -104.9520787]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-515377532-1497882319-1497882296-0",
    streetName: "Hyde Park Circle",
    from: "OSM node 1497882319",
    to: "OSM node 1497882296",
    path: [[39.70924, -104.9487408], [39.7091371, -104.94874], [39.7079035, -104.9487357], [39.7078657, -104.9487388], [39.7078375, -104.9487463], [39.7078167, -104.94876], [39.7077992, -104.9487783], [39.7077888, -104.9488019], [39.7077801, -104.9488369], [39.707776, -104.9488837], [39.7077741, -104.9489589], [39.7077749, -104.9493492], [39.7077774, -104.9493944], [39.7077835, -104.9494351], [39.7077953, -104.9494662], [39.7078081, -104.9494876], [39.7078239, -104.9494998], [39.707847, -104.9495091], [39.70787, -104.9495141], [39.7078975, -104.9495167], [39.7086912, -104.9495167], [39.7091316, -104.9495201]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-515377533-176076139-371280986-0",
    streetName: "Polo Club Circle",
    from: "OSM node 176076139",
    to: "OSM node 371280986",
    path: [[39.7049423, -104.9520787], [39.7050233, -104.9528079], [39.7050001, -104.9531843], [39.7050993, -104.9533903], [39.70518, -104.9534977]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-515378258-5033357030-176085502-0",
    streetName: "Polo Club Road",
    from: "OSM node 5033357030",
    to: "OSM node 176085502",
    path: [[39.707861, -104.9551863], [39.70783, -104.9552421], [39.7078093, -104.9552998], [39.7077913, -104.955366], [39.7077764, -104.9554008], [39.7077514, -104.9554354], [39.7076664, -104.9554882]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  },
  {
    id: "dakota-louisiana-broadway-colorado-osm-890741831-5033313397-8278448058-0",
    streetName: "Polo Club Road",
    from: "OSM node 5033313397",
    to: "OSM node 8278448058",
    path: [[39.7094094, -104.956207], [39.7094314, -104.9567131], [39.7094633, -104.9567814], [39.7095669, -104.9568643]],
    sourceNote: "Polo Club is a private, gated community; OpenStreetMap tags these ways access=private and Denver has no sweeping schedule for them."
  }];

function applyConfirmedPoloClubCoverage(routeMap) {
  routes.forEach((definition) => routeMap.set(definition.id, makeNotMaintainedRoute(definition)));
}

module.exports = { applyConfirmedPoloClubCoverage };
