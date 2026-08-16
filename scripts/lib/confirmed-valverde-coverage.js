const CONFIRMED_VALVERDE_ROUTES = [
  {
    id: "confirmed-w-bayaud-platte-navajo",
    streetName: "W BAYAUD AVE",
    from: "S PLATTE RIVER DR/NMCHG",
    to: "S NAVAJO ST",
    sweepType: "Scheduled",
    leftSweepDirection: "South",
    rightSweepDirection: "North",
    leftSweepingRule: "South side: The 2nd Friday of the month.",
    rightSweepingRule: "North side: The 2nd Thursday of the month.",
    schedules: [
      { Date: "08/13/2026", Description: "North" },
      { Date: "08/14/2026", Description: "South" },
      { Date: "09/10/2026", Description: "North" },
      { Date: "09/11/2026", Description: "South" }
    ],
    isPosted: true,
    map: {
      staticMapUrl: "",
      center: [39.7148264, -105.0031145],
      path: [
        [39.7147399, -105.0023017],
        [39.7147598, -105.002331],
        [39.7147852, -105.0023768],
        [39.7148037, -105.002426],
        [39.7148198, -105.0025036],
        [39.7148243, -105.0025494],
        [39.714828, -105.002674],
        [39.7148265, -105.0030824],
        [39.7148264, -105.0031145],
        [39.7148268, -105.0037544],
        [39.7148269, -105.0038978]
      ]
    },
    sourceNote: "Schedule confirmed from Denver's Street Sweeping Schedules and Alerts result for S Platte River Dr/NMCHG to S Navajo St."
  },
  {
    id: "confirmed-s-navajo-bayaud-maple",
    streetName: "S NAVAJO ST",
    from: "W BAYAUD AVE",
    to: "W MAPLE AVE",
    sweepType: "Weekly",
    leftSweepDirection: "East",
    rightSweepDirection: "West",
    leftSweepingRule: "East side: The 2nd week of the month.",
    rightSweepingRule: "West side: The 2nd week of the month.",
    schedules: [],
    isPosted: false,
    map: {
      staticMapUrl: "",
      center: [39.7140152, -105.0038953],
      path: [
        [39.7148269, -105.0038978],
        [39.7147345, -105.0038975],
        [39.7140152, -105.0038953],
        [39.7139348, -105.003895]
      ]
    },
    sourceNote: "Schedule confirmed from Denver's Street Sweeping Schedules and Alerts result for W Bayaud Ave to W Maple Ave; relocation is not required during sweeping week."
  },
  {
    id: "confirmed-s-navajo-maple-cedar",
    streetName: "S NAVAJO ST",
    from: "W MAPLE AVE",
    to: "W CEDAR AVE",
    sweepType: "Weekly",
    leftSweepDirection: "East",
    rightSweepDirection: "West",
    leftSweepingRule: "East side: The 2nd week of the month.",
    rightSweepingRule: "West side: The 2nd week of the month.",
    schedules: [],
    isPosted: false,
    map: {
      staticMapUrl: "",
      center: [39.713499, -105.0038947],
      path: [
        [39.7139348, -105.003895],
        [39.713499, -105.0038947],
        [39.7130202, -105.0038944]
      ]
    },
    sourceNote: "Schedule confirmed from Denver's Street Sweeping Schedules and Alerts result for W Maple Ave to W Cedar Ave; relocation is not required during sweeping week."
  },
  {
    id: "confirmed-s-navajo-cedar-byers",
    streetName: "S NAVAJO ST",
    from: "W CEDAR AVE",
    to: "W BYERS PL/RRX",
    sweepType: "Weekly",
    leftSweepDirection: "East",
    rightSweepDirection: "West",
    leftSweepingRule: "East side: The 2nd week of the month.",
    rightSweepingRule: "West side: The 2nd week of the month.",
    schedules: [],
    isPosted: false,
    map: {
      staticMapUrl: "",
      center: [39.7125994, -105.0038988],
      path: [
        [39.7130202, -105.0038944],
        [39.7125994, -105.0038988],
        [39.7124279, -105.0039006],
        [39.7123208, -105.0039052],
        [39.7122356, -105.003916],
        [39.7122043, -105.0039229],
        [39.7121437, -105.0039362]
      ]
    },
    sourceNote: "Schedule confirmed from Denver's Street Sweeping Schedules and Alerts result for W Cedar Ave to W Byers Pl/RRX; relocation is not required during sweeping week."
  },
  {
    id: "confirmed-w-cedar-platte-lipan-navajo",
    streetName: "W CEDAR AVE",
    from: "S PLATTE RIVER DR/S LIPAN ST",
    to: "S NAVAJO ST",
    sweepType: "Scheduled",
    leftSweepDirection: "South",
    rightSweepDirection: "North",
    leftSweepingRule: "South side: The 2nd Friday of the month.",
    rightSweepingRule: "North side: The 2nd Thursday of the month.",
    schedules: [
      { Date: "08/13/2026", Description: "North" },
      { Date: "08/14/2026", Description: "South" },
      { Date: "09/10/2026", Description: "North" },
      { Date: "09/11/2026", Description: "South" }
    ],
    isPosted: true,
    map: {
      staticMapUrl: "",
      center: [39.7130205, -105.003227],
      path: [
        [39.7130204, -105.0015703],
        [39.7130211, -105.0016513],
        [39.713021, -105.0018122],
        [39.7130205, -105.003227],
        [39.7130203, -105.0036349],
        [39.7130202, -105.0038038],
        [39.7130202, -105.0038944]
      ]
    },
    sourceNote: "Schedule confirmed from Denver's Street Sweeping Schedules and Alerts result for S Platte River Dr/S Lipan St to S Navajo St."
  }
];

function addConfirmedValverdeCoverage(routeMap) {
  for (const route of CONFIRMED_VALVERDE_ROUTES) {
    if (!routeMap.has(route.id)) routeMap.set(route.id, route);
  }
}

module.exports = { CONFIRMED_VALVERDE_ROUTES, addConfirmedValverdeCoverage };
