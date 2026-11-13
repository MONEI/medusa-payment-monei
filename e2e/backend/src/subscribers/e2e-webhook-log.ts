import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

type WebhookEvent = { provider?: string; payload?: { data?: { id?: unknown; status?: unknown } } };

/**
 * Harness only: names the MONEI payment of each delivered callback event, which the
 * core payment subscriber processes at the same moment. Late-callback specs gate on
 * this line, so they cannot pass because the callback never came. The body is not
 * verified here; the plugin verifies it.
 */
export default async function logWebhook({ event, container }: SubscriberArgs<WebhookEvent>) {
  const body = event.data.payload?.data;
  container
    .resolve(ContainerRegistrationKeys.LOGGER)
    .info(
      `E2E webhook event: provider=${event.data.provider} payment=${String(body?.id)} status=${String(body?.status)}`,
    );
}

export const config: SubscriberConfig = { event: "payment.webhook_received" };
