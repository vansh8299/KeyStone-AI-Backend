import { GraphQLScalarType, Kind } from "graphql";

export const DateTimeScalar = new GraphQLScalarType({
  name: "DateTime",
  description: "ISO-8601 DateTime scalar",
  serialize(value) {
    return value instanceof Date ? value.toISOString() : value;
  },
  parseValue(value) {
    return new Date(value as string);
  },
  parseLiteral(ast) {
    if (ast.kind === Kind.STRING) {
      return new Date(ast.value);
    }
    return null;
  },
});

export const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  description: "Arbitrary JSON value scalar",
  serialize(value) {
    return value;
  },
  parseValue(value) {
    return value;
  },
  parseLiteral(ast) {
    return parseLiteralValue(ast);
  },
});

function parseLiteralValue(ast: any): any {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return parseFloat(ast.value);
    case Kind.OBJECT: {
      const value: Record<string, any> = {};
      ast.fields.forEach((field: any) => {
        value[field.name.value] = parseLiteralValue(field.value);
      });
      return value;
    }
    case Kind.LIST:
      return ast.values.map(parseLiteralValue);
    case Kind.NULL:
      return null;
    default:
      return null;
  }
}