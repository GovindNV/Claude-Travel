// Flight search proxy: forwards a one-way search to SerpApi's Google Flights engine.
// Runs as a Vercel serverless function, and is also mounted by server.js for local use.
// The key comes from the SERPAPI_KEY environment variable, or from the key saved in the app's Settings.
module.exports = async (req, res) => {
  const { from, to, date } = req.query || {};
  const key = process.env.SERPAPI_KEY || req.headers["x-serpapi-key"];
  if (!key) return res.status(501).json({ error: "No flight search key configured" });
  if (!/^[A-Z]{3}$/.test(from || "") || !/^[A-Z]{3}$/.test(to || "") || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
    return res.status(400).json({ error: "Expected from=IATA&to=IATA&date=YYYY-MM-DD" });
  }
  const url = "https://serpapi.com/search.json?engine=google_flights&type=2&currency=INR&hl=en&gl=in" +
    `&departure_id=${from}&arrival_id=${to}&outbound_date=${date}&api_key=${encodeURIComponent(key)}`;
  try {
    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok || data.error) return res.status(502).json({ error: data.error || `Flight search returned ${r.status}` });
    res.setHeader("Cache-Control", "private, max-age=900");
    return res.status(200).json({ best_flights: data.best_flights || [], other_flights: data.other_flights || [] });
  } catch (e) {
    return res.status(502).json({ error: "Could not reach the flight search service" });
  }
};
