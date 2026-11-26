export type MoneiOptions = {
  apiKey?: string;
  /** Signing secret of a MONEI account webhook, for account events such as dashboard captures. */
  accountWebhookSigningSecret?: string;
  /** Partner accounts only: the merchant account to act for. */
  accountId?: string;
  /**
   * Public base URL of the Medusa backend; MONEI posts callbacks to it. Defaults to the
   * MEDUSA_BACKEND_URL environment variable.
   */
  backendUrl: string;
  /** `true` (default) charges at once (SALE); `false` only authorizes (AUTH, card and PayPal). */
  capture?: boolean;
  /**
   * Minutes after an `AUTHORIZED` callback to cancel the hold when its cart has no
   * order (default 30). `0` turns the release off. At most 10080 (7 days).
   */
  releaseUnorderedHoldsAfterMinutes?: number;
};

export const MONEI_MODES = ["live", "test"] as const;
export type MoneiMode = (typeof MONEI_MODES)[number];
