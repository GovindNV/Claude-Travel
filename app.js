/* Wayline — door-to-door trip planner.
   Road distances: OSRM (live). Flight / train / bus timings and fares: estimates. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const PHOTON = "https://photon.komoot.io";
  const OSRM = "https://router.project-osrm.org";
  const STORE = "wayline:last";

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
    m = Math.round(m);
    const h = Math.floor(m / 60), r = m % 60;
    if (!h) return `${r} min`;
    return r ? `${h} h ${r} min` : `${h} h`;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clock = (d) => d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true }).toUpperCase();
  const dayLabel = (d) => d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
  const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const addMin = (d, m) => new Date(d.getTime() + m * 60000);
  const slug = (s) => s.toLowerCase().replace(/\(.*?\)/g, "").trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  async function getJSON(url, ms = 9000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  /* ---------- place search ---------- */

  const selected = { from: null, to: null };

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
    const sub = [p.city, p.county, p.state].filter((x, i, a) => x && x !== name && a.indexOf(x) === i).slice(0, 2).join(", ");
    return { name, sub: sub || p.country || "India", lat, lon };
  }

  async function remoteMatches(q, limit = 6) {
    const url = `${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=${limit}&lang=en&bbox=68,6,97.5,37.5`;
    const data = await getJSON(url, 6000);
    return (data.features || [])
      .filter((f) => !f.properties.countrycode || f.properties.countrycode === "IN")
      .map(photonPlace)
      .filter(Boolean);
  }

  function merge(local, remote) {
    const out = [...local];
    for (const r of remote) {
      const dup = out.some((p) => p.name.toLowerCase() === r.name.toLowerCase() && hav(p, r) < 25);
      if (!dup) out.push(r);
    }
    return out.slice(0, 7);
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
      items = localMatches(q);
      active = -1;
      draw();
      if (q.length < 3) return;
      timer = setTimeout(async () => {
        try {
          const remote = await remoteMatches(q);
          if (mine !== seq || document.activeElement !== input) return;
          items = merge(localMatches(q), remote);
          draw();
        } catch { /* offline: local suggestions only */ }
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
    if (selected[key]) return selected[key];
    const q = $(key).value.trim();
    if (!q) return null;
    const exact = PLACES.find((p) => p.name.toLowerCase() === q.toLowerCase());
    if (exact) return (selected[key] = exact);
    try {
      const [first] = await remoteMatches(q, 1);
      if (first) return (selected[key] = first);
    } catch { /* fall through */ }
    const [guess] = localMatches(q);
    return guess ? (selected[key] = guess) : null;
  }

  /* ---------- road data ---------- */

  // Returns seg(i, j) → { km, min } for the given points.
  async function roadMatrix(points) {
    const est = (i, j) => {
      const d = hav(points[i], points[j]) * 1.3;
      return { km: d, min: (d / 48) * 60 };
    };
    try {
      const coords = points.map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(";");
      const data = await getJSON(`${OSRM}/table/v1/driving/${coords}?annotations=duration,distance`);
      if (data.code !== "Ok") throw new Error(data.code);
      return {
        live: true,
        seg: (i, j) => {
          const s = data.durations[i][j], m = data.distances[i][j];
          return s == null || m == null ? est(i, j) : { km: m / 1000, min: (s / 60) * 1.15 };
        },
      };
    } catch {
      return { live: false, seg: est };
    }
  }

  /* ---------- planning ---------- */

  function nearest(list, p, penalty = () => 0) {
    let best = null, bestScore = Infinity;
    for (const x of list) {
      const s = hav(p, x) + penalty(x);
      if (s < bestScore) { best = x; bestScore = s; }
    }
    return best;
  }

  const mapsUrl = (a, b, mode) =>
    `https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lon}&destination=${b.lat},${b.lon}&travelmode=${mode}`;

  // A short hop between a door and a hub, by the user's preferred local mode.
  function transfer(seg, pref, a, b, label) {
    const cab = { mins: round5(seg.min * 1.1), cost: round10(80 + 17 * seg.km) };
    const bus = { mins: round5(seg.min * 1.5 + 12), cost: round10(15 + 1.3 * seg.km) };
    if (seg.km < 0.8) {
      return { type: "transfer", title: `Walk ${label}`, mins: 10, cost: 0, detail: km(seg.km) };
    }
    const mine = pref === "bus" ? bus : cab, other = pref === "bus" ? cab : bus;
    return {
      type: "transfer",
      title: `${pref === "bus" ? "Local bus" : "Cab"} ${label}`,
      mins: mine.mins,
      cost: mine.cost,
      detail: `${km(seg.km)} · about ${inr(mine.cost)}`,
      alt: `${pref === "bus" ? "By cab" : "By local bus"}: ${dur(other.mins)} · about ${inr(other.cost)}`,
      url: mapsUrl(a, b, pref === "bus" ? "transit" : "driving"),
    };
  }

  const flightMin = (d) => round5(35 + (d / 780) * 60);
  const flightFare = (d) => 2400 + 4.2 * d;

  async function plan(from, to, prefs) {
    const oAir = nearest(AIRPORTS, from, (a) => (a.hub ? 0 : 40));
    const dAir = nearest(AIRPORTS, to, (a) => (a.hub ? 0 : 40));
    const oStn = nearest(STATIONS, from);
    const dStn = nearest(STATIONS, to);
    const pts = [from, to, oAir, dAir, oStn, dStn];
    const road = await roadMatrix(pts);
    const door = road.seg(0, 1);
    const options = [], skipped = [];
    const dateStr = prefs.date;

    /* Car */
    const drive = round5(door.min);
    const breaks = Math.floor(drive / 180) * 15;
    const fuel = round10(door.km * 7.5 + (door.km > 80 ? door.km * 1.5 : 0));
    const cabFare = round10(door.km > 60 ? Math.max(door.km, 250) * 13 + 300 : 80 + 17 * door.km);
    const car = {
      mode: "car",
      title: "Drive",
      sub: `${km(door.km)} by road`,
      legs: [{
        type: "main",
        title: `Drive to ${to.name}`,
        mins: drive + breaks,
        detail: `${km(door.km)}${breaks ? ` · includes ${breaks} min of breaks` : ""}`,
        url: mapsUrl(from, to, "driving"),
      }],
      costLo: fuel,
      costHi: cabFare,
      costNote: "own car (fuel & tolls) – one-way cab",
      links: [{ label: "Open in Google Maps", url: mapsUrl(from, to, "driving"), primary: true }],
    };
    options.push(car);
    const carTotal = drive + breaks;

    /* Bus */
    if (door.km < 25) skipped.push("Intercity bus: too short a trip — a cab or local bus is simpler.");
    else if (door.km > 900) skipped.push("Bus: over 900 km by road, so no practical direct service.");
    else {
      const ride = round5(door.min * 1.35 + Math.floor(door.km / 200) * 20);
      const hopCost = prefs.local === "bus" ? 25 : 150;
      options.push({
        mode: "bus",
        title: "Bus",
        sub: ride >= 360 ? "Overnight sleeper or day coach" : "State transport or private coach",
        legs: [
          { type: "transfer", title: "Get to the boarding point", mins: 20, cost: hopCost, detail: "Typical time within town" },
          { type: "wait", title: "Board", mins: 10 },
          { type: "main", title: `Bus to ${to.name}`, mins: ride, detail: `${km(door.km)} · with halts` },
          { type: "transfer", title: "Drop point to your destination", mins: 15, cost: hopCost, detail: "Typical time within town" },
        ],
        costLo: round10(Math.max(40, door.km * 1.4)) + 2 * hopCost,
        costHi: round10(Math.max(80, door.km * 2.6)) + 2 * hopCost,
        costNote: "ordinary – AC sleeper, incl. local transfers",
        links: [
          { label: "Find buses on redBus", url: `https://www.redbus.in/bus-tickets/${slug(from.name)}-to-${slug(to.name)}`, primary: true },
          { label: "Search schedules", url: `https://www.google.com/search?q=${encodeURIComponent(`bus from ${from.name} to ${to.name}`)}` },
        ],
      });
    }

    /* Train */
    const toStn = road.seg(0, 4), fromStn = road.seg(5, 1), rail = road.seg(4, 5);
    if (oStn.code === dStn.code) skipped.push(`Train: both places are served by the same station (${oStn.name}).`);
    else if (rail.km < 40) skipped.push("Train: the stations are too close together to be worth it.");
    else if (toStn.km > 220 || fromStn.km > 220) skipped.push("Train: no major railway station within reach of one end.");
    else {
      const speed = rail.km < 150 ? 48 : rail.km < 500 ? 58 : 62;
      const ride = round5((rail.km / speed) * 60);
      const a = transfer(toStn, prefs.local, from, oStn, `to ${oStn.name} station`);
      const b = transfer(fromStn, prefs.local, dStn, to, `to ${to.name}`);
      const sl = round10(60 + 0.55 * rail.km), ac = round10(150 + 1.5 * rail.km);
      options.push({
        mode: "train",
        title: "Train",
        sub: `${oStn.name} (${oStn.code}) → ${dStn.name} (${dStn.code})`,
        legs: [
          a,
          { type: "wait", title: "Find your platform and board", mins: 20 },
          {
            type: "main",
            title: `Train ${oStn.code} → ${dStn.code}`,
            mins: ride,
            detail: `about ${km(rail.km)} · typical express`,
            alt: rail.km > 150 ? `Fastest trains (Vande Bharat, Rajdhani, Shatabdi where they run): about ${dur(round5((rail.km / 82) * 60))}` : "",
          },
          { type: "wait", title: "Exit the station", mins: 10 },
          b,
        ],
        costLo: sl + a.cost + b.cost,
        costHi: ac + a.cost + b.cost,
        costNote: "Sleeper – 3A, incl. local transfers",
        links: [
          { label: "Book on IRCTC", url: "https://www.irctc.co.in/nget/train-search", primary: true },
          { label: "See trains & timings", url: `https://www.google.com/search?q=${encodeURIComponent(`trains from ${oStn.name} ${oStn.code} to ${dStn.name} ${dStn.code}`)}` },
        ],
        hint: `Search ${oStn.code} → ${dStn.code} on IRCTC`,
      });
    }

    /* Flight */
    const air = hav(oAir, dAir), toAir = road.seg(0, 2), fromAir = road.seg(3, 1);
    if (oAir.code === dAir.code) skipped.push(`Flight: both places use the same airport (${oAir.code}).`);
    else if (air < 200) skipped.push("Flight: the nearest airports are under 200 km apart.");
    else if (toAir.km > 260 || fromAir.km > 260) skipped.push("Flight: no airport with regular service within reach of one end.");
    else {
      const a = transfer(toAir, prefs.local, from, oAir, `to ${oAir.code} airport`);
      const b = transfer(fromAir, prefs.local, dAir, to, `to ${to.name}`);
      const legs = [a, { type: "wait", title: "Check-in and security", mins: prefs.airbuf, detail: `${oAir.name}, ${oAir.city}` }];
      let fare, sub;
      if (oAir.hub || dAir.hub || air < 500) {
        legs.push({ type: "main", title: `Fly ${oAir.code} → ${dAir.code}`, mins: flightMin(air), detail: `${km(air)} · non-stop` });
        fare = flightFare(air);
        sub = `${oAir.code} → ${dAir.code} · non-stop`;
      } else {
        const via = AIRPORTS.filter((x) => x.hub).reduce((best, h) =>
          hav(oAir, h) + hav(h, dAir) < hav(oAir, best) + hav(best, dAir) ? h : best);
        const d1 = hav(oAir, via), d2 = hav(via, dAir);
        legs.push(
          { type: "main", title: `Fly ${oAir.code} → ${via.code}`, mins: flightMin(d1), detail: km(d1) },
          { type: "wait", title: `Layover in ${via.city}`, mins: 105, detail: "Typical connection" },
          { type: "main", title: `Fly ${via.code} → ${dAir.code}`, mins: flightMin(d2), detail: km(d2) },
        );
        fare = (flightFare(d1) + flightFare(d2)) * 0.9;
        sub = `${oAir.code} → ${dAir.code} · 1 stop via ${via.code}`;
      }
      legs.push({ type: "wait", title: "Deplane and collect bags", mins: 25, detail: `${dAir.name}, ${dAir.city}` }, b);
      const total = legs.reduce((s, l) => s + l.mins, 0);
      if (total >= carTotal) skipped.push(`Flight (${oAir.code} → ${dAir.code}): door to door it is no faster than driving.`);
      else {
        options.push({
          mode: "flight",
          title: "Flight",
          sub,
          legs,
          costLo: round10(fare * 0.8) + a.cost + b.cost,
          costHi: round10(fare * 1.5) + a.cost + b.cost,
          costNote: "economy, incl. local transfers",
          links: [
            { label: "Search on Google Flights", url: `https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights from ${oAir.code} to ${dAir.code} on ${dateStr} one way`)}`, primary: true },
            { label: "MakeMyTrip", url: "https://www.makemytrip.com/flights/" },
          ],
        });
      }
    }

    for (const o of options) {
      o.total = o.legs.reduce((s, l) => s + l.mins, 0);
      schedule(o, prefs);
    }
    return { options, skipped, live: road.live, door };
  }

  // Work out when to leave and when you arrive, for the chosen timing preference.
  function schedule(o, prefs) {
    const at = (hhmm) => new Date(`${prefs.date}T${hhmm}:00`);
    if (prefs.timing === "arrive") {
      o.end = addMin(at(prefs.time), -prefs.cushion);
      o.start = addMin(o.end, -o.total);
    } else if (prefs.timing === "leave") {
      o.start = at(prefs.time);
      o.end = addMin(o.start, o.total);
    } else {
      // Any time: suggest a comfortable departure; long train/bus rides go overnight.
      const i = o.legs.findIndex((l) => l.type === "main");
      const before = o.legs.slice(0, i).reduce((s, l) => s + l.mins, 0);
      const main = o.legs[i].mins;
      const overnight = (o.mode === "train" || o.mode === "bus") && main >= 420 && main <= 960;
      o.start = overnight ? addMin(at("21:00"), -before) : at(o.mode === "car" ? "06:00" : "07:00");
      o.end = addMin(o.start, o.total);
      o.suggested = overnight ? "Suggested: travel overnight" : "";
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
    const bar = o.legs.map((l) => `<i class="${l.type} ${o.mode}" style="flex:${l.mins}" title="${esc(l.title)} · ${dur(l.mins)}"></i>`).join("");
    const startLabel = prefs.timing === "arrive" ? "Leave by" : "Leave";
    return `
      <article class="option" data-mode="${o.mode}">
        <button class="summary" type="button" aria-expanded="false">
          <span class="who">${icon(o.mode)}
            <span><b>${o.title}</b><small>${esc(o.sub)}</small></span>
          </span>
          <span class="when">
            <span><small>${startLabel}</small><b>${timeHTML(o.start, prefs.date)}</b></span>
            <span class="arrow" aria-hidden="true"></span>
            <span><small>Arrive</small><b>${timeHTML(o.end, prefs.date)}</b></span>
          </span>
          <span class="took"><b>${dur(o.total)}</b><small>door to door</small></span>
          <span class="cost"><b>${inr(o.costLo)}${o.costHi > o.costLo ? `<span> – ${inr(o.costHi)}</span>` : ""}</b><small>${esc(o.costNote)}</small></span>
          <span class="chev" aria-hidden="true"></span>
          <span class="bar" aria-hidden="true">${bar}</span>
          ${badges.length || o.late || o.suggested ? `<span class="tags">
            ${badges.map((b) => `<em class="tag good">${b}</em>`).join("")}
            ${o.suggested ? `<em class="tag">${o.suggested}</em>` : ""}
            ${o.late ? `<em class="tag warn">Leave time has already passed</em>` : ""}
          </span>` : ""}
        </button>
        <div class="detail" hidden>
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
    const fastest = res.options.reduce((a, b) => (b.total < a.total ? b : a));
    const cheapest = res.options.reduce((a, b) => (b.costLo < a.costLo ? b : a));
    const sorted = [...res.options].sort((a, b) => (sortBy === "fast" ? a.total - b.total : a.costLo - b.costLo));

    const when = new Date(`${prefs.date}T${prefs.time}:00`);
    const timing = prefs.timing === "arrive"
      ? `Arrive by ${clock(when)}${prefs.cushion ? `, ${dur(prefs.cushion)} early` : ""}`
      : prefs.timing === "leave" ? `Leaving at ${clock(when)}` : "Any time";

    $("results").innerHTML = `
      <div class="res-head">
        <div>
          <h2>${esc(from.name)} <span>→</span> ${esc(to.name)}</h2>
          <p>${dayLabel(when)} · ${timing} · ${km(res.door.km)} by road</p>
        </div>
        <div class="seg small" role="radiogroup" aria-label="Sort by">
          <label><input type="radio" name="sort" value="fast" ${sortBy === "fast" ? "checked" : ""}><span>Fastest</span></label>
          <label><input type="radio" name="sort" value="cheap" ${sortBy === "cheap" ? "checked" : ""}><span>Cheapest</span></label>
        </div>
      </div>
      ${res.live ? "" : `<p class="notice">Live road data is unavailable right now, so distances are straight-line estimates. Try again in a moment for exact road distances.</p>`}
      <div class="options">
        ${sorted.map((o) => optionHTML(o, prefs, [o === fastest && "Fastest", o === cheapest && "Cheapest"].filter(Boolean))).join("")}
      </div>
      ${res.skipped.length ? `<div class="skipped"><h3>Not shown</h3><ul>${res.skipped.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>` : ""}
      <p class="legend"><i class="main"></i>Travelling <i class="transfer"></i>Local transfer <i class="wait"></i>Waiting</p>`;
  }

  $("results").addEventListener("click", (e) => {
    const btn = e.target.closest(".summary");
    if (!btn) return;
    const open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", open);
    btn.nextElementSibling.hidden = !open;
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
    $("results").innerHTML = `<div class="options loading">${'<div class="skeleton"></div>'.repeat(3)}</div>`;
    try {
      const [from, to] = await Promise.all([resolvePlace("from"), resolvePlace("to")]);
      if (!from || !to) throw new Error(`We couldn't find "${$(from ? "to" : "from").value.trim()}". Try a nearby town or pick a suggestion.`);
      if (hav(from, to) < 1) throw new Error("Those two places are the same. Pick a different destination.");
      const prefs = {
        date: $("date").value,
        time: $("time").value || "08:00",
        timing: timingValue(),
        cushion: +$("cushion").value,
        local: $("local").value,
        airbuf: +$("airbuf").value,
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
        const data = await getJSON(`${PHOTON}/reverse?lat=${here.lat}&lon=${here.lon}&lang=en`, 6000);
        const p = data.features && data.features[0] && photonPlace(data.features[0]);
        if (p) here.name = p.name;
      } catch { /* keep "My location" */ }
      selected.from = here;
      $("from").value = here.name;
      btn.classList.remove("busy");
    }, () => {
      btn.classList.remove("busy");
      fail("We couldn't get your location. Type your starting point instead.");
    }, { timeout: 10000 });
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
      $("local").value = saved.prefs.local;
      $("airbuf").value = saved.prefs.airbuf;
      $("cushion").value = saved.prefs.cushion;
      $("time").value = saved.prefs.time;
      form.elements.timing.value = saved.prefs.timing;
    }
  } catch { /* nothing saved */ }
  syncTiming();
})();
