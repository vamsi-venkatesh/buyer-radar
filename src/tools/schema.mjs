// A very small JSON Schema validator, for the tool registry and nothing else.
//
// It exists because the tools are the surface an agent - ours or somebody
// else's over MCP - calls without a human reading the arguments first. A tool
// that takes whatever it is handed and then fails somewhere inside its handler
// produces a confusing error at best and a wrong write at worst. Bad input is
// refused here, before the handler runs, with the field named.
//
// The subset supported is exactly what the registry's schemas use:
// type (object, array, string, number, integer, boolean, null, or a list of
// those), properties, required, additionalProperties: false, enum, default,
// minimum / maximum, minLength / maxLength, minItems / maxItems, items.
// Anything else in a schema is ignored rather than silently trusted, so a
// keyword added to a schema without support here never reads as a check that
// passed.

const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function at(path, key) {
  return path ? `${path}.${key}` : String(key);
}

/**
 * Validate `value` against `schema`. Returns { ok, value, errors }.
 *
 * `value` on a successful validation is a *copy* with defaults filled in, so a
 * handler reads one shape whether or not the caller sent the optional fields.
 * Defaults are never written back onto the caller's object.
 */
export function validate(value, schema, path = '') {
  const errors = [];
  const out = check(value, schema, path, errors);
  return errors.length ? { ok: false, value: undefined, errors } : { ok: true, value: out, errors: [] };
}

function check(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return value;

  if (value === undefined && 'default' in schema) value = clone(schema.default);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const t of types) {
      if (!TYPES.includes(t)) {
        errors.push(`${path || 'value'}: schema uses unsupported type ${JSON.stringify(t)}`);
        return value;
      }
    }
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path || 'value'}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return value;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    errors.push(`${path || 'value'}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    return value;
  }

  const kind = typeOf(value);

  if (kind === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path || 'value'}: is ${value.length} characters, under the minimum ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path || 'value'}: is ${value.length} characters, over the maximum ${schema.maxLength}`);
    }
  }

  if (kind === 'number' || kind === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path || 'value'}: ${value} is below the minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path || 'value'}: ${value} is above the maximum ${schema.maximum}`);
    }
  }

  if (kind === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path || 'value'}: has ${value.length} items, under the minimum ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path || 'value'}: has ${value.length} items, over the maximum ${schema.maxItems}`);
    }
    if (schema.items) return value.map((v, i) => check(v, schema.items, at(path, i), errors));
    return value.slice();
  }

  if (kind === 'object') {
    const props = schema.properties || {};
    const out = {};
    for (const key of Object.keys(value)) {
      if (!(key in props)) {
        if (schema.additionalProperties === false) {
          errors.push(`${path || 'value'}: unknown field ${JSON.stringify(key)}`);
          continue;
        }
        out[key] = value[key];
        continue;
      }
      if (value[key] === undefined) continue;
      out[key] = check(value[key], props[key], at(path, key), errors);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in out) continue;
      if (sub && typeof sub === 'object' && 'default' in sub) out[key] = clone(sub.default);
    }
    for (const key of schema.required || []) {
      if (out[key] === undefined) errors.push(`${path || 'value'}: ${JSON.stringify(key)} is required`);
    }
    return out;
  }

  return value;
}

function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v));
}
