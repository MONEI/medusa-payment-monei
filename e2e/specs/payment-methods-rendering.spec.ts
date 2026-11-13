// How the MONEI methods render at checkout (MONEI-WooCommerce
// `payment-methods-rendering.spec.js`). A collapsed card field, a wallet box spilling
// out of its column or a lost focus state never fails a functional spec: the order
// still goes through. Each case asserts geometry first, so a failure names the box
// that collapsed, then compares pixels.
//
// The visual project's browser runs in the official Playwright image (docker compose
// service `visual-browser`), so local Linux runs and CI render the same pixels. Refresh
// baselines with `pnpm e2e --project=visual --no-deps --update-snapshots=all` and look
// at every changed PNG before committing it.
//
// The card fields are monei.js iframes and stay in the picture: a monei.js UI change
// fails these comparisons, and someone has to look at it. The Apple Pay / Google Pay
// and PayPal buttons are the vendors' art, so their iframes are masked and only their
// box is asserted.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { COUNTRY, METHODS, PRODUCTS, SHIPPING, checkoutToPayment } from "../utils/checkout.ts";
import { resetShopper, signIn } from "../utils/customers.ts";
import {
  type CardLayout,
  type CardPart,
  cardInput,
  cardMount,
  continueToReview,
  selectPaymentMethod,
  splitPartContainer,
  typeIntoCardInput,
  useEmbeddedCheckout,
} from "../utils/embedded.ts";
import { useExpressCheckout } from "../utils/express.ts";
import { SHOPPERS } from "../utils/medusa.ts";

const SHOPPER = SHOPPERS[1];

/** Fails the Luhn check, so monei.js marks the field invalid with no network round trip. */
const LUHN_INVALID = "4242424242424241";

const MOUNTED_MIN_HEIGHT = 30;
const MOUNTED_MIN_WIDTH = 200;
const MOUNT_TIMEOUT = 60_000;

const CARD_FIELDS = '[data-testid="monei-card-fields"]';
const WALLET = "#monei-wallet";

/**
 * The container and its visible iframe both occupy space. `:visible`: monei.js PayPal
 * mounts a 0 px bridge iframe before the PayPal button frame.
 */
async function expectMounted(container: Locator, label: string): Promise<void> {
  const frame = container.locator("iframe:visible").first();
  await expect(frame, `${label}: a visible iframe`).toBeVisible({ timeout: MOUNT_TIMEOUT });
  for (const [what, locator] of [
    ["container", container],
    ["iframe", frame],
  ] as const) {
    const box = await locator.boundingBox();
    expect(box, `${label}: ${what} has a box`).not.toBeNull();
    const size = `${box!.width}x${box!.height}`;
    expect(box!.height, `${label}: ${what} height (${size})`).toBeGreaterThanOrEqual(
      MOUNTED_MIN_HEIGHT,
    );
    expect(box!.width, `${label}: ${what} width (${size})`).toBeGreaterThanOrEqual(
      MOUNTED_MIN_WIDTH,
    );
  }
}

/**
 * The input inside a card iframe sits in its vertical middle and does not overflow it.
 * A 1 px shift passes the screenshot tolerance and a merchant still sees it.
 */
async function expectCentred(page: Page, mount: string, input: Locator, label: string) {
  const frameHeight = await page
    .locator(`${mount} iframe:visible`)
    .first()
    .evaluate((frame) => frame.getBoundingClientRect().height);
  const { offset, overflow } = await input.evaluate((el, height) => {
    const box = el.getBoundingClientRect();
    return {
      offset: box.top + box.height / 2 - height / 2,
      overflow: Math.max(0, box.bottom - height),
    };
  }, frameHeight);
  expect(
    Math.abs(offset),
    `${label}: input centre is ${offset.toFixed(1)}px off the iframe centre`,
  ).toBeLessThanOrEqual(0.5);
  expect(overflow, `${label}: input overflows its iframe by ${overflow.toFixed(1)}px`).toBe(0);
}

const cardParts = (layout: CardLayout): CardPart[] =>
  layout === "split" ? ["number", "expiry", "cvc"] : ["number"];

async function expectCardMounted(page: Page, layout: CardLayout): Promise<void> {
  for (const part of cardParts(layout)) {
    const label = `${layout} card ${part}`;
    await expect(cardInput(page, layout, part), `${label} is ready`).toBeEditable({
      timeout: MOUNT_TIMEOUT,
    });
    await expectMounted(page.locator(cardMount(layout, part)), label);
    await expectCentred(page, cardMount(layout, part), cardInput(page, layout, part), label);
  }
}

/** Web fonts arrive after first paint; a shot taken before them shows fallback glyphs. */
const settle = (page: Page) => page.evaluate(() => document.fonts.ready.then(() => undefined));

/**
 * The embedded card step: the wallet button, the save choice for a signed-in shopper,
 * the cardholder name and the card fields. The wallet sits in the same panel, so it is
 * mounted before the shot and its vendor art is masked.
 */
async function openCardPanel(page: Page, layout: CardLayout, email?: string): Promise<Locator> {
  await useEmbeddedCheckout(page.context(), layout);
  await checkoutToPayment(page, email ? { email } : {});
  await selectPaymentMethod(page, METHODS.card);
  await expectMounted(page.locator(WALLET), "wallet");
  await expectCardMounted(page, layout);
  await settle(page);
  return page.locator(CARD_FIELDS);
}

