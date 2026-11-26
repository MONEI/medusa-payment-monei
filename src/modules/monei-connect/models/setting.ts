import { model } from "@medusajs/framework/utils";
import { MONEI_MODES } from "../../../providers/monei/types";

export default model.define("monei_setting", {
  id: model.id().primaryKey(),
  mode: model.enum([...MONEI_MODES]),
});
