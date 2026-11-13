import type {
  CreateAccountHolderInput,
  CreateAccountHolderOutput,
  DeleteAccountHolderInput,
  DeleteAccountHolderOutput,
  DeletePaymentMethodInput,
  DeletePaymentMethodOutput,
  ListPaymentMethodsInput,
  ListPaymentMethodsOutput,
  PaymentProviderContext,
} from "@medusajs/framework/types";
import { MedusaError } from "@medusajs/framework/utils";
import type { CreateCustomerRequest } from "@monei-js/node-sdk";
import { isNotFound, toMedusaError } from "../core/errors";
import { CARD_IDENTIFIER, moneiCustomerIdOf, opaqueId } from "../core/ids";
import { MoneiBase, type ResolvedCustomer } from "../core/monei-base";
import { compact, fullName } from "../utils/fields";

export default class MoneiCardService extends MoneiBase {
  static identifier = CARD_IDENTIFIER;
  protected readonly allowedPaymentMethods = ["card"];
  protected readonly authAllowed = true;

  protected override async resolveCustomer(
    context?: PaymentProviderContext,
  ): Promise<ResolvedCustomer> {
    const id = moneiCustomerIdOf(context?.account_holder);
    if (!id) return { missing: false };
    try {
      await this.client_.customers.get(id);
      return { customerId: id, missing: false };
    } catch (error) {
      // Any other error throws: an outage must not drop the customer from the payment.
      if (!isNotFound(error)) throw toMedusaError(error, "get customer");
      this.logger_.warn(
        `MONEI customer ${id} no longer exists; the payment is created without a customer`,
      );
      return { missing: true };
    }
  }

  async createAccountHolder({
    context,
  }: CreateAccountHolderInput): Promise<CreateAccountHolderOutput> {
    const { customer } = context;
    if (!customer) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "A Medusa customer is required to create a MONEI customer",
      );
    }
    // Only contact fields: there is no update, so anything else would go stale at MONEI.
    const request = compact({
      email: customer.email,
      name: fullName(customer.first_name, customer.last_name),
      phone: customer.phone,
    }) as CreateCustomerRequest | undefined;
    const created = await this.call("create customer", () =>
      this.client_.customers.create(request ?? {}),
    );
    return { id: created.id, data: { id: created.id } };
  }

  async deleteAccountHolder({
    context,
  }: DeleteAccountHolderInput): Promise<DeleteAccountHolderOutput> {
    const id = moneiCustomerIdOf(context.account_holder);
    if (!id) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "MONEI customer id is missing");
    }
    try {
      await this.client_.customers.delete(id);
    } catch (error) {
      // Medusa deletes its row before this call, so a customer already gone is done.
      if (!isNotFound(error)) throw toMedusaError(error, "delete customer");
    }
    return {};
  }

  async listPaymentMethods({
    context,
  }: ListPaymentMethodsInput): Promise<ListPaymentMethodsOutput> {
    const id = moneiCustomerIdOf(context?.account_holder);
    if (!id) return [];
    const methods = await this.call("list payment methods", () =>
      this.client_.customers.listPaymentMethods(id),
    );
    // The token is a permanent credential: return the opaque id of the store routes.
    return methods.map((method) => ({
      id: opaqueId(method.id),
      data: {
        brand: method.paymentMethod?.card?.brand ?? null,
        last4: method.paymentMethod?.card?.last4 ?? null,
        // Seconds since the Unix epoch, as MONEI returns it.
        expires_at: method.paymentMethod?.card?.expiration ?? null,
      },
    }));
  }

  async deletePaymentMethod({
    context,
    data,
  }: DeletePaymentMethodInput): Promise<DeletePaymentMethodOutput> {
    const id = moneiCustomerIdOf(context?.account_holder);
    if (!id || typeof data?.id !== "string" || !data.id) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "MONEI customer id or payment method id is missing",
      );
    }
    const methods = await this.call("list payment methods", () =>
      this.client_.customers.listPaymentMethods(id),
    );
    const method = methods.find((candidate) => opaqueId(candidate.id) === data.id);
    if (!method) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Payment method not found");
    await this.call("delete payment method", () =>
      this.client_.customers.deletePaymentMethod(id, method.id),
    );
    return {};
  }
}
