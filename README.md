# Wayline

A door-to-door trip planner for India. Enter where you are and where you need to be, and it compares
flight, train, bus and car, including the transfer from the airport or station to your final destination,
and tells you when to leave and when you'll arrive.

## Run it

It is a static site with no build step and no API keys.

```
python3 -m http.server 8000   # then open http://localhost:8000
```

To host it free, enable GitHub Pages for this repository (Settings → Pages → deploy from branch, root folder).

## Where the numbers come from

| What | Source |
| --- | --- |
| Place search | Built-in list of Indian cities, plus Photon (OpenStreetMap) |
| Road distance and drive time | OSRM public routing server (live) |
| Flight, train and bus durations and fares | Estimates from distance, typical speeds and typical fares |
| Booking | Links out to Google Flights, IRCTC, redBus and Google Maps |

Flight, train and bus timings are not live schedules. Always confirm on the booking site.

## Files

- `index.html`, `styles.css` – the page and its design
- `app.js` – place search, routing calls, trip planning and rendering
- `data.js` – airports, railway stations and popular places
