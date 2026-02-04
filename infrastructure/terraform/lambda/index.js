// Accountbox release notifier (AWS Lambda)
// CommonJS module for maximum compatibility with AWS Lambda Node.js runtimes.
//
// Configure:
// - SLACK_WEBHOOK_URL (optional)
//
// Invocation:
// - Direct invocation with { version, environment, timestamp }
// - Or SNS event with message JSON in Records[0].Sns.Message

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Slack webhook failed: ${res.status} ${text}`);
  }
}

function extractMessage(event) {
  if (event && event.Records && event.Records[0] && event.Records[0].Sns) {
    try {
      return JSON.parse(event.Records[0].Sns.Message);
    } catch {
      return { raw: event.Records[0].Sns.Message };
    }
  }
  return event || {};
}

exports.handler = async (event) => {
  const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

  if (!SLACK_WEBHOOK_URL) {
    console.log('SLACK_WEBHOOK_URL not configured; skipping notification');
    return { statusCode: 200, body: 'Skipped' };
  }

  const msg = extractMessage(event);
  const version = msg.version || msg.tag || 'unknown';
  const environment = msg.environment || 'unknown';
  const timestamp = msg.timestamp || new Date().toISOString();

  const payload = {
    text: `Accountbox ${version} deployed to ${environment}`,
    attachments: [
      {
        color: environment === 'production' ? '#36a64f' : '#ffaa00',
        fallback: `Accountbox ${version} deployed to ${environment}`,
        fields: [
          { title: 'Version', value: String(version), short: true },
          { title: 'Environment', value: String(environment), short: true },
          { title: 'Timestamp', value: String(timestamp), short: false },
        ],
      },
    ],
  };

  await postJson(SLACK_WEBHOOK_URL, payload);
  return { statusCode: 200, body: 'OK' };
};
