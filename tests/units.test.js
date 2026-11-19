import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDb, T } from './helpers.js';
import {
  baseUnitOfDimension, dimensionOf, fromBase, normalizeUnitRules, ruleAt, toBase, UnitError,
} from '../src/lib/units.js';

const RULES = [
  { unit: 'EA', dimension: 'count', version: 1, factor_to_base: 1, effective_from: T('2025-01-01T00:00:00Z'), effective_to: null },
  { unit: 'BOX', dimension: 'count', version: 1, factor_to_base: 12, effective_from: T('2025-01-01T00:00:00Z'), effective_to: T('2026-03-01T00:00:00Z') },
  { unit: 'BOX', dimension: 'count', version: 2, factor_to_base: 10, effective_from: T('2026-03-01T00:00:00Z'), effective_to: null },
  { unit: 'KG', dimension: 'mass', version: 1, factor_to_base: 1, effective_from: T('2025-01-01T00:00:00Z'), effective_to: null },
];

test('unit rules are versioned and effective-dated', () => {
  const rules = normalizeUnitRules(RULES);
  assert.equal(ruleAt(rules, 'BOX', T('2026-02-28T23:59:59Z')).version, 1);
  assert.equal(ruleAt(rules, 'BOX', T('2026-03-01T00:00:00Z')).version, 2);
  assert.equal(toBase(3, 'BOX', rules, T('2026-02-10T00:00:00Z')).qty_base, 36);
  assert.equal(toBase(3, 'BOX', rules, T('2026-03-10T00:00:00Z')).qty_base, 30);
});

test('a movement is converted with the rule in force at its own effective instant', () => {
  const rules = normalizeUnitRules(RULES);
  const early = toBase(2, 'BOX', rules, T('2026-02-01T00:00:00Z'));
  const late = toBase(2, 'BOX', rules, T('2026-03-15T00:00:00Z'));
  assert.deepEqual(early, { qty_base: 24, unit: 'BOX', base_unit: 'EA', unit_version: 1, factor_to_base: 12, dimension: 'count' });
  assert.deepEqual(late, { qty_base: 20, unit: 'BOX', base_unit: 'EA', unit_version: 2, factor_to_base: 10, dimension: 'count' });
});

test('overlapping versions of one unit are refused', () => {
  assert.throws(
    () => normalizeUnitRules([...RULES, { unit: 'BOX', dimension: 'count', version: 3, factor_to_base: 8, effective_from: T('2026-02-01T00:00:00Z'), effective_to: null }]),
    (err) => err instanceof UnitError && err.code === 'UNIT_VERSION_OVERLAP',
  );
});

test('a unit cannot belong to two dimensions', () => {
  // A fresh normalisation (not the stored set) is what registers dimensions, so
  // the same unit claimed by two dimensions is caught before any row is converted.
  assert.throws(
    () => normalizeUnitRules([
      { unit: 'EA', dimension: 'count', version: 1, factor_to_base: 1, effective_from: T('2025-01-01T00:00:00Z'), effective_to: null },
      { unit: 'EA', dimension: 'mass', version: 2, factor_to_base: 1, effective_from: T('2027-01-01T00:00:00Z'), effective_to: null },
    ]),
    (err) => err.code === 'UNIT_DIMENSION_AMBIGUOUS',
  );
});

test('the base unit must be unique inside a dimension', () => {
  const rules = normalizeUnitRules([
    ...RULES,
    { unit: 'PCS', dimension: 'count', version: 1, factor_to_base: 1, effective_from: T('2025-01-01T00:00:00Z'), effective_to: null },
  ]);
  // Two factor-1 units in one dimension means "base" is ambiguous, so it is an
  // error rather than a coin flip between EA and PCS.
  assert.throws(() => baseUnitOfDimension(rules, 'count'), (err) => err.code === 'BASE_UNIT_INVALID');
  assert.equal(baseUnitOfDimension(normalizeUnitRules(RULES), 'count'), 'EA');
});

test('a missing rule at the instant is an explicit error, never a silent 1:1', () => {
  const rules = normalizeUnitRules(RULES);
  assert.throws(() => toBase(1, 'G', rules, T('2026-01-01T00:00:00Z')), (err) => err.code === 'UNIT_RULE_MISSING');
  assert.throws(() => dimensionOf(rules, 'G'), (err) => err.code === 'UNIT_UNKNOWN');
  assert.throws(() => ruleAt(rules, 'BOX', T('2024-01-01T00:00:00Z')), (err) => err.code === 'UNIT_RULE_MISSING');
});

test('display conversion inverts the stored base quantity', () => {
  const rules = normalizeUnitRules(RULES);
  assert.deepEqual(fromBase(30, 'BOX', rules, T('2026-03-10T00:00:00Z')), { qty: 3, unit: 'BOX', unit_version: 2, factor_to_base: 10 });
  assert.equal(dimensionOf(rules, 'KG'), 'mass');
});

test('ingest pins the unit version on each row, so a later repack cannot rewrite history', () => {
  const { db } = buildDb({
    batches: [
      {
        id: 'l-1', stream: 'ledger', received_at: '2026-04-10T00:00:00Z',
        rows: [
          { event_id: 'E-1', kind: 'receipt', qty: 2, unit: 'BOX', effective_at: '2026-02-10T00:00:00Z' },
          { event_id: 'E-2', kind: 'receipt', qty: 2, unit: 'BOX', effective_at: '2026-03-10T00:00:00Z' },
        ],
      },
    ],
  });
  const rows = db.prepare('SELECT event_id, delta_base, unit_base, unit_version, factor_to_base FROM ledger_entries ORDER BY event_id').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { event_id: 'E-1', delta_base: 24, unit_base: 'EA', unit_version: 1, factor_to_base: 12 },
    { event_id: 'E-2', delta_base: 20, unit_base: 'EA', unit_version: 2, factor_to_base: 10 },
  ]);
});
