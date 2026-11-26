import { model } from "@medusajs/framework/utils";

export default model
  .define("monei_connect_state", {
    id: model.id({ prefix: "mcstate" }).primaryKey(),
    state: model.text(),
    verifier: model.text(),
    redirect_uri: model.text(),
  })
  .indexes([{ on: ["state"], unique: true, where: null }]);
