export type MoneiOptions = {
  apiKey: string;
  /** Partner accounts only: the merchant account to act for. */
  accountId?: string;
  /** Public base URL of the Medusa backend; MONEI posts callbacks to it. */
  backendUrl: string;
  /** `true` (default) charges at once (SALE); `false` only authorizes (AUTH, card and PayPal). */
  capture?: boolean;
  /**
   * Minutes after an `AUTHORIZED` callback to cancel the hold when its cart has no
   * order (default 30). `0` turns the release off. At most 10080 (7 days).
   */
  releaseUnorderedHoldsAfterMinutes?: number;
};
