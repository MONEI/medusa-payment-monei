import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules, ProductStatus } from "@medusajs/framework/utils";
import {
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createProductsWorkflow,
  createPromotionsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createShippingOptionsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
  createTaxRegionsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateStoresWorkflow,
} from "@medusajs/medusa/core-flows";

// Literal provider ids (`pp_<identifier>_<id>`): a renamed identifier must fail the seed,
// not silently leave the region without that provider.
const MONEI_PROVIDERS = [
  "pp_monei_monei",
  "pp_monei-bizum_monei",
  "pp_monei-paypal_monei",
  "pp_monei-mbway_monei",
  "pp_monei-multibanco_monei",
];

const COUNTRIES = ["es", "pt"];

// The host seed (e2e/scripts/seed.ts) reads this line from the command output.
const FIXTURES_MARKER = "E2E_FIXTURES ";

export default async function seed({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const link = container.resolve(ContainerRegistrationKeys.LINK);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const fulfillment = container.resolve(Modules.FULFILLMENT);
  const payment = container.resolve(Modules.PAYMENT);
  const storeModule = container.resolve(Modules.STORE);

  const [store] = await storeModule.listStores();
  if (store.default_region_id) {
    throw new Error("The store is already seeded; pnpm e2e:start resets the database first");
  }

  const registered = (await payment.listPaymentProviders({ id: MONEI_PROVIDERS })).map(
    (provider) => provider.id,
  );
  const missing = MONEI_PROVIDERS.filter((id) => !registered.includes(id));
  if (missing.length) {
    throw new Error(`MONEI providers not registered by the plugin: ${missing.join(", ")}`);
  }

  const {
    result: [salesChannel],
  } = await createSalesChannelsWorkflow(container).run({
    input: { salesChannelsData: [{ name: "MONEI e2e" }] },
  });

  const {
    result: [region],
  } = await createRegionsWorkflow(container).run({
    input: {
      regions: [
        {
          name: "Iberia",
          currency_code: "eur",
          countries: COUNTRIES,
          payment_providers: MONEI_PROVIDERS,
        },
      ],
    },
  });

  await updateStoresWorkflow(container).run({
    input: {
      selector: { id: store.id },
      update: {
        supported_currencies: [{ currency_code: "eur", is_default: true }],
        default_sales_channel_id: salesChannel.id,
        default_region_id: region.id,
      },
    },
  });

  // No tax rates: totals stay the literal product + shipping amounts the specs assert.
  await createTaxRegionsWorkflow(container).run({
    input: COUNTRIES.map((country_code) => ({ country_code, provider_id: "tp_system" })),
  });

  const {
    result: [location],
  } = await createStockLocationsWorkflow(container).run({
    input: {
      locations: [
        { name: "Madrid", address: { city: "Madrid", country_code: "ES", address_1: "" } },
      ],
    },
  });
  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
    [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
  });
  await linkSalesChannelsToStockLocationWorkflow(container).run({
    input: { id: location.id, add: [salesChannel.id] },
  });

  const [existingProfile] = await fulfillment.listShippingProfiles({ type: "default" });
  const shippingProfile =
    existingProfile ??
    (
      await createShippingProfilesWorkflow(container).run({
        input: { data: [{ name: "Default", type: "default" }] },
      })
    ).result[0];

  const fulfillmentSet = await fulfillment.createFulfillmentSets({
    name: "Iberia delivery",
    type: "shipping",
    service_zones: [
      {
        name: "Iberia",
        geo_zones: COUNTRIES.map((country_code) => ({ country_code, type: "country" as const })),
      },
    ],
  });
  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
    [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
  });

  const shippingOption = (name: string, code: string, amount: number) => ({
    name,
    price_type: "flat" as const,
    provider_id: "manual_manual",
    service_zone_id: fulfillmentSet.service_zones[0].id,
    shipping_profile_id: shippingProfile.id,
    type: { label: name, description: name, code },
    prices: [
      { currency_code: "eur", amount },
      { region_id: region.id, amount },
    ],
    rules: [
      { attribute: "enabled_in_store", value: "true", operator: "eq" as const },
      { attribute: "is_return", value: "false", operator: "eq" as const },
    ],
  });
  const { result: shippingOptions } = await createShippingOptionsWorkflow(container).run({
    input: [
      // Bizum test payments approve only below 5 EUR, so the cheap product ships free.
      shippingOption("Free shipping", "free", 0),
      shippingOption("Standard shipping", "standard", 4.5),
    ],
  });

  const {
    result: [apiKey],
  } = await createApiKeysWorkflow(container).run({
    input: { api_keys: [{ title: "MONEI e2e storefront", type: "publishable", created_by: "" }] },
  });
  await linkSalesChannelsToApiKeyWorkflow(container).run({
    input: { id: apiKey.id, add: [salesChannel.id] },
  });

  const product = (title: string, handle: string, amount: number, manageInventory = false) => ({
    title,
    handle,
    status: ProductStatus.PUBLISHED,
    shipping_profile_id: shippingProfile.id,
    options: [{ title: "Size", values: ["One size"] }],
    variants: [
      {
        title: "One size",
        sku: handle.toUpperCase(),
        manage_inventory: manageInventory,
        options: { Size: "One size" },
        prices: [{ amount, currency_code: "eur" }],
      },
    ],
    sales_channels: [{ id: salesChannel.id }],
  });
  const { result: products } = await createProductsWorkflow(container).run({
    input: {
      products: [
        product("MONEI e2e sticker", "monei-e2e-sticker", 2.5),
        product("MONEI e2e t-shirt", "monei-e2e-t-shirt", 18),
        // The stock-out specs set its stock to 0 while the buyer pays.
        product("MONEI e2e limited print", "monei-e2e-limited-print", 18, true),
      ],
    },
  });

  const limited = products.find((p) => p.handle === "monei-e2e-limited-print")!;
  const {
    data: [limitedVariant],
  } = await query.graph({
    entity: "product_variant",
    fields: ["id", "inventory_items.inventory_item_id"],
    filters: { id: limited.variants[0].id },
  });
  const inventoryItemId = limitedVariant?.inventory_items?.[0]?.inventory_item_id;
  if (!inventoryItemId) {
    throw new Error("The managed-inventory product has no inventory item");
  }
  await createInventoryLevelsWorkflow(container).run({
    input: {
      inventory_levels: [
        { inventory_item_id: inventoryItemId, location_id: location.id, stocked_quantity: 1000 },
      ],
    },
  });

  await createPromotionsWorkflow(container).run({
    input: {
      promotionsData: [
        {
          code: "MONEI10",
          type: "standard",
          status: "active",
          application_method: {
            type: "percentage",
            target_type: "order",
            allocation: "across",
            value: 10,
            currency_code: "eur",
          },
        },
      ],
    },
  });

  const fixtures = {
    publishableKey: apiKey.token,
    regionId: region.id,
    salesChannelId: salesChannel.id,
    products: Object.fromEntries(
      products.map((p) => [p.handle, { id: p.id, variantId: p.variants[0].id }]),
    ),
    shippingOptions: Object.fromEntries(shippingOptions.map((o) => [o.name, o.id])),
    promotionCode: "MONEI10",
    limitedStock: { inventoryItemId, locationId: location.id },
  };
  logger.info("MONEI e2e store seeded");
  process.stdout.write(`${FIXTURES_MARKER}${JSON.stringify(fixtures)}\n`);
}
