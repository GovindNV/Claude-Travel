/* Wayline — door-to-door trip planner.
   With a Google Maps key: Google place search, road times and transit (real train and bus departures).
   With a flight-search key: real flights and fares. Without keys: OpenStreetMap + estimates. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const PHOTON = "https://photon.komoot.io";
  const OSRM = "https://router.project-osrm.org";
  const STORE = "wayline:last", KEYS = "wayline:keys";

  let keys = { google: "", flights: "", rail: "" };
  try { Object.assign(keys, JSON.parse(localStorage.getItem(KEYS)) || {}); } catch { /* none saved */ }
  const problems = new Set(); // messages about live sources that failed, shown with results

  /* ---------- helpers ---------- */

  const rad = (d) => (d * Math.PI) / 180;
  function hav(a, b) {
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(h));
  }
  const round5 = (m) => Math.max(5, Math.round(m / 5) * 5);
  const round10 = (n) => Math.round(n / 10) * 10;
  const inr = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
  const km = (n) => (n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString("en-IN")) + " km";
  function dur(m) {
    m = Math.max(0, Math.round(m));
    const h = Math.floor(m / 60), r = m % 60;
    if (!h) return `${r} min`;
    return r ? `${h} h ${r} min` : `${h} h`;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clock = (d) => d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true }).toUpperCase();
  const dayLabel = (d) => d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
  const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const addMin = (d, m) => new Date(d.getTime() + m * 60000);
  const minsBetween = (a, b) => Math.round((b - a) / 60000);
  const slug = (s) => s.toLowerCase().replace(/\(.*?\)/g, "").trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const secs = (s) => parseInt(s || "0", 10) || 0; // "1234s" → 1234
  const pkey = (p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;

  async function getJSON(url, opts = {}, ms = 12000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* not JSON */ }
      if (!r.ok) {
        const e = new Error((data && (data.error?.message || data.error)) || `HTTP ${r.status}`);
        e.status = r.status;
        throw e;
      }
      if (data === null) throw new Error("Unexpected response");
      return data;
    } finally {
      clearTimeout(t);
    }
  }

  /* ---------- Google Maps Platform (Places API (New) + Routes API) ---------- */

  const google = {
    on: () => !!keys.google,
    call(url, body, mask, method = "POST") {
      const headers = { "X-Goog-Api-Key": keys.google };
      if (mask) headers["X-Goog-FieldMask"] = mask;
      if (body) headers["Content-Type"] = "application/json";
      return getJSON(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    },
    failed(what, err) {
      problems.add(`Google Maps ${what} failed (${err.message}). Using free map data instead — check the key in Settings.`);
    },
  };
  const wp = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lon } } });
  const countryOf = (components) => {
    const c = (components || []).find((x) => (x.types || []).includes("country"));
    return c ? c.shortText : "";
  };
  let session = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);

  async function googleSuggest(q, intl) {
    const body = { input: q, languageCode: "en", sessionToken: session };
    if (!intl) body.includedRegionCodes = ["in"];
    const data = await google.call("https://places.googleapis.com/v1/places:autocomplete", body);
    return (data.suggestions || []).filter((s) => s.placePrediction).map(({ placePrediction: p }) => ({
      name: p.structuredFormat?.mainText?.text || p.text?.text || q,
      sub: p.structuredFormat?.secondaryText?.text || "",
      placeId: p.placeId,
    }));
  }
  async function googleDetails(place) {
    const d = await google.call(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(place.placeId)}?sessionToken=${session}`,
      null, "location,addressComponents", "GET");
    session = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
    return { ...place, lat: d.location.latitude, lon: d.location.longitude, cc: countryOf(d.addressComponents) };
  }
  async function googleSearch(q, intl) {
    const body = { textQuery: q, languageCode: "en", pageSize: 1 };
    if (!intl) body.regionCode = "in";
    const data = await google.call("https://places.googleapis.com/v1/places:searchText", body,
      "places.displayName,places.formattedAddress,places.location,places.addressComponents");
    const p = (data.places || [])[0];
    return p && { name: p.displayName?.text || q, sub: p.formattedAddress || "", lat: p.location.latitude, lon: p.location.longitude, cc: countryOf(p.addressComponents) };
  }

  /* ---------- place search ---------- */

  const selected = { from: null, to: null };
  const isIntl = () => $("intl").checked;

  function localMatches(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const starts = [], contains = [];
    for (const p of PLACES) {
      const n = p.name.toLowerCase();
      if (n.startsWith(q)) starts.push(p);
      else if (n.includes(q)) contains.push(p);
    }
    return [...starts, ...contains].slice(0, 5);
  }

  function photonPlace(f) {
    const p = f.properties || {};
    const [lon, lat] = f.geometry.coordinates;
    const name = p.name || p.city || p.county;
    if (!name) return null;
    const sub = [p.city, p.county, p.state, p.country].filter((x, i, a) => x && x !== name && a.indexOf(x) === i).slice(0, 2).join(", ");
    return { name, sub, lat, lon, cc: (p.countrycode || "").toUpperCase() };
  }
  async function photonSuggest(q, intl, limit = 6) {
    const data = await getJSON(`${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=${limit}&lang=en${intl ? "" : "&bbox=68,6,97.5,37.5"}`, {}, 6000);
    return (data.features || []).map(photonPlace).filter((p) => p && (intl || !p.cc || p.cc === "IN"));
  }

  function setupAutocomplete(key) {
    const input = $(key), list = $(key + "-list");
    let items = [], active = -1, seq = 0, timer;

    const close = () => { list.hidden = true; active = -1; };
    const draw = () => {
      if (!items.length) return close();
      list.innerHTML = items
        .map((p, i) => `<li role="option" data-i="${i}" class="${i === active ? "on" : ""}"><span>${esc(p.name)}</span><small>${esc(p.sub || "")}</small></li>`)
        .join("");
      list.hidden = false;
    };
    const pick = (i) => {
      const p = items[i];
      if (!p) return;
      selected[key] = p;
      input.value = p.name;
      close();
    };

    input.addEventListener("input", () => {
      selected[key] = null;
      const q = input.value.trim();
      const mine = ++seq;
      clearTimeout(timer);
      // With Google connected, its suggestions are the list; the built-in list only fills the gap while typing.
      items = localMatches(q);
      active = -1;
      draw();
      if (q.length < 3) return;
      timer = setTimeout(async () => {
        let remote = null;
        if (google.on()) {
          try { remote = await googleSuggest(q, isIntl()); } catch (e) { google.failed("place search", e); }
        }
        if (!remote) {
          try {
            const found = await photonSuggest(q, isIntl());
            remote = [...localMatches(q)];
            for (const r of found) if (!remote.some((p) => p.name.toLowerCase() === r.name.toLowerCase() && hav(p, r) < 25)) remote.push(r);
          } catch { return; /* offline: built-in suggestions only */ }
        }
        if (mine !== seq || document.activeElement !== input) return;
        items = remote.slice(0, 7);
        draw();
      }, 280);
    });
    input.addEventListener("keydown", (e) => {
      if (list.hidden) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        draw();
      } else if (e.key === "Enter" && items.length) {
        e.preventDefault();
        pick(active < 0 ? 0 : active);
      } else if (e.key === "Escape") close();
    });
    input.addEventListener("blur", () => setTimeout(close, 120));
    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li");
      if (li) { e.preventDefault(); pick(+li.dataset.i); }
    });
  }

  async function resolvePlace(key) {
    const s = selected[key];
    if (s && s.lat != null) return s;
    if (s && s.placeId) return (selected[key] = await googleDetails(s));
    const q = $(key).value.trim();
    if (!q) return null;
    if (google.on()) {
      try {
        const p = await googleSearch(q, isIntl());
        if (p) return (selected[key] = p);
      } catch (e) { google.failed("place search", e); }
    }
    const exact = PLACES.find((p) => p.name.toLowerCase() === q.toLowerCase());
    if (exact) return (selected[key] = exact);
    try {
      const [first] = await photonSuggest(q, isIntl(), 1);
      if (first) return (selected[key] = first);
    } catch { /* fall through */ }
    const [guess] = localMatches(q);
    return guess ? (selected[key] = guess) : null;
  }

  /* ---------- road data ---------- */

  // pairs: [[a, b], ...] → { source, get(a, b) → { km, min } | null }
  async function roadPairs(pairs) {
    const uniq = (list) => [...new Map(list.map((p) => [pkey(p), p])).values()];
    const A = uniq(pairs.map((p) => p[0])), B = uniq(pairs.map((p) => p[1]));
    const table = new Map();
    const out = (source) => ({ source, get: (a, b) => table.get(pkey(a) + ">" + pkey(b)) });
    const put = (a, b, v) => table.set(pkey(a) + ">" + pkey(b), v);

    if (google.on()) {
      try {
        const rows = await google.call("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix",
          { origins: A.map((p) => ({ waypoint: wp(p) })), destinations: B.map((p) => ({ waypoint: wp(p) })), travelMode: "DRIVE" },
          "originIndex,destinationIndex,duration,distanceMeters,condition");
        for (const a of A) for (const b of B) put(a, b, null);
        for (const r of rows) {
          if (r.condition === "ROUTE_EXISTS") put(A[r.originIndex || 0], B[r.destinationIndex || 0], { km: (r.distanceMeters || 0) / 1000, min: secs(r.duration) / 60 });
        }
        return out("google");
      } catch (e) { google.failed("road times", e); }
    }
    try {
      const coords = [...A, ...B].map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(";");
      const src = A.map((_, i) => i).join(";"), dst = B.map((_, i) => i + A.length).join(";");
      const data = await getJSON(`${OSRM}/table/v1/driving/${coords}?annotations=duration,distance&sources=${src}&destinations=${dst}`, {}, 9000);
      if (data.code !== "Ok") throw new Error(data.code);
      A.forEach((a, i) => B.forEach((b, j) => {
        const s = data.durations[i][j], m = data.distances[i][j];
        put(a, b, s == null || m == null ? null : { km: m / 1000, min: (s / 60) * 1.15 });
      }));
      return out("osm");
    } catch { /* fall through to straight-line estimates */ }
    for (const a of A) for (const b of B) {
      const d = hav(a, b) * 1.3;
      put(a, b, { km: d, min: (d / 48) * 60 });
    }
    return out("");
  }

  /* ---------- Google transit: real train and bus departures ---------- */

  const RAIL = new Set(["HEAVY_RAIL", "LONG_DISTANCE_TRAIN", "HIGH_SPEED_TRAIN", "RAIL", "COMMUTER_TRAIN"]);
  const BUS = new Set(["BUS", "INTERCITY_BUS", "TROLLEYBUS", "SHARE_TAXI"]);
  const TRANSIT_MASK = "routes.duration,routes.distanceMeters,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.distanceMeters,routes.legs.steps.transitDetails";

  async function transitRoutes(a, b, when, modes) {
    const data = await google.call("https://routes.googleapis.com/directions/v2:computeRoutes", {
      origin: wp(a), destination: wp(b), travelMode: "TRANSIT", computeAlternativeRoutes: true, languageCode: "en",
      transitPreferences: { allowedTravelModes: modes }, ...when,
    }, TRANSIT_MASK);
    return (data.routes || []).map((r) => (r.legs || []).flatMap((l) => l.steps || []).map((s) => {
      const d = s.transitDetails, step = { mode: s.travelMode, secs: secs(s.staticDuration), km: (s.distanceMeters || 0) / 1000 };
      if (!d) return step;
      const stop = (x) => ({ name: x?.name || "", lat: x?.location?.latLng?.latitude, lon: x?.location?.latLng?.longitude });
      const line = d.transitLine || {};
      step.t = {
        from: stop(d.stopDetails?.departureStop), to: stop(d.stopDetails?.arrivalStop),
        dep: new Date(d.stopDetails?.departureTime), arr: new Date(d.stopDetails?.arrivalTime),
        name: line.name || line.nameShort || line.vehicle?.name?.text || "Service",
        number: d.tripShortText || (line.name ? line.nameShort || "" : ""),
        vehicle: line.vehicle?.type || "", headsign: d.headsign || "", stops: d.stopCount || 0,
        agency: line.agencies?.[0]?.name || "",
      };
      return step;
    })).filter((steps) => steps.some((s) => s.t && !isNaN(s.t.dep)));
  }

  // Split a transit route into: steps before the main ride, the main ride(s), steps after.
  function spanOf(steps, kinds, minKm) {
    const idx = steps.map((s, i) => (s.t && kinds.has(s.t.vehicle) && s.km >= minKm ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return null;
    const first = idx[0], last = idx[idx.length - 1];
    return {
      pre: steps.slice(0, first), rides: steps.slice(first, last + 1), post: steps.slice(last + 1),
      board: steps[first].t, alight: steps[last].t,
      km: steps.slice(first, last + 1).reduce((s, x) => s + (x.t ? x.km : 0), 0),
    };
  }

  // Collect distinct train departures around the requested time by paging the transit search.
  async function trainSpans(from, to, T, prefs) {
    const found = new Map();
    const add = (routes) => {
      let n = 0;
      for (const steps of routes) {
        const sp = spanOf(steps, RAIL, 20);
        if (!sp) continue;
        const k = `${sp.board.dep.getTime()}|${sp.board.from.name}|${sp.alight.arr.getTime()}`;
        if (!found.has(k)) { found.set(k, sp); n++; }
      }
      return n;
    };
    const modes = ["TRAIN"];
    const back = prefs.timing === "arrive";
    add(await transitRoutes(from, to, back ? { arrivalTime: T.deadline.toISOString() } : { departureTime: T.leave.toISOString() }, modes));
    for (let page = 0; page < (prefs.timing === "flex" ? 3 : 2) && found.size; page++) {
      const all = [...found.values()];
      let routes;
      if (back) {
        const edge = all.reduce((a, b) => (b.alight.arr < a.alight.arr ? b : a));
        if (edge.alight.to.lat == null) break;
        routes = await transitRoutes(from, edge.alight.to, { arrivalTime: addMin(edge.alight.arr, -1).toISOString() }, modes);
      } else {
        const edge = all.reduce((a, b) => (b.board.dep > a.board.dep ? b : a));
        if (edge.board.from.lat == null) break;
        routes = await transitRoutes(edge.board.from, to, { departureTime: addMin(edge.board.dep, 1).toISOString() }, modes);
      }
      if (!add(routes)) break;
    }
    return [...found.values()].sort((a, b) => a.board.dep - b.board.dep);
  }

  /* ---------- live flights (SerpApi Google Flights, via /api/flights or directly) ---------- */

  async function liveFlights(a, b, date) {
    const ck = `wayline:fl:${a}:${b}:${date}`;
    try { const c = JSON.parse(sessionStorage.getItem(ck)); if (c) return c; } catch { /* no cache */ }
    let data = null, err = null;
    try {
      data = await getJSON(`api/flights?from=${a}&to=${b}&date=${date}`, { headers: keys.flights ? { "x-serpapi-key": keys.flights } : {} }, 30000);
    } catch (e) { if (e.status && e.status !== 404 && e.status !== 405 && e.status !== 501) err = e; }
    if (!data && keys.flights) {
      try {
        data = await getJSON(`https://serpapi.com/search.json?engine=google_flights&type=2&currency=INR&hl=en&gl=in&departure_id=${a}&arrival_id=${b}&outbound_date=${date}&api_key=${encodeURIComponent(keys.flights)}`, {}, 30000);
        err = null;
      } catch (e) { err = err || e; }
    }
    if (!data) {
      if (err || keys.flights) problems.add(`Live flight search failed (${err ? err.message : "blocked by the browser"}). Showing estimated flights — see README for the flight proxy.`);
      return null;
    }
    const list = [...(data.best_flights || []), ...(data.other_flights || [])].filter((f) => f.flights && f.flights.length);
    try { sessionStorage.setItem(ck, JSON.stringify(list)); } catch { /* full */ }
    return list;
  }

  /* ---------- Indian Railways timetable (irctc.dev, via /api/trains or directly) ---------- */

  let railOff = false; // set when no rail source is reachable, to avoid repeating failed calls
  const titleCase = (t) => String(t).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bExp\b/, "Express").replace(/\bSf\b/, "SF");

  // Trains between two station codes on a date. Returns null if no rail source is available.
  async function railTrains(from, to, date) {
    if (railOff) return null;
    const ck = `wayline:rl:${from}:${to}:${date}`;
    try { const c = JSON.parse(sessionStorage.getItem(ck)); if (c) return c; } catch { /* no cache */ }
    let data = null, err = null;
    try {
      data = await getJSON(`api/trains?from=${from}&to=${to}&date=${date}`, { headers: keys.rail ? { "x-rail-key": keys.rail } : {} }, 20000);
    } catch (e) { if (e.status && ![404, 405, 501].includes(e.status)) err = e; }
    if (!data && !err && keys.rail) {
      try {
        data = await getJSON(`https://api.irctc.dev/api/v1/trains/search?from=${from}&to=${to}&date=${date}`, { headers: { "x-api-key": keys.rail } }, 20000);
      } catch (e) { err = e; }
    }
    if (!data) {
      railOff = true;
      if (err || keys.rail) problems.add(`Train timetable lookup failed (${err ? err.message : "not reachable"}). Showing estimated trains — check the rail key in Data sources.`);
      return null;
    }
    const list = (Array.isArray(data) ? data : data.data || []).filter((t) => t && t.departure && t.durationMin);
    try { sessionStorage.setItem(ck, JSON.stringify(list)); } catch { /* full */ }
    return list;
  }

  // Search every candidate station pair on every relevant date.
  async function railSearchAll(oStns, dStns, dates) {
    const jobs = [];
    for (const date of dates) for (const o of oStns) for (const d of dStns) if (o.code !== d.code) jobs.push({ o, d, date });
    if (!jobs.length) return null;
    const first = await railTrains(jobs[0].o.code, jobs[0].d.code, jobs[0].date);
    if (first === null) return null;
    const rest = await Promise.all(jobs.slice(1).map((j) => railTrains(j.o.code, j.d.code, j.date)));
    return jobs.map((j, i) => ({ ...j, trains: (i ? rest[i - 1] : first) || [] }));
  }

  // Stations worth searching: the nearest one, plus up to two more that are not much farther away.
  function nearbyStations(list, p) {
    const d0 = hav(p, list[0]);
    return list.filter((s) => hav(p, s) <= d0 + 25);
  }

  /* ---------- traffic-aware cab times (Google Routes) ---------- */

  const trafficCache = new Map();
  async function trafficMin(a, b, at) {
    if (!google.on() || at < addMin(new Date(), 5)) return null;
    const k = `${pkey(a)}>${pkey(b)}@${Math.round(at / 9e5)}`; // 15-minute buckets
    if (!trafficCache.has(k)) {
      trafficCache.set(k, google.call("https://routes.googleapis.com/directions/v2:computeRoutes",
        { origin: wp(a), destination: wp(b), travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE", departureTime: at.toISOString() },
        "routes.duration").then((d) => Math.ceil(secs(d.routes?.[0]?.duration) / 60) || null).catch(() => null));
    }
    return trafficCache.get(k);
  }

  // Re-time the cab hops of one departure using predicted traffic at the hour they happen.
  async function refine(v) {
    if (v.refined || !v.anchor) return;
    v.refined = true;
    const first = v.legs[0], lastLeg = v.legs[v.legs.length - 1];
    if (first.road) {
      const at = addMin(v.anchor, -(v.preBuf + first.mins));
      const m = await trafficMin(first.road.a, first.road.b, at);
      if (m) { first.mins = m; first.detail += ` · with traffic at ${clock(at)}`; }
    }
    v.start = addMin(v.anchor, -(v.preBuf + first.mins));
    if (lastLeg.road && lastLeg !== first) {
      const at = addMin(v.start, sumMins(v.legs.slice(0, -1)));
      const m = await trafficMin(lastLeg.road.a, lastLeg.road.b, at);
      if (m) { lastLeg.mins = m; lastLeg.detail += ` · with traffic at ${clock(at)}`; }
    }
    v.total = sumMins(v.legs);
    v.end = addMin(v.start, v.total);
  }

  /* ---------- planning ---------- */

  function nearestN(list, p, n, penalty = () => 0) {
    return list.map((x) => [hav(p, x) + penalty(x), x]).sort((a, b) => a[0] - b[0]).slice(0, n).map((x) => x[1]);
  }

  const mapsUrl = (a, b, mode) =>
    `https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lon}&destination=${b.lat},${b.lon}&travelmode=${mode}`;

  // A short hop between a door and a hub, by the user's preferred local mode.
  function transfer(seg, pref, a, b, label) {
    if (!seg) return { type: "transfer", title: `Transfer ${label}`, mins: 30, cost: 0, detail: "No road data for this hop — allow extra time" };
    if (seg.km < 0.8) return { type: "transfer", title: `Walk ${label}`, mins: 10, cost: 0, detail: km(seg.km) };
    const cab = { mins: round5(seg.min * 1.05), cost: round10(80 + 17 * seg.km) };
    const bus = { mins: round5(seg.min * 1.5 + 12), cost: round10(15 + 1.3 * seg.km) };
    const mine = pref === "bus" ? bus : cab, other = pref === "bus" ? cab : bus;
    return {
      type: "transfer",
      title: `${pref === "bus" ? "Local bus" : "Cab"} ${label}`,
      mins: mine.mins,
      cost: mine.cost,
      detail: `${km(seg.km)} · about ${inr(mine.cost)}`,
      alt: `${pref === "bus" ? "By cab" : "By local bus"}: ${dur(other.mins)} · about ${inr(other.cost)}`,
      url: mapsUrl(a, b, pref === "bus" ? "transit" : "driving"),
      road: pref === "bus" ? null : { a, b }, // cab hops can be re-timed with traffic
    };
  }

  // Same hop, but using the walking / local-transit steps Google returned when the user prefers public transport.
  function transitHop(steps, seg, pref, a, b, label) {
    const total = steps.reduce((s, x) => s + x.secs, 0) / 60;
    const rides = steps.filter((s) => s.t);
    const walkOnly = !rides.length;
    if (seg && (pref === "cab" || (walkOnly && total > 30))) return transfer(seg, "cab", a, b, label);
    if (total < 2) return { type: "transfer", title: `Walk ${label}`, mins: 5, cost: 0 };
    const dist = steps.reduce((s, x) => s + x.km, 0);
    return {
      type: "transfer",
      title: `${walkOnly ? "Walk" : "Local transit"} ${label}`,
      mins: Math.round(total) + (walkOnly ? 0 : 8),
      cost: walkOnly ? 0 : round10(15 + 1.3 * dist),
      detail: walkOnly ? km(dist) : `${rides.map((r) => r.t.name).join(" + ")} · ${km(dist)}`,
      alt: seg ? `By cab: ${dur(round5(seg.min * 1.05))} · about ${inr(round10(80 + 17 * seg.km))}` : "",
      url: mapsUrl(a, b, "transit"),
    };
  }

  // Turn rides (with real departure/arrival times) into timeline legs, inserting waits for the gaps.
  function rideLegs(rides) {
    const legs = [];
    let prev = null;
    for (const s of rides) {
      if (!s.t) continue;
      if (prev) legs.push({ type: "wait", title: `Change at ${prev.to.name || s.t.from.name}`, mins: Math.max(0, minsBetween(prev.arr, s.t.dep)) });
      legs.push({
        type: "main",
        title: [s.t.name, s.t.number].filter(Boolean).join(" · "),
        mins: minsBetween(s.t.dep, s.t.arr),
        detail: `${s.t.from.name} ${clock(s.t.dep)} → ${s.t.to.name} ${clock(s.t.arr)}${s.t.stops ? ` · ${s.t.stops} stops` : ""}`,
        alt: s.t.agency,
      });
      prev = s.t;
    }
    return legs;
  }
  const sumMins = (legs) => legs.reduce((s, l) => s + l.mins, 0);
  const sumCost = (legs) => legs.reduce((s, l) => s + (l.cost || 0), 0);

  const flightMin = (d) => round5(35 + (d / 800) * 60);

  async function plan(from, to, prefs) {
    const at = (hhmm) => new Date(`${prefs.date}T${hhmm}:00`);
    const T = {
      leave: prefs.timing === "flex" ? at("05:00") : at(prefs.time),
      deadline: addMin(at(prefs.time), -prefs.cushion),
    };
    const india = from.cc === "IN" && to.cc === "IN";
    const abroad = !india;
    const options = [], skipped = [];

    const [oAir] = nearestN(AIRPORTS, from, 1, (a) => (a.hub ? 0 : 40));
    const [dAir] = nearestN(AIRPORTS, to, 1, (a) => (a.hub ? 0 : 40));
    const air = hav(oAir, dAir);
    const flyable = oAir.code !== dAir.code && air >= 150;
    const oStns = india ? nearestN(STATIONS, from, 3) : [], dStns = india ? nearestN(STATIONS, to, 3) : [];

    const oNear = india ? nearbyStations(oStns, from) : [], dNear = india ? nearbyStations(dStns, to) : [];
    const day = (n) => isoDate(addMin(at("12:00"), n * 1440));
    const railDates = prefs.timing === "arrive" ? [day(-1), day(0)] : prefs.timing === "leave" && prefs.time >= "18:00" ? [day(0), day(1)] : [day(0)];
    const pairs = [[from, to], [from, oAir], [dAir, to], ...oStns.map((s) => [from, s]), ...dStns.map((s) => [s, to])];
    const quiet = (p, what) => p.catch((e) => { google.failed(what, e); return null; });
    const [rail, road, trains, busRoutes, flights] = await Promise.all([
      india ? railSearchAll(oNear, dNear, railDates) : null,
      roadPairs(pairs),
      google.on() ? quiet(trainSpans(from, to, T, prefs), "train search") : null,
      google.on() && hav(from, to) < 1200
        ? quiet(transitRoutes(from, to, prefs.timing === "arrive" ? { arrivalTime: T.deadline.toISOString() } : { departureTime: T.leave.toISOString() }, ["BUS"]), "bus search")
        : null,
      flyable ? liveFlights(oAir.code, dAir.code, prefs.date) : null,
    ]);
    const door = road.get(from, to);

    /* Car */
    let carTotal = Infinity;
    if (!door || (!road.source && abroad && hav(from, to) > 600)) {
      skipped.push("Drive: no road route between these places.");
    } else {
      const drive = round5(door.min);
      const breaks = Math.floor(drive / 180) * 15;
      carTotal = drive + breaks;
      options.push({
        mode: "car", title: "Drive", sub: `${km(door.km)} by road`, live: road.source === "google" ? "Google road time" : "",
        legs: [{
          type: "main", title: `Drive to ${to.name}`, mins: carTotal,
          detail: `${km(door.km)}${breaks ? ` · includes ${breaks} min of breaks` : ""}`, url: mapsUrl(from, to, "driving"),
        }],
        costLo: india ? round10(door.km * 7.5 + (door.km > 80 ? door.km * 1.5 : 0)) : null,
        costHi: india ? round10(door.km > 60 ? Math.max(door.km, 250) * 13 + 300 : 80 + 17 * door.km) : null,
        costNote: india ? "own car (fuel & tolls) – one-way cab" : "",
        links: [{ label: "Open in Google Maps", url: mapsUrl(from, to, "driving"), primary: true }],
      });
    }
    const roadKm = door ? door.km : hav(from, to) * 1.3;

    /* Extra road times for the stations Google picked */
    const spans = trains || [];
    const busSpans = (busRoutes || []).filter((steps) => !spanOf(steps, RAIL, 20)).map((steps) => spanOf(steps, BUS, 20)).filter(Boolean);
    let hubRoad = { get: () => null };
    const hubPairs = [];
    for (const sp of spans) {
      if (sp.board.from.lat != null) hubPairs.push([from, sp.board.from]);
      if (sp.alight.to.lat != null) hubPairs.push([sp.alight.to, to]);
    }
    if (hubPairs.length) hubRoad = await roadPairs(hubPairs);

    /* Train — real timetable from the rail service */
    let railOpt = null;
    if (rail) {
      const byTrain = new Map();
      for (const { o, d, date, trains: list } of rail) for (const r of list) {
        const dep = new Date(`${date}T${r.departure}:00`);
        if (isNaN(dep)) continue;
        const arr = addMin(dep, r.durationMin);
        const a = transfer(road.get(from, o), prefs.local, from, o, `to ${o.name} station`);
        const b = transfer(road.get(d, to), prefs.local, d, to, `to ${to.name}`);
        const name = titleCase(r.trainName || "Train");
        const legs = [
          a,
          { type: "wait", title: "Find your platform and board", mins: 15 },
          {
            type: "main", title: `${name} · ${r.trainNo}`, mins: r.durationMin,
            detail: `${o.name} ${clock(dep)} → ${d.name} ${clock(arr)}${r.halts != null ? ` · ${r.halts} halts` : ""}`,
            alt: [r.trainType && titleCase(String(r.trainType).replace(/_/g, " ")), r.distance && `${r.distance} km`].filter(Boolean).join(" · "),
          },
          { type: "wait", title: "Exit the station", mins: 10 },
          b,
        ];
        const start = addMin(dep, -(a.mins + 15)), total = sumMins(legs);
        const fare = typeof r.estimatedFare === "number" ? r.estimatedFare : null;
        const railKm = +r.distance || hav(o, d) * 1.25;
        const v = {
          start, end: addMin(start, total), total, legs, anchor: dep, preBuf: 15,
          costLo: (fare ?? round10(60 + 0.55 * railKm)) + sumCost(legs), costHi: round10(150 + 1.5 * railKm) + sumCost(legs),
          sub: `${o.name} (${o.code}) → ${d.name} (${d.code})`,
          row: { dep, arr, name: `${name} ${r.trainNo}`, note: `${o.name} → ${d.name}`, price: fare },
        };
        const k = `${r.trainNo}|${isoDate(dep)}`, old = byTrain.get(k);
        // The same train may serve several nearby stations: keep the pairing that gets you there soonest.
        if (!old || v.end < old.end || (+v.end === +old.end && v.total < old.total)) byTrain.set(k, v);
      }
      let variants = [...byTrain.values()];
      // Keep the departures that matter for the chosen timing.
      if (prefs.timing === "arrive") {
        const fit = variants.filter((v) => v.end <= T.deadline && v.end >= addMin(T.deadline, -600));
        variants = fit.length ? fit : variants.sort((x, y) => Math.abs(x.end - T.deadline) - Math.abs(y.end - T.deadline)).slice(0, 4);
      } else if (prefs.timing === "leave") {
        const fit = variants.filter((v) => v.start >= T.leave).sort((x, y) => x.end - y.end).slice(0, 14);
        variants = fit.length ? fit : variants.sort((x, y) => y.start - x.start).slice(0, 4);
      } else variants = variants.filter((v) => isoDate(v.row.dep) === prefs.date);
      if (variants.length) {
        railOpt = {
          mode: "train", title: "Train", variants, live: "Indian Railways timetable", listTitle: "Trains",
          costNote: "from est. fare – 3A, incl. local transfers",
          links: [
            { label: "Book on IRCTC", url: "https://www.irctc.co.in/nget/train-search", primary: true },
            { label: "See all trains", url: `https://www.google.com/search?q=${encodeURIComponent(`trains from ${oNear[0].name} to ${dNear[0].name}`)}` },
          ],
        };
      }
    }

    /* Train — otherwise, departures from Google transit (mostly outside India) */
    if (railOpt) options.push(railOpt);
    else if (spans.length) {
      const variants = spans.map((sp) => {
        const a = transitHop(sp.pre, sp.board.from.lat != null ? hubRoad.get(from, sp.board.from) : null, prefs.local, from, sp.board.from, `to ${sp.board.from.name}`);
        const b = transitHop(sp.post, sp.alight.to.lat != null ? hubRoad.get(sp.alight.to, to) : null, prefs.local, sp.alight.to, to, `to ${to.name}`);
        const legs = [a, { type: "wait", title: "Find your platform and board", mins: 15 }, ...rideLegs(sp.rides), { type: "wait", title: "Exit the station", mins: 10 }, b];
        const start = addMin(sp.board.dep, -(a.mins + 15)), total = sumMins(legs);
        const names = sp.rides.filter((r) => r.t).map((r) => [r.t.name, r.t.number].filter(Boolean).join(" "));
        const fare = india ? [round10(60 + 0.55 * sp.km), round10(150 + 1.5 * sp.km)] : [null, null];
        return {
          start, end: addMin(start, total), total, legs, anchor: sp.board.dep, preBuf: 15,
          costLo: fare[0] == null ? null : fare[0] + sumCost(legs), costHi: fare[1] == null ? null : fare[1] + sumCost(legs),
          sub: `${sp.board.from.name} → ${sp.alight.to.name}`,
          row: { dep: sp.board.dep, arr: sp.alight.arr, name: names.join(" → "), note: `${sp.board.from.name} → ${sp.alight.to.name}${names.length > 1 ? ` · ${names.length - 1} change` : ""}` },
        };
      });
      const q = (v) => encodeURIComponent(`trains from ${spans[0].board.from.name} to ${spans[0].alight.to.name}`);
      options.push({
        mode: "train", title: "Train", variants, live: "Live timings from Google", listTitle: "Trains",
        costNote: india ? "est. Sleeper – 3A fare, incl. local transfers" : "",
        links: [
          india ? { label: "Book on IRCTC", url: "https://www.irctc.co.in/nget/train-search", primary: true }
                : { label: "Open route in Google Maps", url: mapsUrl(from, to, "transit"), primary: true },
          { label: "See all trains", url: `https://www.google.com/search?q=${q()}` },
        ],
      });
    } else if (india) {
      /* Train — estimate, choosing the station pair with the shortest overall trip */
      let best = null;
      for (const o of oStns) for (const d of dStns) {
        const a = road.get(from, o), b = road.get(d, to);
        if (o.code === d.code || !a || !b) continue;
        const railKm = hav(o, d) * 1.25;
        const ride = (railKm / (railKm < 150 ? 48 : railKm < 500 ? 58 : 62)) * 60;
        const score = a.min + ride + b.min;
        if (!best || score < best.score) best = { o, d, a, b, railKm, ride: round5(ride), score };
      }
      if (!best) skipped.push("Train: both places are served by the same station.");
      else if (best.railKm < 40) skipped.push("Train: the nearest stations are too close together to be worth it.");
      else if (best.a.km > 220 || best.b.km > 220) skipped.push("Train: no major railway station within reach of one end.");
      else {
        const { o, d, railKm, ride } = best;
        const a = transfer(best.a, prefs.local, from, o, `to ${o.name} station`);
        const b = transfer(best.b, prefs.local, d, to, `to ${to.name}`);
        options.push({
          mode: "train", title: "Train", sub: `${o.name} (${o.code}) → ${d.name} (${d.code})`,
          legs: [
            a,
            { type: "wait", title: "Find your platform and board", mins: 20 },
            {
              type: "main", title: `Train ${o.code} → ${d.code}`, mins: ride, detail: `about ${km(railKm)} · typical express`,
              alt: railKm > 150 ? `Fastest trains (Vande Bharat, Rajdhani, Shatabdi where they run): about ${dur(round5((railKm / 82) * 60))}` : "",
            },
            { type: "wait", title: "Exit the station", mins: 10 },
            b,
          ],
          costLo: round10(60 + 0.55 * railKm) + a.cost + b.cost,
          costHi: round10(150 + 1.5 * railKm) + a.cost + b.cost,
          costNote: "Sleeper – 3A, incl. local transfers",
          links: [
            { label: "Book on IRCTC", url: "https://www.irctc.co.in/nget/train-search", primary: true },
            { label: "See trains & timings", url: `https://www.google.com/search?q=${encodeURIComponent(`trains from ${o.name} ${o.code} to ${d.name} ${d.code}`)}` },
          ],
          hint: `Search ${o.code} → ${d.code} on IRCTC`,
        });
      }
    } else {
      skipped.push(google.on() ? "Train: Google found no rail route for this trip." : "Train: connect Google Maps in Settings to search trains outside India.");
    }

    /* Bus */
    const busLinks = [
      { label: "Find buses on redBus", url: `https://www.redbus.in/bus-tickets/${slug(from.name)}-to-${slug(to.name)}`, primary: true },
      { label: "Search schedules", url: `https://www.google.com/search?q=${encodeURIComponent(`bus from ${from.name} to ${to.name}`)}` },
    ];
    if (busSpans.length) {
      const variants = busSpans.map((sp) => {
        const a = transitHop(sp.pre, null, "bus", from, sp.board.from, `to ${sp.board.from.name}`);
        const b = transitHop(sp.post, null, "bus", sp.alight.to, to, `to ${to.name}`);
        const legs = [a, { type: "wait", title: "Board", mins: 5 }, ...rideLegs(sp.rides), b];
        const start = addMin(sp.board.dep, -(a.mins + 5)), total = sumMins(legs);
        const names = sp.rides.filter((r) => r.t).map((r) => [r.t.name, r.t.number].filter(Boolean).join(" "));
        return {
          start, end: addMin(start, total), total, legs,
          costLo: india ? round10(Math.max(40, sp.km * 1.4)) + sumCost(legs) : null,
          costHi: india ? round10(Math.max(80, sp.km * 2.6)) + sumCost(legs) : null,
          sub: `${sp.board.from.name} → ${sp.alight.to.name}`,
          row: { dep: sp.board.dep, arr: sp.alight.arr, name: names.join(" → "), note: `${sp.board.from.name} → ${sp.alight.to.name}` },
        };
      });
      options.push({ mode: "bus", title: "Bus", variants, live: "Live timings from Google", listTitle: "Buses", costNote: india ? "est. fare, ordinary – AC" : "", links: india ? busLinks : [{ label: "Open route in Google Maps", url: mapsUrl(from, to, "transit"), primary: true }] });
    } else if (!india) {
      skipped.push("Bus: no long-distance bus timings available for this trip.");
    } else if (roadKm < 25) skipped.push("Intercity bus: too short a trip — a cab or local bus is simpler.");
    else if (roadKm > 900) skipped.push("Bus: over 900 km by road, so no practical direct service.");
    else if (door) {
      const ride = round5(door.min * 1.35 + Math.floor(door.km / 200) * 20);
      const hopCost = prefs.local === "bus" ? 25 : 150;
      options.push({
        mode: "bus", title: "Bus", sub: ride >= 360 ? "Overnight sleeper or day coach" : "State transport or private coach",
        legs: [
          { type: "transfer", title: "Get to the boarding point", mins: 20, cost: hopCost, detail: "Typical time within town" },
          { type: "wait", title: "Board", mins: 10 },
          { type: "main", title: `Bus to ${to.name}`, mins: ride, detail: `${km(door.km)} · with halts` },
          { type: "transfer", title: "Drop point to your destination", mins: 15, cost: hopCost, detail: "Typical time within town" },
        ],
        costLo: round10(Math.max(40, door.km * 1.4)) + 2 * hopCost,
        costHi: round10(Math.max(80, door.km * 2.6)) + 2 * hopCost,
        costNote: "ordinary – AC sleeper, incl. local transfers",
        links: busLinks,
      });
    }

    /* Flight */
    const toAir = road.get(from, oAir), fromAir = road.get(dAir, to);
    const deplane = abroad ? 45 : 25;
    const flightLinks = [
      { label: "Search on Google Flights", url: `https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights from ${oAir.code} to ${dAir.code} on ${prefs.date} one way`)}`, primary: true },
      { label: "MakeMyTrip", url: "https://www.makemytrip.com/flights/" },
    ];
    if (oAir.code === dAir.code) skipped.push(`Flight: both places use the same airport (${oAir.code}).`);
    else if (air < 150) skipped.push("Flight: the nearest airports are under 150 km apart.");
    else if (!toAir || !fromAir || toAir.km > 300 || fromAir.km > 300) skipped.push("Flight: no airport with regular service within reach of one end.");
    else {
      const a = transfer(toAir, prefs.local, from, oAir, `to ${oAir.code} airport`);
      const b = transfer(fromAir, prefs.local, dAir, to, `to ${to.name}`);
      const checkin = { type: "wait", title: "Check-in and security", mins: prefs.airbuf, detail: `${oAir.name}, ${oAir.city}` };
      const exit = { type: "wait", title: abroad ? "Immigration and bags" : "Deplane and collect bags", mins: deplane, detail: `${dAir.name}, ${dAir.city}` };
      let opt;
      if (flights && flights.length) {
        const variants = flights.map((f) => {
          const dep = new Date(f.flights[0].departure_airport.time.replace(" ", "T"));
          const legs = [{ ...a }, checkin];
          f.flights.forEach((s, i) => {
            if (i) legs.push({ type: "wait", title: `Layover at ${s.departure_airport.id}`, mins: f.layovers?.[i - 1]?.duration || 60, detail: s.departure_airport.name });
            legs.push({
              type: "main", title: `${s.airline} ${s.flight_number}`, mins: s.duration,
              detail: `${s.departure_airport.id} ${s.departure_airport.time.slice(11)} → ${s.arrival_airport.id} ${s.arrival_airport.time.slice(11)}${abroad ? " (local times)" : ""}`,
              alt: [s.airplane, s.travel_class].filter(Boolean).join(" · "),
            });
          });
          legs.push(exit, { ...b });
          const start = addMin(dep, -(a.mins + prefs.airbuf)), total = sumMins(legs);
          const air0 = sumMins(legs.slice(2, -2));
          const stops = f.flights.length - 1;
          const price = typeof f.price === "number" ? f.price + a.cost + b.cost : null;
          return {
            start, end: addMin(start, total), total, legs, costLo: price, costHi: price, anchor: dep, preBuf: prefs.airbuf,
            sub: `${oAir.code} → ${dAir.code} · ${stops ? `${stops} stop${stops > 1 ? "s" : ""}` : "non-stop"}`,
            row: {
              dep, arr: addMin(dep, air0), price: f.price,
              name: [...new Set(f.flights.map((s) => s.airline))].join(" + ") + " " + f.flights.map((s) => s.flight_number).join(", "),
              note: stops ? `${stops} stop${stops > 1 ? "s" : ""} via ${f.flights.slice(1).map((s) => s.departure_airport.id).join(", ")}` : "Non-stop",
            },
          };
        }).filter((v) => !isNaN(v.start)).sort((x, y) => x.row.dep - y.row.dep);
        opt = { mode: "flight", title: "Flight", variants, live: "Live flights and fares", listTitle: "Flights", costNote: "ticket + local transfers", links: flightLinks };
      } else {
        const legs = [a, checkin];
        let fare, sub;
        if (india && !(oAir.hub || dAir.hub || air < 500)) {
          const via = AIRPORTS.filter((x) => x.cc === "IN" && x.hub).reduce((p, h) => (hav(oAir, h) + hav(h, dAir) < hav(oAir, p) + hav(p, dAir) ? h : p));
          const d1 = hav(oAir, via), d2 = hav(via, dAir);
          legs.push(
            { type: "main", title: `Fly ${oAir.code} → ${via.code}`, mins: flightMin(d1), detail: km(d1) },
            { type: "wait", title: `Layover in ${via.city}`, mins: 105, detail: "Typical connection" },
            { type: "main", title: `Fly ${via.code} → ${dAir.code}`, mins: flightMin(d2), detail: km(d2) },
          );
          fare = (2400 + 4.2 * d1 + 2400 + 4.2 * d2) * 0.9;
          sub = `${oAir.code} → ${dAir.code} · 1 stop via ${via.code}`;
        } else if (india || (oAir.hub && dAir.hub && air < 9000) || air < 4500) {
          legs.push({ type: "main", title: `Fly ${oAir.code} → ${dAir.code}`, mins: flightMin(air), detail: `${km(air)} · non-stop` });
          fare = india ? 2400 + 4.2 * air : 7000 + 5.5 * air;
          sub = `${oAir.code} → ${dAir.code} · non-stop`;
        } else {
          legs.push({ type: "main", title: `Fly ${oAir.code} → ${dAir.code}`, mins: flightMin(air * 1.12) + 170, detail: `${km(air)} · includes a typical connection` });
          fare = 9000 + 5.5 * air;
          sub = `${oAir.code} → ${dAir.code} · likely 1 stop`;
        }
        legs.push(exit, b);
        opt = {
          mode: "flight", title: "Flight", sub, legs,
          costLo: round10(fare * 0.8) + a.cost + b.cost, costHi: round10(fare * 1.5) + a.cost + b.cost,
          costNote: "economy, incl. local transfers", links: flightLinks,
        };
      }
      const quickest = opt.variants ? Math.min(...opt.variants.map((v) => v.total)) : sumMins(opt.legs);
      if (quickest >= carTotal) skipped.push(`Flight (${oAir.code} → ${dAir.code}): door to door it is no faster than driving.`);
      else options.push(opt);
    }

    for (const o of options) {
      if (o.variants) {
        o.variants.sort((x, y) => x.row.dep - y.row.dep);
        choose(o, prefs, T);
        // Re-time cab hops with predicted traffic for the departures most likely to be picked, then choose again.
        const rank = prefs.timing === "arrive" ? (x, y) => Math.abs(x.end - T.deadline) - Math.abs(y.end - T.deadline)
          : prefs.timing === "leave" ? (x, y) => Math.abs(x.start - T.leave) - Math.abs(y.start - T.leave) : (x, y) => x.total - y.total;
        const top = [...new Set([o.variants[o.pick], ...[...o.variants].sort(rank).slice(0, 4)])];
        await Promise.all(top.map(refine));
        choose(o, prefs, T);
      } else {
        o.total = sumMins(o.legs);
        schedule(o, prefs, at);
      }
      settle(o);
    }
    return { options, skipped, road: road.source, door, abroad, T };
  }

  // Options with real departures: pick the one that best fits the timing preference.
  function choose(o, prefs, T) {
    const vs = o.variants;
    let ok, best;
    if (prefs.timing === "leave") {
      ok = vs.filter((v) => v.start >= T.leave);
      best = [...ok].sort((a, b) => a.end - b.end)[0] || [...vs].sort((a, b) => b.start - a.start)[0];
    } else if (prefs.timing === "arrive") {
      ok = vs.filter((v) => v.end <= T.deadline);
      best = [...ok].sort((a, b) => b.start - a.start)[0] || [...vs].sort((a, b) => a.end - b.end)[0];
    } else {
      ok = vs;
      best = [...vs].sort((a, b) => a.total - b.total)[0];
    }
    o.fits = ok.length > 0;
    o.pick = vs.indexOf(best);
  }

  // Estimated options: work out when to leave and when you arrive.
  function schedule(o, prefs, at) {
    if (prefs.timing === "arrive") {
      o.end = addMin(at(prefs.time), -prefs.cushion);
      o.start = addMin(o.end, -o.total);
    } else if (prefs.timing === "leave") {
      o.start = at(prefs.time);
      o.end = addMin(o.start, o.total);
    } else {
      const i = o.legs.findIndex((l) => l.type === "main");
      const before = sumMins(o.legs.slice(0, i));
      const main = o.legs[i].mins;
      const overnight = (o.mode === "train" || o.mode === "bus") && main >= 420 && main <= 960;
      o.start = overnight ? addMin(at("21:00"), -before) : at(o.mode === "car" ? "06:00" : "07:00");
      o.end = addMin(o.start, o.total);
      o.suggested = overnight ? "Suggested: travel overnight" : "";
    }
  }

  function settle(o) {
    if (o.variants) {
      const v = o.variants[o.pick];
      Object.assign(o, { start: v.start, end: v.end, total: v.total, legs: v.legs, costLo: v.costLo, costHi: v.costHi, sub: v.sub });
    }
    o.late = o.start < new Date();
  }

  /* ---------- rendering ---------- */

  const ICON = {
    flight: '<path d="M21 15.5v-1.8l-7.5-4.6V4.2a1.5 1.5 0 0 0-3 0v4.9L3 13.7v1.8l7.5-2.2v4.5l-2 1.4V20.5l3.5-1 3.5 1v-1.3l-2-1.4v-4.5z"/>',
    train: '<rect x="6" y="3" width="12" height="14" rx="3"/><path d="M6 11h12M9.5 14.2h.01M14.5 14.2h.01M8.5 17 6.5 21M15.5 17l2 4"/>',
    bus: '<rect x="4" y="4" width="16" height="13" rx="2.5"/><path d="M4 11h16M8 14.2h.01M16 14.2h.01M7 17v2.5M17 17v2.5"/>',
    car: '<path d="M4.5 11 6.3 6.6A2 2 0 0 1 8.2 5.3h7.6a2 2 0 0 1 1.9 1.3L19.5 11M3.5 17v-4a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v4M3.5 16h17M6.5 17v2M17.5 17v2M7.5 13.6h.01M16.5 13.6h.01"/>',
  };
  const icon = (m) => `<svg class="mode-icon ${m}" viewBox="0 0 24 24" aria-hidden="true">${ICON[m]}</svg>`;

  function timeHTML(d, base) {
    const diff = Math.round((new Date(isoDate(d) + "T00:00:00") - new Date(base + "T00:00:00")) / 864e5);
    return `${clock(d)}${diff ? `<sup title="${esc(dayLabel(d))}">${diff > 0 ? "+" : "−"}${Math.abs(diff)}</sup>` : ""}`;
  }
  const costHTML = (lo, hi) => lo == null ? "See site" : `${inr(lo)}${hi > lo ? `<span> – ${inr(hi)}</span>` : ""}`;

  const open = new Set();

  function optionHTML(o, prefs, badges) {
    let t = o.start;
    const steps = o.legs.map((l) => {
      const row = `
        <li class="step ${l.type}">
          <time>${clock(t)}</time>
          <div>
            <strong>${esc(l.title)}</strong><span class="mins">${dur(l.mins)}</span>
            ${l.detail ? `<p>${esc(l.detail)}${l.url ? ` · <a href="${esc(l.url)}" target="_blank" rel="noopener">map</a>` : ""}</p>` : ""}
            ${l.alt ? `<p class="alt">${esc(l.alt)}</p>` : ""}
          </div>
        </li>`;
      t = addMin(t, l.mins);
      return row;
    }).join("");
    const bar = o.legs.map((l) => `<i class="${l.type} ${o.mode}" style="flex:${Math.max(l.mins, 1)}" title="${esc(l.title)} · ${dur(l.mins)}"></i>`).join("");
    const startLabel = prefs.timing === "arrive" ? "Leave by" : "Leave";
    const isOpen = open.has(o.mode);
    const T = last.res.T, target = new Date(`${prefs.date}T${prefs.time}:00`);
    const misses = (v) => (prefs.timing === "arrive" ? v.end > T.deadline : prefs.timing === "leave" ? v.start < T.leave : false);
    const early = prefs.timing === "arrive" && o.variants && o.end <= target ? `${dur(minsBetween(o.end, target))} before ${clock(target)}` : "";
    const chooser = o.variants ? `
      <div class="chooser">
        <h3>${o.listTitle} on this route <small>${o.variants.length} found · tap one to plan around it</small></h3>
        <ul>${o.variants.map((v, i) => `
          <li><button type="button" class="dep ${i === o.pick ? "on" : ""} ${misses(v) ? "miss" : ""}" data-mode="${o.mode}" data-i="${i}">
            <span class="dep-time"><b>${timeHTML(v.row.dep, prefs.date)}</b><i></i><b>${timeHTML(v.row.arr, prefs.date)}</b></span>
            <span class="dep-name"><b>${esc(v.row.name)}</b><small>${esc(v.row.note)} · at your destination ${clock(v.end)}${misses(v) ? (prefs.timing === "arrive" ? " — too late" : " — too early") : ""}</small></span>
            <span class="dep-dur">${dur(minsBetween(v.row.dep, v.row.arr))}</span>
            <span class="dep-price">${v.row.price != null ? inr(v.row.price) : ""}</span>
          </button></li>`).join("")}
        </ul>
      </div>` : "";
    const tags = [
      ...badges.map((b) => `<em class="tag good">${b}</em>`),
      o.live ? `<em class="tag live">${esc(o.live)}</em>` : o.mode !== "car" ? `<em class="tag">Estimated timings</em>` : "",
      o.suggested ? `<em class="tag">${o.suggested}</em>` : "",
      early ? `<em class="tag">There ${early}</em>` : "",
      o.variants && !o.fits ? `<em class="tag warn">Nothing fits your time — closest shown</em>` : "",
      o.late ? `<em class="tag warn">Leave time has already passed</em>` : "",
    ].join("");
    return `
      <article class="option" data-mode="${o.mode}">
        <button class="summary" type="button" aria-expanded="${isOpen}">
          <span class="who">${icon(o.mode)}
            <span><b>${o.title}</b><small>${esc(o.sub)}</small></span>
          </span>
          <span class="when">
            <span><small>${startLabel}</small><b>${timeHTML(o.start, prefs.date)}</b></span>
            <span class="arrow" aria-hidden="true"></span>
            <span><small>Arrive</small><b>${timeHTML(o.end, prefs.date)}</b></span>
          </span>
          <span class="took"><b>${dur(o.total)}</b><small>door to door</small></span>
          <span class="cost"><b>${costHTML(o.costLo, o.costHi)}</b><small>${esc(o.costNote || "")}</small></span>
          <span class="chev" aria-hidden="true"></span>
          <span class="bar" aria-hidden="true">${bar}</span>
          ${tags ? `<span class="tags">${tags}</span>` : ""}
        </button>
        <div class="detail" ${isOpen ? "" : "hidden"}>
          ${chooser}
          <ol class="steps">${steps}
            <li class="step end"><time>${clock(o.end)}</time><div><strong>Arrive at ${esc(prefs.toName)}</strong><p>${esc(dayLabel(o.end))}</p></div></li>
          </ol>
          <div class="actions">
            ${o.links.map((l) => `<a class="btn ${l.primary ? "primary" : ""}" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}<span aria-hidden="true"> ↗</span></a>`).join("")}
            ${o.hint ? `<span class="hint">${esc(o.hint)}</span>` : ""}
          </div>
        </div>
      </article>`;
  }

  let last = null, sortBy = "fast";

  function render() {
    const { res, prefs, from, to } = last;
    const cost = (o) => (o.costLo == null ? Infinity : o.costLo);
    const when = new Date(`${prefs.date}T${prefs.time}:00`);
    const timing = prefs.timing === "arrive"
      ? `Arrive by ${clock(when)}${prefs.cushion ? `, ${dur(prefs.cushion)} early` : ""}`
      : prefs.timing === "leave" ? `Leaving at ${clock(when)}` : "Any time";
    const head = `
      <div class="res-head">
        <div>
          <h2>${esc(from.name)} <span>→</span> ${esc(to.name)}</h2>
          <p>${dayLabel(when)} · ${timing}${res.door ? ` · ${km(res.door.km)} by road` : ""}</p>
        </div>
        ${res.options.length > 1 ? `<div class="seg small" role="radiogroup" aria-label="Sort by">
          <label><input type="radio" name="sort" value="fast" ${sortBy === "fast" ? "checked" : ""}><span>Fastest</span></label>
          <label><input type="radio" name="sort" value="cheap" ${sortBy === "cheap" ? "checked" : ""}><span>Cheapest</span></label>
        </div>` : ""}
      </div>
      ${[...problems].map((p) => `<p class="notice">${esc(p)}</p>`).join("")}
      ${res.road ? "" : `<p class="notice">Live road data is unavailable right now, so distances are straight-line estimates. Try again in a moment.</p>`}`;
    const foot = `
      ${res.skipped.length ? `<div class="skipped"><h3>Not shown</h3><ul>${res.skipped.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>` : ""}
      <p class="legend"><i class="main"></i>Travelling <i class="transfer"></i>Local transfer <i class="wait"></i>Waiting
        <span>Maps: ${res.road === "google" ? "Google" : "OpenStreetMap"}${res.abroad ? " · times in your device's time zone unless marked local" : ""}</span></p>`;
    if (!res.options.length) {
      $("results").innerHTML = `${head}<p class="empty">We couldn't work out a route for this trip.</p>${foot}`;
      return;
    }
    const fastest = res.options.reduce((a, b) => (b.total < a.total ? b : a));
    const cheapest = res.options.reduce((a, b) => (cost(b) < cost(a) ? b : a));
    const sorted = [...res.options].sort((a, b) => (sortBy === "fast" ? a.total - b.total : cost(a) - cost(b)));
    $("results").innerHTML = `${head}
      <div class="options">
        ${sorted.map((o) => optionHTML(o, prefs, [o === fastest && "Fastest", o === cheapest && cost(o) < Infinity && "Cheapest"].filter(Boolean))).join("")}
      </div>${foot}`;
  }

  $("results").addEventListener("click", async (e) => {
    const dep = e.target.closest(".dep");
    if (dep) {
      const o = last.res.options.find((x) => x.mode === dep.dataset.mode);
      o.pick = +dep.dataset.i;
      o.fits = true;
      settle(o);
      render();
      const v = o.variants[o.pick];
      if (!v.refined) { await refine(v); if (o.variants[o.pick] === v) { settle(o); render(); } }
      return;
    }
    const btn = e.target.closest(".summary");
    if (!btn) return;
    const mode = btn.parentElement.dataset.mode;
    const now = btn.getAttribute("aria-expanded") !== "true";
    now ? open.add(mode) : open.delete(mode);
    btn.setAttribute("aria-expanded", now);
    btn.nextElementSibling.hidden = !now;
  });
  $("results").addEventListener("change", (e) => {
    if (e.target.name === "sort") { sortBy = e.target.value; render(); }
  });

  /* ---------- form ---------- */

  const form = $("search");
  const timingValue = () => form.elements.timing.value;

  function syncTiming() {
    const t = timingValue();
    $("time-field").hidden = t === "flex";
    $("cushion-field").hidden = t !== "arrive";
    $("time-label").textContent = t === "arrive" ? "Arrive by" : "Leave at";
  }
  $("timing").addEventListener("change", syncTiming);

  $("intl").addEventListener("change", () => {
    if (isIntl() && +$("airbuf").value < 180) $("airbuf").value = "180";
    if (!isIntl() && $("airbuf").value === "180") $("airbuf").value = "90";
    $("to").placeholder = isIntl() ? "Any city in the world" : "Where do you need to be?";
  });

  function fail(msg) {
    const el = $("form-error");
    el.textContent = msg;
    el.hidden = !msg;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    fail("");
    if (!$("from").value.trim() || !$("to").value.trim()) return fail("Enter both where you're starting from and where you're going.");
    if (!$("date").value) return fail("Pick a travel date.");
    const go = $("go");
    go.disabled = true;
    go.textContent = "Finding routes…";
    problems.clear();
    open.clear();
    $("results").innerHTML = `<div class="options loading">${'<div class="skeleton"></div>'.repeat(3)}</div>`;
    try {
      const [from, to] = await Promise.all([resolvePlace("from"), resolvePlace("to")]);
      if (!from || !to) throw new Error(`We couldn't find "${$(from ? "to" : "from").value.trim()}". Try a nearby town or pick a suggestion${isIntl() ? "" : ", or switch on International if it is outside India"}.`);
      if (hav(from, to) < 0.3) throw new Error("Those two places are the same. Pick a different destination.");
      // Places from the built-in list are in India; anything else without a country is judged by a rough bounding box.
      for (const p of [from, to]) if (!p.cc) p.cc = p.lat > 6 && p.lat < 37.5 && p.lon > 68 && p.lon < 97.5 ? "IN" : "XX";
      if (!isIntl() && (from.cc !== "IN" || to.cc !== "IN")) throw new Error(`${from.cc !== "IN" ? from.name : to.name} is outside India. Switch on International to plan this trip.`);
      const prefs = {
        date: $("date").value,
        time: $("time").value || "08:00",
        timing: timingValue(),
        cushion: +$("cushion").value,
        local: $("local").value,
        airbuf: +$("airbuf").value,
        intl: isIntl(),
        toName: to.name,
      };
      const res = await plan(from, to, prefs);
      last = { res, prefs, from, to };
      render();
      try { localStorage.setItem(STORE, JSON.stringify({ from, to, prefs })); } catch { /* private mode */ }
      $("results").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      $("results").innerHTML = "";
      fail(err.message || "Something went wrong. Please try again.");
    } finally {
      go.disabled = false;
      go.textContent = "Find routes";
    }
  });

  $("swap").addEventListener("click", () => {
    [selected.from, selected.to] = [selected.to, selected.from];
    const a = $("from").value;
    $("from").value = $("to").value;
    $("to").value = a;
  });

  $("locate").addEventListener("click", () => {
    if (!navigator.geolocation) return fail("Location isn't available in this browser.");
    const btn = $("locate");
    btn.classList.add("busy");
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      const here = { name: "My location", sub: "", lat: coords.latitude, lon: coords.longitude };
      try {
        const data = await getJSON(`${PHOTON}/reverse?lat=${here.lat}&lon=${here.lon}&lang=en`, {}, 6000);
        const p = data.features && data.features[0] && photonPlace(data.features[0]);
        if (p) { here.name = p.name; here.cc = p.cc; }
      } catch { /* keep "My location" */ }
      selected.from = here;
      $("from").value = here.name;
      btn.classList.remove("busy");
    }, () => {
      btn.classList.remove("busy");
      fail("We couldn't get your location. Type your starting point instead.");
    }, { timeout: 10000 });
  });

  /* ---------- settings ---------- */

  const dlg = $("settings");
  function syncStatus() {
    $("open-settings").classList.toggle("connected", !!(keys.google || keys.flights || keys.rail));
    $("status-google").textContent = keys.google ? "Connected" : "Not connected";
    $("status-flights").textContent = keys.flights ? "Key saved" : "No key";
    $("status-rail").textContent = keys.rail ? "Key saved" : "No key";
  }
  $("open-settings").addEventListener("click", () => {
    $("key-google").value = keys.google;
    $("key-flights").value = keys.flights;
    $("key-rail").value = keys.rail;
    $("test-out").hidden = true;
    dlg.showModal();
  });
  $("settings-form").addEventListener("submit", () => {
    keys = { google: $("key-google").value.trim(), flights: $("key-flights").value.trim(), rail: $("key-rail").value.trim() };
    try { localStorage.setItem(KEYS, JSON.stringify(keys)); } catch { /* private mode */ }
    railOff = false;
    syncStatus();
  });
  $("settings-cancel").addEventListener("click", () => dlg.close());

  // Check the keys as typed and explain, in plain words, what is wrong if a check fails.
  function googleHint(msg) {
    if (/not valid|invalid/i.test(msg)) return "The key itself is wrong. Copy it again from Google Cloud → Credentials.";
    if (/referer|referrer/i.test(msg)) return `The key's website restriction doesn't include this address. Add ${location.origin}/* under the key's Website restrictions.`;
    if (/not been used|disabled|not enabled|blocked|not authorized/i.test(msg)) return "This API isn't switched on for your project, or the key's API restrictions don't allow it.";
    if (/billing/i.test(msg)) return "Billing isn't set up on the Google Cloud project yet.";
    return msg;
  }
  $("settings-test").addEventListener("click", async () => {
    const out = $("test-out"), btn = $("settings-test");
    const saved = keys;
    keys = { google: $("key-google").value.trim(), flights: $("key-flights").value.trim(), rail: $("key-rail").value.trim() };
    const lines = [];
    const show = () => {
      out.hidden = false;
      out.innerHTML = lines.map(([ok, text]) => `<li class="${ok === true ? "ok" : ok === false ? "bad" : ""}">${esc(text)}</li>`).join("");
    };
    btn.disabled = true;
    lines.push([null, "Checking…"]); show(); lines.pop();
    if (!keys.google) lines.push([null, "Google Maps: no key entered — the app will use free map data."]);
    else {
      try { await googleSuggest("Kochi", false); lines.push([true, "Google place search (Places API (New)) works."]); }
      catch (e) { lines.push([false, `Google place search: ${googleHint(e.message)}`]); }
      try {
        const p = { lat: 9.969, lon: 76.292 }, q = { lat: 10.108, lon: 76.357 };
        await google.call("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix",
          { origins: [{ waypoint: wp(p) }], destinations: [{ waypoint: wp(q) }], travelMode: "DRIVE" }, "duration,condition");
        lines.push([true, "Google routes and transit (Routes API) works."]);
      } catch (e) { lines.push([false, `Google routes: ${googleHint(e.message)}`]); }
    }
    // The flight check only looks for the helper that talks to SerpApi; it does not use up a search.
    try {
      await getJSON("api/flights", { headers: keys.flights ? { "x-serpapi-key": keys.flights } : {} }, 8000);
    } catch (e) {
      if (e.status === 400) lines.push([true, "Flight search is ready. Your first real search will confirm the key."]);
      else if (e.status === 501) lines.push([null, "Flights: no SerpApi key yet — flights will be estimates."]);
      else lines.push([false, "Flights: this address can't run the flight helper, so flights will be estimates. Open the app from Vercel or with “node server.js”."]);
    }
    // The train check runs one real lookup (Thiruvananthapuram → Aluva), which uses one credit.
    if (!keys.rail) lines.push([null, "Trains: no rail key yet — train timings will be estimates."]);
    else {
      railOff = false;
      const before = problems.size;
      const found = await railTrains("TVC", "AWY", isoDate(addMin(new Date(), 1440)));
      if (found && found.length) lines.push([true, `Train timetable works (${found.length} trains found Thiruvananthapuram → Aluva).`]);
      else if (found) lines.push([null, "Train timetable answered but returned no trains for the test route."]);
      else lines.push([false, [...problems].slice(before).join(" ") || "Train timetable could not be reached."]);
      railOff = false;
    }
    keys = saved;
    btn.disabled = false;
    show();
  });

  /* ---------- init ---------- */

  setupAutocomplete("from");
  setupAutocomplete("to");
  const today = new Date();
  $("date").min = isoDate(today);
  $("date").value = isoDate(addMin(today, 1440));
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (saved) {
      selected.from = saved.from; $("from").value = saved.from.name;
      selected.to = saved.to; $("to").value = saved.to.name;
      $("intl").checked = !!saved.prefs.intl;
      $("local").value = saved.prefs.local;
      $("airbuf").value = saved.prefs.airbuf;
      $("cushion").value = saved.prefs.cushion;
      $("time").value = saved.prefs.time;
      form.elements.timing.value = saved.prefs.timing;
    }
  } catch { /* nothing saved */ }
  syncTiming();
  syncStatus();
})();
