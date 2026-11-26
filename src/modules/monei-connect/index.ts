import { Module } from "@medusajs/framework/utils";
import MoneiConnectService from "./service";

export const MONEI_CONNECT_MODULE = "monei_connect";

export default Module(MONEI_CONNECT_MODULE, { service: MoneiConnectService });
