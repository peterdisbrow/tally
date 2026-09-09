/**
 * In-process health for AlertEngine outbound sends (Telegram HTTP ok + Slack ok).
 *
 * Status page watches last success, not just webhook getMe.
 * After N consecutive failures we page once (Sentry + Andrew Telegram) until
 * a later success resets the counter. Prepare mode: never-sent stays operational.
 */

const DEFAULT_ALERT_SEND_FAILURE_THRESHOLD = 3;

function emptyChannel() {
  return {
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    lastError: '',
    pagedAtThreshold: false,
  };
}

function parseThreshold(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ALERT_SEND_FAILURE_THRESHOLD;
  return Math.floor(n);
}

function createAlertDeliveryHealth(options = {}) {
  const threshold = parseThreshold(
    options.failureThreshold != null
      ? options.failureThreshold
      : process.env.ALERT_SEND_FAILURE_THRESHOLD,
  );

  const channels = {
    telegram: emptyChannel(),
    slack: emptyChannel(),
  };

  function record(channel, { ok, error } = {}) {
    const ch = channels[channel];
    if (!ch) return { shouldPage: false };

    if (ok) {
      ch.lastSuccessAt = new Date().toISOString();
      ch.consecutiveFailures = 0;
      ch.lastError = '';
      ch.pagedAtThreshold = false;
      return { shouldPage: false, channel, consecutiveFailures: 0 };
    }

    ch.lastFailureAt = new Date().toISOString();
    ch.consecutiveFailures += 1;
    ch.lastError = String(error || 'send failed').slice(0, 240);
    const shouldPage = ch.consecutiveFailures >= threshold && !ch.pagedAtThreshold;
    if (shouldPage) ch.pagedAtThreshold = true;
    return {
      shouldPage,
      channel,
      consecutiveFailures: ch.consecutiveFailures,
      lastError: ch.lastError,
      lastSuccessAt: ch.lastSuccessAt,
    };
  }

  function snapshot() {
    return {
      threshold,
      telegram: { ...channels.telegram },
      slack: { ...channels.slack },
    };
  }

  function formatLastOk(ch, label) {
    if (ch.lastSuccessAt) return `${label} last ok ${ch.lastSuccessAt}`;
    if (ch.lastFailureAt) return `${label} never succeeded`;
    return `${label} no sends since process start`;
  }

  /**
   * Public status component: last successful Telegram + Slack send.
   * Never-sent (prepare mode / 0 connected churches) stays operational.
   * Consecutive HTTP failures → degraded. Telegram at threshold → still
   * degraded (not outage) so one church 403 cannot flap the public page.
   */
  function getStatusComponent() {
    const { telegram, slack } = channels;
    const neverSent = !telegram.lastSuccessAt && !telegram.lastFailureAt
      && !slack.lastSuccessAt && !slack.lastFailureAt;

    if (neverSent) {
      return {
        state: 'operational',
        detail: 'No outbound alert sends since process start',
      };
    }

    const parts = [
      formatLastOk(telegram, 'Telegram'),
      formatLastOk(slack, 'Slack'),
    ];

    if (telegram.consecutiveFailures > 0) {
      parts.push(`Telegram ${telegram.consecutiveFailures} consecutive send failures`);
    }
    if (slack.consecutiveFailures > 0) {
      parts.push(`Slack ${slack.consecutiveFailures} consecutive send failures`);
    }

    const failing = telegram.consecutiveFailures > 0 || slack.consecutiveFailures > 0;
    return {
      state: failing ? 'degraded' : 'operational',
      detail: parts.join('; '),
    };
  }

  function reset() {
    channels.telegram = emptyChannel();
    channels.slack = emptyChannel();
  }

  return {
    record,
    snapshot,
    getStatusComponent,
    reset,
    threshold,
  };
}

module.exports = {
  createAlertDeliveryHealth,
  DEFAULT_ALERT_SEND_FAILURE_THRESHOLD,
};
