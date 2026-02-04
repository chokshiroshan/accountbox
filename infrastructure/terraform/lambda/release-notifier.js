// Lambda function for release notifications
// Sends Slack alerts on successful Accountbox releases

/**
 * Event handler for Lambda function
 * @param {Object} event - AWS Lambda event
 * @returns {Object} Response
 */
export const handler = async (event) => {
  const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

  if (!SLACK_WEBHOOK_URL) {
    console.warn('SLACK_WEBHOOK_URL not configured, skipping notification');
    return { statusCode: 200, body: 'Skipped' };
  }

  // Parse event (could be from SNS or direct invocation)
  let message = {};
  if (event.Records && event.Records[0].Sns) {
    message = JSON.parse(event.Records[0].Sns.Message);
  } else {
    message = event;
  }

  const { version, environment, timestamp } = message;

  // Create Slack message
  const slackPayload = {
    text: `Accountbox ${version} deployed to ${environment}`,
    attachments: [
      {
        color: environment === 'production' ? '#36a64f' : '#ffaa00',
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: `🚀 Accountbox v${version} Released`,
              emoji: true
            }
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*Environment:*\n${environment}`
              },
              {
                type: 'mrkdwn',
                text: `*Timestamp:*\n${timestamp || new Date().toISOString()}`
              }
            ]
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'View Release',
                  emoji: true
                },
                url: `https://github.com/[org]/accountbox/releases/tag/v${version}`
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'npm Package',
                  emoji: true
                },
                url: `https://www.npmjs.com/package/accountbox/v/${version}`
              }
            ]
          }
        ]
      }
    ]
  };

  // Send to Slack
  try {
    const response = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(slackPayload)
    });

    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.status}`);
    }

    console.log('Notification sent successfully');
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Notification sent' })
    };
  } catch (error) {
    console.error('Failed to send notification:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};

// For local testing (not used in Lambda)
if (import.meta.url === `file://${process.argv[1]}`) {
  const testEvent = {
    version: '0.1.0',
    environment: 'staging',
    timestamp: new Date().toISOString()
  };
  handler(testEvent).then(console.log).catch(console.error);
}
