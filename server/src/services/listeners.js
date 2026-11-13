/**
 * Registers the listeners that turn "lead.created" etc. into real side
 * effects — the tail of the PHP edition's bootstrap.php. Called once per
 * process, from createApp() and from one-shot scripts that emit events.
 */

import { registerAutomationListeners } from './automation.js';
import { registerCommsListeners } from './comms.js';
import { registerNotificationListeners } from './notifications.js';
import { registerStaffNotifyListeners } from './staffNotify.js';
import { registerWebhookListeners } from './webhooks.js';

let registered = false;

export function registerDomainListeners() {
  if (registered) return;
  registered = true;
  registerAutomationListeners();
  registerWebhookListeners();
  registerNotificationListeners();
  registerCommsListeners();
  registerStaffNotifyListeners();
}
