import {
  GraphQLError,
  Kind,
  type ASTNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
} from "graphql";

const MAX_DEPTH = 8;
const MAX_FIELDS = 300;

function reject(context: ValidationContext, message: string, node: ASTNode) {
  context.reportError(new GraphQLError(message, { nodes: [node], extensions: { code: "BAD_USER_INPUT" } }));
}

export const queryLimitsRule: ValidationRule = (context) => {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of context.getDocument().definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
  }

  return {
    OperationDefinition(operation) {
      let fields = 0;
      let tooDeep = false;

      const walk = (selectionSet: SelectionSetNode, depth: number, seenFragments: Set<string>) => {
        for (const selection of selectionSet.selections) {
          if (tooDeep || fields > MAX_FIELDS) return;
          if (selection.kind === Kind.FIELD) {
            fields++;
            if (!selection.selectionSet) continue;
            if (depth + 1 > MAX_DEPTH) {
              tooDeep = true;
              return;
            }
            walk(selection.selectionSet, depth + 1, seenFragments);
          } else if (selection.kind === Kind.INLINE_FRAGMENT) {
            walk(selection.selectionSet, depth, seenFragments);
          } else {
            const name = selection.name.value;
            const fragment = fragments.get(name);
            if (!fragment || seenFragments.has(name)) continue;
            walk(fragment.selectionSet, depth, new Set(seenFragments).add(name));
          }
        }
      };
      walk(operation.selectionSet, 0, new Set());

      if (tooDeep) reject(context, `This query is nested too deeply (max ${MAX_DEPTH} levels).`, operation);
      else if (fields > MAX_FIELDS) reject(context, `This query asks for too many fields (max ${MAX_FIELDS}).`, operation);
    },
  };
};
