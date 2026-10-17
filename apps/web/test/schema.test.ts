// @vitest-environment node
import { createDefaultRegistry } from "@coasterworks/sim";
import { describe, expect, it } from "vitest";
import { defaultsFromSchema, fieldsFor, isRectSchema } from "../src/actions/schema";
import type { JsonSchemaObject } from "../src/actions/types";

const catalog = createDefaultRegistry().catalog();
const schemaOf = (name: string) => {
  const entry = catalog.find((e) => e.name === name);
  if (!entry) throw new Error(`${name} is not in the catalog`);
  return entry.inputSchema as JsonSchemaObject;
};

/** A schema the way a caller would write one, which may hold more than the typed subset. */
const schema = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", properties, required }) as JsonSchemaObject;

describe("fieldsFor", () => {
  it("renders the loan amount as one required integer money field with the sim's bounds", () => {
    expect(fieldsFor(schemaOf("finance_take_loan"))).toEqual([
      {
        name: "amount",
        label: "Amount",
        kind: "integer",
        min: 100,
        max: 5_000_000,
        required: true,
        money: true,
      },
    ]);
  });

  it("also treats repaying a loan as money", () => {
    const [field] = fieldsFor(schemaOf("finance_repay_loan")) ?? [];
    expect(field).toMatchObject({ name: "amount", kind: "integer", min: 1, money: true });
  });

  it("keeps defaults and marks a defaulted property as not required", () => {
    const fields = fieldsFor(schemaOf("terrain_raise"));
    expect(fields?.map((f) => [f.name, f.required])).toEqual([
      ["x", true],
      ["y", true],
      ["w", true],
      ["h", true],
      ["steps", false],
    ]);
    expect(fields?.find((f) => f.name === "steps")).toMatchObject({
      kind: "integer",
      min: 1,
      max: 8,
      defaultValue: 1,
    });
  });

  it("drops a bound so wide it only means the number is unbounded", () => {
    const [x] = fieldsFor(schemaOf("terrain_raise")) ?? [];
    expect(x).toMatchObject({ name: "x", min: 0 });
    expect(x).not.toHaveProperty("max");
  });

  it("can render every command the sim has today", () => {
    for (const entry of catalog) {
      expect(fieldsFor(entry.inputSchema as JsonSchemaObject), entry.name).not.toBeNull();
    }
  });

  it("returns no fields for a command that takes nothing", () => {
    expect(fieldsFor(schemaOf("catalog_list"))).toEqual([]);
    expect(fieldsFor({ type: "object" })).toEqual([]);
  });

  it("renders number, boolean and string properties", () => {
    const fields = fieldsFor(
      schema(
        {
          rate: { type: "number", minimum: 0.5, maximum: 2, default: 1, description: "Speed." },
          open: { type: "boolean", default: true },
          note: { type: "string", description: "Anything." },
        },
        ["rate", "note"],
      ),
    );
    expect(fields).toEqual([
      {
        name: "rate",
        label: "Rate",
        kind: "number",
        min: 0.5,
        max: 2,
        defaultValue: 1,
        required: true,
        description: "Speed.",
      },
      { name: "open", label: "Open", kind: "boolean", defaultValue: true, required: false },
      { name: "note", label: "Note", kind: "string", required: true, description: "Anything." },
    ]);
  });

  it("renders a string enum as choices", () => {
    const [field] =
      fieldsFor(schema({ colour: { type: "string", enum: ["red", "green"] } }, ["colour"])) ?? [];
    expect(field).toEqual({
      name: "colour",
      label: "Colour",
      kind: "enum",
      options: [
        { value: "red", label: "red" },
        { value: "green", label: "green" },
      ],
      required: true,
    });
  });

  it("renders an enum of numbers, with or without a type, as choices that keep their numbers", () => {
    for (const property of [{ type: "integer", enum: [0, 1, 4] }, { enum: [0, 1, 4] }]) {
      const [field] = fieldsFor(schema({ surface: property })) ?? [];
      expect(field?.kind).toBe("enum");
      expect(field?.options).toEqual([
        { value: 0, label: "0" },
        { value: 1, label: "1" },
        { value: 4, label: "4" },
      ]);
    }
  });

  it("humanizes names into labels", () => {
    const fields = fieldsFor(
      schema({ max_speed: { type: "integer" }, maxHeight: { type: "integer" } }),
    );
    expect(fields?.map((f) => f.label)).toEqual(["Max speed", "Max height"]);
  });

  it("marks money by name or by a description that says cents", () => {
    const fields = fieldsFor(
      schema({
        amount: { type: "integer" },
        price: { type: "integer", description: "The price in cents." },
        days: { type: "integer", description: "A number of days." },
      }),
    );
    expect(fields?.map((f) => [f.name, f.money === true])).toEqual([
      ["amount", true],
      ["price", true],
      ["days", false],
    ]);
  });

  // Review Focus 1: a schema the form cannot render must come back as null, never as a crash or a
  // half-rendered form.
  it("returns null for a nested object", () => {
    expect(
      fieldsFor(
        schema({
          origin: { type: "object", properties: { x: { type: "integer" } } },
        }),
      ),
    ).toBeNull();
  });

  it("returns null for an array, a union, a reference, a constant or an unknown type", () => {
    const unsupported: unknown[] = [
      { type: "array", items: { type: "integer" } },
      { anyOf: [{ type: "integer" }, { type: "string" }] },
      { oneOf: [{ type: "integer" }] },
      { $ref: "#/$defs/thing" },
      { type: "string", const: "only" },
      { type: "null" },
      { type: ["integer", "null"] },
      { type: "mystery" },
      {},
    ];
    for (const property of unsupported) {
      expect(fieldsFor(schema({ field: property })), JSON.stringify(property)).toBeNull();
    }
  });

  it("returns null when only one of several properties is unsupported", () => {
    expect(
      fieldsFor(schema({ days: { type: "integer" }, tags: { type: "array", items: {} } })),
    ).toBeNull();
  });

  it("returns null for an enum that is not all strings or all numbers", () => {
    expect(fieldsFor(schema({ pick: { enum: [1, "two"] } }))).toBeNull();
    expect(fieldsFor(schema({ pick: { enum: [{ a: 1 }] } }))).toBeNull();
    expect(fieldsFor(schema({ pick: { enum: [] } }))).toBeNull();
  });

  it("returns null for a schema that is not an object", () => {
    expect(fieldsFor({ type: "array" } as JsonSchemaObject)).toBeNull();
    expect(fieldsFor({ type: "object", properties: [] } as unknown as JsonSchemaObject)).toBeNull();
  });
});

