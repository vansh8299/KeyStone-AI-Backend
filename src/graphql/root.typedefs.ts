import gql from "graphql-tag";

export const rootTypeDefs = gql`
  scalar DateTime
  scalar JSON

  type Mutation

  type Subscription
`;