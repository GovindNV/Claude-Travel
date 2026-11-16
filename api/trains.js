// Train timetable proxy: trains between two station codes, from the irctc.dev service.
// Runs as a Vercel serverless function, and is also mounted by server.js for local use.
// The key comes from the IRCTC_API_KEY environment variable, or from the key saved in the app's Data sources.
module.exports = async (req, res) => {
  const { from, to, date } = req.query || {};
  const key = process.env.IRCTC_API_KEY || req.headers["x-rail-key"];
  if (!key) return res.status(501).json({ error: "No rail timetable key configured" });
  if (!/^[A-Z]{1,5}$/.test(from || "") || !/^[A-Z]{1,5}$/.test(to || "") || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
    return res.status(400).json({ error: "Expected from=CODE&to=CODE&date=YYYY-MM-DD" });
  }
  try {
    const r = await fetch(`https://api.irctc.dev/api/v1/trains/search?from=${from}&to=${to}&date=${date}`, { headers: { "x-api-key": key } });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data) return res.status(502).json({ error: (data && (data.message || data.error)) || `Rail timetable returned ${r.status}` });
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.status(200).json({ data: Array.isArray(data) ? data : data.data || [] });
  } catch (e) {
    return res.status(502).json({ error: "Could not reach the rail timetable service" });
  }
};
