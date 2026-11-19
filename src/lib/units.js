/**
 * Unit conversion is versioned and effective-dated. A movement is always converted
 * with the rule whose window contains the movement's *effective* time, and the rule
 * identity is pinned onto the posted ledger row so later rule changes cannot rewrite
 * history. Conversions are only meaningful inside one dimension.
 */
import { round6 } from './util.js';

export class UnitError extends Error {
  constructor(message, code = 'UNIT_ERROR', detail = {}) {
    super(message);
    this.name = 'UnitError';
    this.code = code;
    this.detail = detail;
  }
}

export function normalizeUnitRules(rules, { source = 'unit rules' } = {}) {
  if (!Array.isArray(rules) || rules.length === 0) throw new UnitError(`${source}: at least one unit rule is required`);
  const seen = new Set();
  const out = rules.map((r, i) => {
    const unit = String(r.unit ?? '').trim();
    const dimension = String(r.dimension ?? '').trim();
    const factor = Number(r.factor_to_base);
    const version = Number(r.version);
    if (!unit) throw new UnitError(`${source}[${i}]: unit is required`);
    if (!dimension) throw new UnitError(`${source}[${i}]: dimension is required`);
    if (!Number.isInteger(version) || version < 1) throw new UnitError(`${source}[${i}]: version must be a positive integer`);
    if (!Number.isFinite(factor) || factor <= 0) throw new UnitError(`${source}[${i}]: factor_to_base must be > 0`);
    if (!r.effective_from) throw new UnitError(`${source}[${i}]: effective_from is required`);
    const effectiveFrom = new Date(r.effective_from).toISOString();
    const effectiveTo = r.effective_to ? new Date(r.effective_to).toISOString() : null;
    if (effectiveTo && effectiveTo <= effectiveFrom) {
      throw new UnitError(`${source}[${i}]: effective_to must be after effective_from`);
    }
    const key = `${unit}@${version}`;
    if (seen.has(key)) throw new UnitError(`${source}[${i}]: duplicate unit/version ${key}`);
    seen.add(key);
    return {
      unit,
      dimension,
      version,
      factor_to_base: factor,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      label: r.label ?? `${unit} v${version}`,
      note: r.note ?? null,
    };
  });
  // A unit name must mean one dimension across its whole version history, otherwise
  // a conversion could silently cross dimensions (e.g. a "BOX" of mass).
  const dimensionByUnit = new Map();
  for (const r of out) {
    const known = dimensionByUnit.get(r.unit);
    if (known && known !== r.dimension) throw new UnitError(`${source}: unit ${r.unit} mixes dimensions ${known} and ${r.dimension}`, 'UNIT_DIMENSION_AMBIGUOUS');
    dimensionByUnit.set(r.unit, r.dimension);
  }
  for (const u of new Set(out.map((r) => r.unit))) {
    const versions = out.filter((r) => r.unit === u);
    for (const a of versions) {
      for (const b of versions) {
        if (a === b) continue;
        const overlap =
          a.effective_from < (b.effective_to ?? '9999-12-31T23:59:59.999Z') &&
          b.effective_from < (a.effective_to ?? '9999-12-31T23:59:59.999Z');
        if (overlap) throw new UnitError(`${source}: unit ${u} versions ${a.version} and ${b.version} overlap`, 'UNIT_VERSION_OVERLAP');
      }
    }
  }
  return out.sort((a, b) => (a.unit === b.unit ? a.version - b.version : a.unit.localeCompare(b.unit)));
}

export function ruleAt(unitRules, unit, atIso) {
  const candidates = unitRules.filter((r) => r.unit === unit && r.effective_from <= atIso && (!r.effective_to || atIso < r.effective_to));
  if (candidates.length === 0) {
    throw new UnitError(`no unit rule for "${unit}" effective at ${atIso}`, 'UNIT_RULE_MISSING', { unit, at: atIso });
  }
  if (candidates.length > 1) {
    throw new UnitError(`ambiguous unit rules for "${unit}" at ${atIso}`, 'UNIT_RULE_AMBIGUOUS', { unit, at: atIso });
  }
  return candidates[0];
}

/**
 * The base unit of a dimension is the unit with factor_to_base = 1. It must exist
 * and be unique; otherwise quantities in that dimension have no canonical unit and
 * comparisons would silently mix scales.
 */
export function baseUnitOfDimension(unitRules, dimension) {
  const ones = unitRules.filter((r) => r.dimension === dimension && r.factor_to_base === 1);
  const names = [...new Set(ones.map((r) => r.unit))];
  if (names.length !== 1) {
    throw new UnitError(
      names.length === 0
        ? `dimension "${dimension}" has no base unit (factor_to_base = 1)`
        : `dimension "${dimension}" has several base units: ${names.join(', ')}`,
      'BASE_UNIT_INVALID',
      { dimension, candidates: names },
    );
  }
  return names[0];
}

export function toBase(quantity, unit, unitRules, atIso) {
  const q = Number(quantity);
  if (!Number.isFinite(q)) throw new UnitError(`quantity must be a number, got ${JSON.stringify(quantity)}`, 'QTY_INVALID');
  const rule = ruleAt(unitRules, unit, atIso);
  return {
    qty_base: round6(q * rule.factor_to_base),
    unit, // the unit as supplied (input)
    base_unit: baseUnitOfDimension(unitRules, rule.dimension),
    unit_version: rule.version,
    factor_to_base: rule.factor_to_base,
    dimension: rule.dimension,
  };
}

export function dimensionOf(unitRules, unit) {
  const rules = unitRules.filter((r) => r.unit === unit);
  if (!rules.length) throw new UnitError(`unknown unit "${unit}"`, 'UNIT_UNKNOWN', { unit });
  const dims = new Set(rules.map((r) => r.dimension));
  if (dims.size > 1) throw new UnitError(`unit "${unit}" appears in multiple dimensions`, 'UNIT_DIMENSION_AMBIGUOUS', { unit });
  return [...dims][0];
}

/** Re-express a base quantity in a target unit's current rule, for display. */
export function fromBase(qtyBase, targetUnit, unitRules, atIso) {
  const rule = ruleAt(unitRules, targetUnit, atIso);
  return { qty: round6(qtyBase / rule.factor_to_base), unit: targetUnit, unit_version: rule.version, factor_to_base: rule.factor_to_base };
}
