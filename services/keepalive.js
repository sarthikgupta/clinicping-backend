// services/keepalive.js
// Pings the server every 14 minutes to prevent Railway free tier sleeping

const https = require('https');
const http = require('http');

function startKeepalive() {
  const url = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`
    : `http://localhost:${process.env.PORT || 4000}/health`;

  setInterval(() => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      console.log(`[Keepalive] ${new Date().toISOString()} → ${res.statusCode}`);
    });
    req.on('error', (err) => console.warn(`[Keepalive] failed: ${err.message}`));
    req.end();
  }, 14 * 60 * 1000);

  console.log(`[Keepalive] pinging ${url} every 14 min`);
}

module.exports = { startKeepalive };
