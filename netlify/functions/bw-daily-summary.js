// Bikini Walk: daily visitor summary email.
// Runs on the schedule in netlify.toml ([functions."bw-daily-summary"]),
// 13:00 UTC = 8 AM Eastern in winter, 9 AM in summer.
// The email itself is built and sent by site-state.js (sendDailySummary),
// which also powers Admin → Visitors → "Send a test now".
const { sendDailySummary } = require('./site-state.js');

exports.handler = async function () {
  try {
    const result = await sendDailySummary({});
    console.log('daily summary:', JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error('daily summary failed:', err.message, err.hint || '');
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