const walletMask = (page: Page) => [page.locator(`${WALLET} iframe`)];

test.describe("checkout payment methods, rendering", () => {
  test.beforeEach(async ({ page }) => {
    // A collapsed viewport makes every bounding box after it garbage.
    expect(page.viewportSize()?.width ?? 0, "viewport width").toBeGreaterThan(300);
  });

  for (const layout of ["single", "split"] as const) {
    test(`card ${layout}, guest`, async ({ page }) => {
      const panel = await openCardPanel(page, layout);
      await expect(page.getByTestId("monei-save-card-checkbox")).toHaveCount(0);
      await expect(panel).toHaveScreenshot(`card-${layout}-guest.png`, {
        mask: walletMask(page),
      });
    });

    test(`card ${layout}, signed in with save-card`, async ({ page }) => {
      // Saved cards from other specs would add rows to the panel.
      await resetShopper(SHOPPER);
      await signIn(page, SHOPPER);
      const panel = await openCardPanel(page, layout, SHOPPER.email);
      await expect(
        panel.getByText("Save this card for future payments"),
        "the save-card choice rendered",
      ).toBeVisible();
      await expect(panel.getByTestId("monei-saved-card")).toHaveCount(0);
      await expect(panel).toHaveScreenshot(`card-${layout}-save-card.png`, {
        mask: walletMask(page),
      });
    });
  }

  test("card split, focused", async ({ page }) => {
    const panel = await openCardPanel(page, "split");
    await cardInput(page, "split", "number").click();
    await expect(
      splitPartContainer(page, "number"),
      "the number field reports focus to its mount",
    ).toHaveClass(/monei-component--focus/);
    await expect(panel).toHaveScreenshot("card-split-focused.png", { mask: walletMask(page) });
  });

  test("card split, invalid", async ({ page }) => {
    const panel = await openCardPanel(page, "split");
    await typeIntoCardInput(cardInput(page, "split", "number"), LUHN_INVALID);
    // monei.js validates on blur, not on every key.
    await cardInput(page, "split", "expiry").click();
    await expect(
      splitPartContainer(page, "number"),
      "the number field reports the invalid number to its mount",
    ).toHaveClass(/monei-component--invalid/);
    await expect(panel).toHaveScreenshot("card-split-invalid.png", { mask: walletMask(page) });
  });

  test("wallet", async ({ page }) => {
    await openCardPanel(page, "single");
    const mount = page.locator(WALLET);
    await expect(mount).toHaveScreenshot("wallet.png", { mask: walletMask(page) });
  });

  test("bizum", async ({ page }) => {
    await useEmbeddedCheckout(page.context());
    await checkoutToPayment(page, { product: PRODUCTS.sticker, shipping: SHIPPING.free });
    await selectPaymentMethod(page, METHODS.bizum);
    // The Bizum button paints only once monei.js has the payment's methods; its logo
    // loads before that, so a loaded logo alone still shoots a blank button.
    const methods = page.waitForResponse(
      (response) => response.url().includes("/v1/client-payment-methods") && response.ok(),
      { timeout: MOUNT_TIMEOUT },
    );
    await continueToReview(page);
    const mount = page.locator("#monei-bizum-container");
    await expectMounted(mount, "bizum");
    await methods;
    // Below the fold: an iframe that was never in view paints white in the first shots,
    // and two white shots in a row pass as stable.
    await mount.scrollIntoViewIfNeeded();
    const logo = mount.frameLocator("iframe").getByTestId("bizum-button").locator("img");
    await expect
      .poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), {
        message: "the Bizum button logo loaded",
        timeout: MOUNT_TIMEOUT,
      })
      .toBeGreaterThan(0);
    await settle(page);
    await expect(mount).toHaveScreenshot("bizum.png");
  });

  test("paypal", async ({ page }) => {
    await useEmbeddedCheckout(page.context());
    await checkoutToPayment(page);
    await selectPaymentMethod(page, "PayPal");
    await continueToReview(page);
    const mount = page.locator("#monei-paypal-container");
    await expectMounted(mount, "paypal");
    await settle(page);
    // zoid may append the PayPal button frame to <body>, outside the container.
    await expect(mount).toHaveScreenshot("paypal.png", {
      mask: [mount.locator("iframe"), page.locator('iframe[name^="__zoid__paypal_buttons"]')],
    });
  });

  test("express, wallet and PayPal buttons", async ({ page }) => {
    await useExpressCheckout(page.context());
    await page.goto(`/${COUNTRY}/products/${PRODUCTS.tshirt}`);
    const express = page.getByTestId("monei-express");
    await expect(express, "express buttons rendered").toBeVisible({ timeout: MOUNT_TIMEOUT });
    // One wider than its column was the WooCommerce overflow bug.
    await expectMounted(page.locator("#monei-express-wallet"), "express wallet");
    await expectMounted(page.locator("#monei-express-paypal"), "express PayPal");
    await settle(page);
    await expect(express).toHaveScreenshot("express.png", {
      mask: [express.locator("iframe"), page.locator('iframe[name^="__zoid__paypal_buttons"]')],
    });
  });
});
