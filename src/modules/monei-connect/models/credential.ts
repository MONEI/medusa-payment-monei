import { model } from "@medusajs/framework/utils";
import { MONEI_MODES } from "../../../providers/monei/types";

export default model
  .define("monei_credential", {
    id: model.id({ prefix: "mcred" }).primaryKey(),
    mode: model.enum([...MONEI_MODES]),
    account_id: model.text(),
    api_key: model.text(),
    signing_secret: model.text(),
  })
  .indexes([{ on: ["mode"], unique: true, where: null }]);
