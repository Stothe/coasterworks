import type { FormField, JsonSchemaObject } from "./types";

export type { FormField } from "./types";

/** The four properties that make a command take an area of tiles. */
export const RECT_KEYS = ["x", "y", "w", "h"] as const;

/** Bounds at or past this only mean the number has no practical limit (`z.int()` writes them). */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/**
 * Every keyword a property may carry for the form to render it. A property with any other, such as
 * `items`, `properties`, `anyOf`, `const` or `$ref`, is a shape the form cannot draw.
 *
 * The string keywords (`minLength`, `pattern`, `format`) are accepted without being checked: the
 * sim validates every command, and its message shows beside the form when the text is refused.
 */
const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "minimum",
  "maximum",
  "default",
  "enum",
  "description",
  "title",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "examples",
  "$comment",
]);

/** Keywords that make the object itself something other than a plain list of properties. */
const COMPOSITE_KEYWORDS = ["anyOf", "oneOf", "allOf", "not", "$ref"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `max_speed` and `maxSpeed` both become `Max speed`. */
export function humanize(text: string): string {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\s]+/)
    .filter((word) => word.length > 0)
    .join(" ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** True when the schema takes an area of tiles: integer `x`, `y`, `w` and `h`. */
export function isRectSchema(schema: JsonSchemaObject): boolean {
  const properties: unknown = schema.properties;
  if (!isRecord(properties)) return false;
  return RECT_KEYS.every((key) => {
    const property = properties[key];
    return isRecord(property) && property["type"] === "integer";
  });
}

/** The `default` of each property that has one, by property name. */
export function defaultsFromSchema(schema: JsonSchemaObject): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const properties: unknown = schema.properties;
  if (!isRecord(properties)) return defaults;
  for (const [name, property] of Object.entries(properties)) {
    if (isRecord(property) && "default" in property) defaults[name] = property["default"];
  }
  return defaults;
}

/** A number bound, or nothing when it is missing, not a number, or only "no limit". */
function boundOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) < UNBOUNDED
    ? value
    : undefined;
}

/** True for a property that holds an amount of money, which the sim counts in cents. */
function isMoney(name: string, description: string | undefined): boolean {
  return name === "amount" || /cents/i.test(name) || /\bcents\b/i.test(description ?? "");
}

/** The choices of an `enum`, or null if they are not all strings or all numbers. */
function optionsOf(values: unknown): FormField["options"] | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const strings = values.every((value) => typeof value === "string");
  const numbers = values.every((value) => typeof value === "number" && Number.isFinite(value));
  if (!strings && !numbers) return null;
  return values.map((value: string | number) => ({ value, label: String(value) }));
}

function fieldFor(name: string, property: unknown, required: boolean): FormField | null {
  if (!isRecord(property)) return null;
  if (Object.keys(property).some((keyword) => !SUPPORTED_KEYWORDS.has(keyword))) return null;

  const type = property["type"];
  if (type !== undefined && typeof type !== "string") return null;

  const description =
    typeof property["description"] === "string" ? property["description"] : undefined;
  const field: FormField = { name, label: humanize(name), kind: "string", required };
  if ("default" in property) field.defaultValue = property["default"];
  if (description !== undefined) field.description = description;

  if ("enum" in property) {
    const options = optionsOf(property["enum"]);
    if (!options) return null;
    // A declared type has to agree with the values, or the form would offer choices the sim refuses.
    const first = options[0]?.value;
    if (type === "string" && typeof first !== "string") return null;
    if ((type === "integer" || type === "number") && typeof first !== "number") return null;
    if (type !== undefined && !["string", "integer", "number"].includes(type)) return null;
    field.kind = "enum";
    field.options = options;
    return field;
  }

  switch (type) {
    case "integer":
    case "number": {
      field.kind = type;
      const min = boundOf(property["minimum"]);
      const max = boundOf(property["maximum"]);
      if (min !== undefined) field.min = min;
      if (max !== undefined) field.max = max;
      if (isMoney(name, description)) field.money = true;
      return field;
    }
    case "boolean":
      field.kind = "boolean";
      return field;
    case "string":
      return field;
    default:
      // No type, or one the form has no control for: an object, an array, null, or an unknown.
      return null;
  }
}

/**
 * The fields of a form for a command's input schema, in the schema's order, or null when the
 * generic form cannot render it (a nested object, an array, a union, an unknown type). A schema
 * with no properties has no fields: `[]`. The caller shows "needs the full UI" for null.
 */
export function fieldsFor(schema: JsonSchemaObject): FormField[] | null {
  if (!isRecord(schema)) return null;
  if (schema.type !== undefined && schema.type !== "object") return null;
  if (COMPOSITE_KEYWORDS.some((keyword) => keyword in schema)) return null;

  const properties: unknown = schema.properties;
  if (properties === undefined) return [];
  if (!isRecord(properties)) return null;

  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields: FormField[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const field = fieldFor(name, property, required.has(name));
    if (!field) return null;
    fields.push(field);
  }
  return fields;
}
