import { MoneiBase } from "../core/monei-base";

export default class MoneiMbwayService extends MoneiBase {
  static identifier = "monei-mbway";
  protected readonly allowedPaymentMethods = ["mbway"];
  protected readonly authAllowed = false;
}
