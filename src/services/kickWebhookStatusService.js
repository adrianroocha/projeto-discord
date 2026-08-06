const config = require('../config');
const kickWebhookEventsRepository = require('../database/kickWebhookEventsRepository');
const kickFollowEventsRepository = require('../database/kickFollowEventsRepository');

function createKickWebhookStatusService(options = {}) {
  const cfg = options.config || config;
  const eventsRepository =
    options.kickWebhookEventsRepository || kickWebhookEventsRepository;
  const followEventsRepository =
    options.kickFollowEventsRepository || kickFollowEventsRepository;

  function isBroadcasterConfigured() {
    return (
      typeof cfg.kickBroadcasterUserId === 'string' &&
      cfg.kickBroadcasterUserId.trim() !== ''
    );
  }

  function isWebhookConfigured() {
    return Boolean(cfg.kickEnabled);
  }

  function getStatus() {
    const latestEvent = eventsRepository.findLatest();
    const auditedEventsCount = eventsRepository.countAll();
    const followEventsCount = followEventsRepository.countAll();

    let latestFollow = null;
    if (latestEvent && latestEvent.event_type === 'channel.followed') {
      latestFollow = followEventsRepository.findByEventMessageId(
        latestEvent.event_message_id,
      );
    }

    return {
      webhookConfigured: isWebhookConfigured(),
      broadcasterConfigured: isBroadcasterConfigured(),
      auditedEventsCount,
      followEventsCount,
      latestEvent,
      latestFollow,
    };
  }

  return {
    getStatus,
  };
}

const defaultService = createKickWebhookStatusService();
defaultService.createKickWebhookStatusService = createKickWebhookStatusService;

module.exports = defaultService;
