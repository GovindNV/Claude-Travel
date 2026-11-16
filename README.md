# Wayline

A door-to-door trip planner. Enter where you are and where you need to be, and it compares flight, train,
bus and car, including the transfer from the airport or station to your final destination, and tells you
when to leave and when you'll arrive. India by default; switch on **International** for anywhere else.

## Run it

```
node server.js          # then open http://localhost:8000
```

No build step and no dependencies (Node 18 or newer). To host it, import the repository into Vercel: the
site is served as static files and `api/flights.js` becomes the flight-search function.

It also works as a plain static site (GitHub Pages, `python3 -m http.server`), but live flights need the
`/api/flights` function, so on a static host the flight card falls back to estimates.

## Data sources

Open **Data sources** (top right) to paste keys. They are stored only in your browser.

| Key | What it turns on | Without it |
| --- | --- | --- |
| Google Maps API key | Google place search, real road times, cab times adjusted for traffic at that hour, and transit departures where Google has them (not Indian Railways) | OpenStreetMap search and road distances |
| irctc.dev key | The actual trains between the nearby stations at each end, with departure and arrival times | One estimated train time |
| SerpApi key | Real flights, timings and fares (Google Flights results) | Estimated flight time and fare, with a Google Flights link |

### Google Maps key

1. In Google Cloud Console, create a project and enable billing.
2. Enable **Places API (New)** and **Routes API**.
3. Create an API key. Under "Application restrictions" choose **Websites** and add the address you run the
   app on (for example `http://localhost:8000/*` and your Vercel address). Under "API restrictions" allow
   only the two APIs above.
4. Paste it into Data sources.

### Rail timetable key

1. Sign in at irctc.dev with a Google account (an independent service, not IRCTC itself) and create an API key in its dashboard.
2. Either paste it into Data sources, or set it as the `IRCTC_API_KEY` environment variable on Vercel.

The app searches up to three stations near each end and keeps, for each train, the station pairing that
gets you to the door soonest. One trip search uses roughly 6 to 12 lookups; results are cached for the session.

### Flight key

1. Create a SerpApi account and copy your private API key.
2. Either paste it into Data sources, or set it as the `SERPAPI_KEY` environment variable on Vercel
   (or `SERPAPI_KEY=... node server.js` locally) so it never reaches the browser.

Each flight search uses one SerpApi search; results are cached for the browser session.

## Notes

- Train fares are the rail service's estimate for the cheapest class, up to an estimated 3A fare.
- Stations come from a built-in list of about 170 major stations, so very small halts are not considered.
- Times are shown in your device's time zone. On international flights, the times inside each flight step are local airport times.
- Booking buttons open Google Flights, IRCTC, redBus and Google Maps.

## Files

- `index.html`, `styles.css` – the page and its design
- `app.js` – place search, routing, transit and flight lookups, trip planning and rendering
- `data.js` – Indian railway stations and popular places (used when Google is not connected)
- `airports.js` – world airports (OurAirports, public domain)
- `api/flights.js`, `api/trains.js`, `server.js` – flight and rail proxies and a minimal local server
