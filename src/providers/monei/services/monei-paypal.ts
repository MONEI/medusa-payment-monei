import { MoneiBase } from "../core/monei-base";

export default class MoneiPaypalService extends MoneiBase {
  static identifier = "monei-paypal";
  protected readonly allowedPaymentMethods = ["paypal"];
  protected readonly authAllowed = true;
}
