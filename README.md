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
| Google Maps API key | Google place search, real road times, and real train and bus departures from Google's transit data, including which station to use | OpenStreetMap search and road distances; train and bus timings are estimates |
| SerpApi key | Real flights, timings and fares (Google Flights results) | Estimated flight time and fare, with a Google Flights link |

### Google Maps key

1. In Google Cloud Console, create a project and enable billing.
2. Enable **Places API (New)** and **Routes API**.
3. Create an API key. Under "Application restrictions" choose **Websites** and add the address you run the
   app on (for example `http://localhost:8000/*` and your Vercel address). Under "API restrictions" allow
   only the two APIs above.
4. Paste it into Data sources.

### Flight key

1. Create a SerpApi account and copy your private API key.
2. Either paste it into Data sources, or set it as the `SERPAPI_KEY` environment variable on Vercel
   (or `SERPAPI_KEY=... node server.js` locally) so it never reaches the browser.

Each flight search uses one SerpApi search; results are cached for the browser session.

## Notes

- Train fares are estimates even with Google connected; Google's transit data does not include Indian Railways fares.
- Times are shown in your device's time zone. On international flights, the times inside each flight step are local airport times.
- Booking buttons open Google Flights, IRCTC, redBus and Google Maps.

## Files

- `index.html`, `styles.css` – the page and its design
- `app.js` – place search, routing, transit and flight lookups, trip planning and rendering
- `data.js` – Indian railway stations and popular places (used when Google is not connected)
- `airports.js` – world airports (OurAirports, public domain)
- `api/flights.js`, `server.js` – flight-search proxy and a minimal local server
