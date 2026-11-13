import { ModuleProvider, Modules } from "@medusajs/framework/utils";
import MoneiBizumService from "./services/monei-bizum";
import MoneiCardService from "./services/monei-card";
import MoneiMbwayService from "./services/monei-mbway";
import MoneiMultibancoService from "./services/monei-multibanco";
import MoneiPaypalService from "./services/monei-paypal";

export default ModuleProvider(Modules.PAYMENT, {
  services: [
    MoneiCardService,
    MoneiBizumService,
    MoneiPaypalService,
    MoneiMbwayService,
    MoneiMultibancoService,
  ],
});
