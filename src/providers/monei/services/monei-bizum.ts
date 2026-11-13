import { MoneiBase } from "../core/monei-base";

export default class MoneiBizumService extends MoneiBase {
  static identifier = "monei-bizum";
  protected readonly allowedPaymentMethods = ["bizum"];
  protected readonly authAllowed = false;
}
