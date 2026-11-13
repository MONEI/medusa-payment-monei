import { MoneiBase } from "../core/monei-base";

export default class MoneiMultibancoService extends MoneiBase {
  static identifier = "monei-multibanco";
  protected readonly allowedPaymentMethods = ["multibanco"];
  protected readonly authAllowed = false;
}
