import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// supabase/functions/_shared/orderPricing.ts re-prices a held order from the
// catalog before any gateway amount is created. These tests drive it with an
// in-memory stand-in for the service-role client.
const compile = (file) => {
  const exports = {};
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(code, { exports, require: () => ({}), console });
  return exports;
};
const pricing = compile('supabase/functions/_shared/orderPricing.ts');

const PARTY_PHASE = 'phase-1';
const catalog = () => ({
  event_packages: [
    { id: 'party-entry', name: 'Party Entry', category: 'party', price_inr: '1200.00' },
    { id: 'one-intensive', name: 'One Intensive', category: 'intensives', price_inr: '2500.00' },
  ],
  coin_packages: [{ id: 'c1', inr_amount: '500.00', coin_amount: 50 }],
  event_pricing_phases: [{ id: PARTY_PHASE, party_price_inr: '999.00' }],
});

function client(order, tables = catalog()) {
  return {
    from(table) {
      const rows = table === 'event_orders' ? (order ? [order] : []) : tables[table] || [];
      const q = {
        select: () => q,
        eq: () => q,
        in: (_col, ids) => ({ data: rows.filter((row) => ids.includes(String(row.id))), error: null }),
        single: () => (rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'not found' } }),
      };
      return q;
    },
  };
}

const line = (overrides) => ({
  id: 'i1', package_key: 'party-entry', package_category: 'party', package_name: 'Party Entry',
  unit_price_inr: '999.00', quantity: 2, line_total_inr: '1998.00', phase_id: PARTY_PHASE, ...overrides,
});

test('catalog-priced order passes and returns the catalog total', async () => {
  const order = {
    id: 'o1', total_amount_inr: '4498.00',
    event_order_items: [line(), line({ id: 'i2', package_key: 'one-intensive', package_category: 'intensives', unit_price_inr: 2500, quantity: 1, line_total_inr: 2500, phase_id: null })],
  };
  const result = await pricing.priceOrderFromCatalog(client(order), 'o1');
  assert.equal(result.ok, true);
  assert.equal(result.total_inr, 4498);
  assert.deepEqual([...result.lines.map((l) => l.catalog_unit_price_inr)], [999, 2500]);
});

test('party entries are checked against the phase price, not the base package price', async () => {
  const order = { id: 'o2', total_amount_inr: '2400.00', event_order_items: [line({ unit_price_inr: 1200, line_total_inr: 2400 })] };
  const result = await pricing.priceOrderFromCatalog(client(order), 'o2');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'catalog_mismatch');
});

test('a tampered unit price is refused', async () => {
  const order = { id: 'o3', total_amount_inr: '2.00', event_order_items: [line({ unit_price_inr: 1, line_total_inr: 2 })] };
  const result = await pricing.priceOrderFromCatalog(client(order), 'o3');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'catalog_mismatch');
});

test('a tampered order total is refused even when lines match', async () => {
  const order = { id: 'o4', total_amount_inr: '1.00', event_order_items: [line()] };
  const result = await pricing.priceOrderFromCatalog(client(order), 'o4');
  assert.equal(result.ok, false);
  assert.match(result.reason, /Order total/);
});

test('coin lines price from coin_packages', async () => {
  const coin = line({ id: 'i9', package_key: 'coin-package:c1', package_category: 'coins', package_name: '50 Coins', unit_price_inr: 500, quantity: 3, line_total_inr: 1500, phase_id: null });
  const ok = await pricing.priceOrderFromCatalog(client({ id: 'o5', total_amount_inr: 1500, event_order_items: [coin] }), 'o5');
  assert.equal(ok.ok, true);
  assert.equal(ok.total_inr, 1500);
  const bad = await pricing.priceOrderFromCatalog(client({ id: 'o6', total_amount_inr: 3, event_order_items: [{ ...coin, unit_price_inr: 1, line_total_inr: 3 }] }), 'o6');
  assert.equal(bad.ok, false);
});

test('unknown packages, empty carts and missing orders are refused with distinct codes', async () => {
  const unknown = await pricing.priceOrderFromCatalog(client({ id: 'o7', total_amount_inr: 10, event_order_items: [line({ package_key: 'ghost', phase_id: null })] }), 'o7');
  assert.equal(unknown.code, 'unknown_package');
  const empty = await pricing.priceOrderFromCatalog(client({ id: 'o8', total_amount_inr: 0, event_order_items: [] }), 'o8');
  assert.equal(empty.code, 'no_items');
  const missing = await pricing.priceOrderFromCatalog(client(null), 'o9');
  assert.equal(missing.code, 'not_found');
  await assert.rejects(() => pricing.assertOrderPricedFromCatalog(client(null), 'o9'), (error) => error.status === 404);
  await assert.rejects(() => pricing.assertOrderPricedFromCatalog(client({ id: 'o8', total_amount_inr: 0, event_order_items: [] }), 'o8'), (error) => error.status === 409);
});
