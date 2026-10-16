import type { SupabaseClient } from "npm:@supabase/supabase-js@2.56.0";

// Payment amounts are never taken from the request body. Every payment-creation
// endpoint re-prices the held order against the catalog tables and refuses to
// charge anything that no longer matches:
//   event packages → event_packages.price_inr (party entries → the phase price
//                    recorded on the line, checked against event_pricing_phases)
//   coin packages  → coin_packages.inr_amount
// create_event_order / create_coin_order_checkout already price server-side; this
// is the second lock, so a tampered or stale row can't reach a gateway.

const COIN_PACKAGE_PREFIX = "coin-package:";
const MONEY_TOLERANCE = 0.005;

type PackageRow = { id: string; name: string | null; category: string | null; price_inr: number | string | null };
type CoinRow = { id: string; inr_amount: number | string | null; coin_amount: number | null };
type PhaseRow = { id: string; party_price_inr: number | string | null };

type StoredLine = {
  id: string;
  package_key: string;
  package_category: string;
  package_name: string | null;
  unit_price_inr: number | string | null;
  quantity: number | null;
  line_total_inr: number | string | null;
  phase_id: string | null;
};

export type PricedLine = {
  item_id: string;
  package_key: string;
  package_name: string;
  quantity: number;
  catalog_unit_price_inr: number;
  stored_unit_price_inr: number;
  stored_line_total_inr: number;
  expected_line_total_inr: number;
};

export type OrderPricing =
  | { ok: true; order_id: string; total_inr: number; lines: PricedLine[] }
  | { ok: false; order_id: string; reason: string; code: "not_found" | "no_items" | "catalog_mismatch" | "unknown_package" };

export class OrderPricingError extends Error {
  status: number;
  code: string;
  constructor(result: Extract<OrderPricing, { ok: false }>) {
    super(result.reason);
    this.name = "OrderPricingError";
    this.code = result.code;
    this.status = result.code === "not_found" ? 404 : 409;
  }
}

function money(value: number | string | null | undefined) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : NaN;
}

function same(a: number, b: number) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= MONEY_TOLERANCE;
}

function isCoinLine(line: StoredLine) {
  return line.package_category === "coins" || line.package_key.startsWith(COIN_PACKAGE_PREFIX);
}

/**
 * Re-derives an order's price from the catalog and compares it with what is stored.
 * Reads with the service-role client; never trusts anything from the HTTP request.
 */
export async function priceOrderFromCatalog(supabase: SupabaseClient, orderId: string): Promise<OrderPricing> {
  const { data: order, error: orderError } = await supabase
    .from("event_orders")
    .select("id, total_amount_inr, event_order_items(id, package_key, package_category, package_name, unit_price_inr, quantity, line_total_inr, phase_id)")
    .eq("id", orderId)
    .single();

  if (orderError || !order) {
    return { ok: false, order_id: orderId, code: "not_found", reason: "Event order not found" };
  }

  const lines = (Array.isArray(order.event_order_items) ? order.event_order_items : []) as StoredLine[];
  if (lines.length === 0) {
    return { ok: false, order_id: orderId, code: "no_items", reason: "Order has no items to charge" };
  }

  const eventKeys = Array.from(new Set(lines.filter((line) => !isCoinLine(line)).map((line) => line.package_key)));
  const coinIds = Array.from(new Set(
    lines.filter(isCoinLine).map((line) => line.package_key.replace(COIN_PACKAGE_PREFIX, "")),
  ));
  const phaseIds = Array.from(new Set(lines.map((line) => line.phase_id).filter((id): id is string => Boolean(id))));

  const [packagesResult, coinsResult, phasesResult] = await Promise.all([
    eventKeys.length > 0
      ? supabase.from("event_packages").select("id, name, category, price_inr").in("id", eventKeys)
      : Promise.resolve({ data: [], error: null }),
    coinIds.length > 0
      ? supabase.from("coin_packages").select("id, inr_amount, coin_amount").in("id", coinIds)
      : Promise.resolve({ data: [], error: null }),
    phaseIds.length > 0
      ? supabase.from("event_pricing_phases").select("id, party_price_inr").in("id", phaseIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (packagesResult.error || coinsResult.error || phasesResult.error) {
    throw packagesResult.error || coinsResult.error || phasesResult.error;
  }

  const packages = new Map(((packagesResult.data || []) as PackageRow[]).map((row) => [String(row.id), row]));
  const coins = new Map(((coinsResult.data || []) as CoinRow[]).map((row) => [String(row.id), row]));
  const phases = new Map(((phasesResult.data || []) as PhaseRow[]).map((row) => [String(row.id), row]));

  const priced: PricedLine[] = [];
  let expectedTotal = 0;

  for (const line of lines) {
    const quantity = Number(line.quantity || 0);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { ok: false, order_id: orderId, code: "catalog_mismatch", reason: `Invalid quantity on ${line.package_key}` };
    }

    let catalogUnit: number;
    let name = line.package_name || line.package_key;

    if (isCoinLine(line)) {
      const coin = coins.get(line.package_key.replace(COIN_PACKAGE_PREFIX, ""));
      if (!coin) {
        return { ok: false, order_id: orderId, code: "unknown_package", reason: `Coin package ${line.package_key} is not in the catalog` };
      }
      catalogUnit = money(coin.inr_amount);
    } else {
      const pkg = packages.get(line.package_key);
      if (!pkg) {
        return { ok: false, order_id: orderId, code: "unknown_package", reason: `Package ${line.package_key} is not in the catalog` };
      }
      name = pkg.name || name;
      if (pkg.category === "party" && line.phase_id) {
        const phase = phases.get(line.phase_id);
        if (!phase) {
          return { ok: false, order_id: orderId, code: "unknown_package", reason: `Pricing phase for ${line.package_key} is not in the catalog` };
        }
        catalogUnit = money(phase.party_price_inr);
      } else {
        catalogUnit = money(pkg.price_inr);
      }
    }

    const storedUnit = money(line.unit_price_inr);
    const storedLineTotal = money(line.line_total_inr);
    const expectedLineTotal = money(catalogUnit * quantity);

    if (!same(storedUnit, catalogUnit) || !same(storedLineTotal, expectedLineTotal)) {
      return {
        ok: false,
        order_id: orderId,
        code: "catalog_mismatch",
        reason: `Price for ${name} no longer matches the catalog. Please create the booking again.`,
      };
    }

    expectedTotal += expectedLineTotal;
    priced.push({
      item_id: line.id,
      package_key: line.package_key,
      package_name: name,
      quantity,
      catalog_unit_price_inr: catalogUnit,
      stored_unit_price_inr: storedUnit,
      stored_line_total_inr: storedLineTotal,
      expected_line_total_inr: expectedLineTotal,
    });
  }

  expectedTotal = money(expectedTotal);
  if (!same(money(order.total_amount_inr), expectedTotal) || expectedTotal <= 0) {
    return {
      ok: false,
      order_id: orderId,
      code: "catalog_mismatch",
      reason: "Order total no longer matches the catalog. Please create the booking again.",
    };
  }

  return { ok: true, order_id: orderId, total_inr: expectedTotal, lines: priced };
}

/** Same as priceOrderFromCatalog but throws an OrderPricingError (404/409) on failure. */
export async function assertOrderPricedFromCatalog(supabase: SupabaseClient, orderId: string) {
  const result = await priceOrderFromCatalog(supabase, orderId);
  if (!result.ok) throw new OrderPricingError(result);
  return result;
}
