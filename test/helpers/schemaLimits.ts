// Counts what the API limits in a structured-output schema. A schema over a limit is rejected with
// a 400, and the pipeline would then hand every message to a person.

export const MAX_OPTIONAL_FIELDS = 24;
export const MAX_UNION_FIELDS = 16;

const UNSUPPORTED_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "maxItems",
];

type SchemaNode = Record<string, unknown>;

export interface SchemaCounts {
  /** Fields an object does not list as required. */
  optional: number;
  /** Fields that are nullable or a union: `anyOf`, or a list of types. */
  unions: number;
  /** Objects that allow keys the schema does not name. */
  openObjects: number;
  unsupportedKeywords: string[];
}

const isNode = (value: unknown): value is SchemaNode => value !== null && typeof value === "object" && !Array.isArray(value);

function visit(schema: SchemaNode, counts: SchemaCounts): void {
  if (Array.isArray(schema.type) || Array.isArray(schema.anyOf)) counts.unions += 1;

  if (schema.type === "object" || isNode(schema.properties)) {
    const properties = isNode(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    counts.optional += Object.keys(properties).filter((name) => !required.has(name)).length;
    if (schema.additionalProperties !== false) counts.openObjects += 1;
    for (const child of Object.values(properties)) if (isNode(child)) visit(child, counts);
  }

  for (const keyword of UNSUPPORTED_KEYWORDS) if (keyword in schema) counts.unsupportedKeywords.push(keyword);

  if (isNode(schema.items)) visit(schema.items, counts);
  for (const keyword of ["anyOf", "allOf", "oneOf"]) {
    const children = schema[keyword];
    if (Array.isArray(children)) for (const child of children) if (isNode(child)) visit(child, counts);
  }
  for (const keyword of ["$defs", "definitions"]) {
    const definitions = schema[keyword];
    if (isNode(definitions)) for (const child of Object.values(definitions)) if (isNode(child)) visit(child, counts);
  }
}

export function countSchema(schema: unknown): SchemaCounts {
  const counts: SchemaCounts = { optional: 0, unions: 0, openObjects: 0, unsupportedKeywords: [] };
  if (isNode(schema)) visit(schema, counts);
  return counts;
}