describe("isRectSchema", () => {
  it("is true for the terrain commands that take an area", () => {
    for (const name of [
      "terrain_raise",
      "terrain_lower",
      "terrain_level",
      "terrain_smooth",
      "terrain_set_surface",
      "terrain_set_water",
    ]) {
      expect(isRectSchema(schemaOf(name)), name).toBe(true);
    }
  });

  it("is false for the rest", () => {
    expect(isRectSchema(schemaOf("finance_take_loan"))).toBe(false);
    expect(isRectSchema(schemaOf("sim_advance"))).toBe(false);
    expect(isRectSchema({ type: "object" })).toBe(false);
  });

  it("needs all four of x, y, w and h, and each an integer", () => {
    const int = { type: "integer" };
    expect(isRectSchema(schema({ x: int, y: int, w: int }))).toBe(false);
    expect(isRectSchema(schema({ x: int, y: int, w: int, h: { type: "number" } }))).toBe(false);
    expect(isRectSchema(schema({ x: int, y: int, w: int, h: int }))).toBe(true);
  });
});

describe("defaultsFromSchema", () => {
  it("collects the default of each property that has one", () => {
    expect(defaultsFromSchema(schemaOf("terrain_raise"))).toEqual({ steps: 1 });
    expect(defaultsFromSchema(schemaOf("terrain_level"))).toEqual({});
    expect(defaultsFromSchema({ type: "object" })).toEqual({});
  });
});
