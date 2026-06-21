// netlify/functions/prices.js
//
// Proxies Yahoo Finance's (unofficial) chart endpoint server-side.
// Why a proxy at all: Yahoo doesn't send CORS headers, so a browser calling
// it directly gets silently blocked. A serverless function isn't a browser,
// so it isn't subject to CORS — it just makes a normal HTTP request.
//
// Why Yahoo over FMP/Stooq: Yahoo's `adjclose` is split AND dividend adjusted
// (confirmed — this matters a lot for dividend payers like MCD), and it
// returns a ticker's full available history in a single call instead of
// being capped at ~5 years like FMP's free tier.
//
// Honest caveat: this endpoint is unofficial. Yahoo can change or rate-limit
// it without notice. If that happens, this function will return a clear
// error (see below) instead of silently returning wrong numbers.

exports.handler = async function (event) {
  const symbol = (event.queryStringParameters && event.queryStringParameters.symbol || "").trim().toUpperCase();

  if (!symbol) {
    return respond(400, { error: "Missing ?symbol=" });
  }
  // Basic sanity check on the symbol shape (letters, dots, hyphens — covers BRK.B etc.)
  if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
    return respond(400, { error: `"${symbol}" doesn't look like a valid ticker.` });
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=max&interval=1d&events=div,splits`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        // Yahoo's chart endpoint is more lenient than its quote endpoint,
        // but a browser-like UA avoids some basic bot filtering.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });
  } catch (e) {
    return respond(502, { error: `Network error reaching Yahoo Finance: ${e.message}` });
  }

  if (res.status === 429) {
    return respond(429, {
      error: "Yahoo Finance rate-limited this request. Wait a few minutes and try again.",
    });
  }
  if (!res.ok) {
    return respond(502, { error: `Yahoo Finance returned HTTP ${res.status}.` });
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    return respond(502, { error: "Yahoo Finance returned something that wasn't valid JSON (likely a block page)." });
  }

  const result = data && data.chart && data.chart.result && data.chart.result[0];
  const yahooError = data && data.chart && data.chart.error;

  if (yahooError) {
    return respond(404, { error: `Yahoo Finance: ${yahooError.description || yahooError.code}` });
  }
  if (!result || !result.timestamp) {
    return respond(404, { error: `No data found for "${symbol}" — check the ticker symbol.` });
  }

  const timestamps = result.timestamp;
  const adjArr =
    result.indicators &&
    result.indicators.adjclose &&
    result.indicators.adjclose[0] &&
    result.indicators.adjclose[0].adjclose;

  if (!adjArr) {
    return respond(502, { error: "Yahoo Finance response was missing adjusted-close data." });
  }

  const rows = [];
  for (let i = 0; i < timestamps.length; i++) {
    const adj = adjArr[i];
    if (adj === null || adj === undefined || !isFinite(adj) || adj <= 0) continue; // holidays/gaps come through as null
    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    rows.push({ date, adj });
  }

  if (rows.length < 50) {
    return respond(404, { error: `Not enough price data for "${symbol}" (${rows.length} rows).` });
  }

  return respond(200, { symbol, rows });
};

function respond(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  };
}
