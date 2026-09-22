import gql from "graphql-tag";

export const authTypeDefs = gql`
  type AuthPayload {
    user: User!
  }

  input SignupInput {
    email: String!
    password: String!
    name: String
  }

  input LoginInput {
    email: String!
    password: String!
  }

  extend type Mutation {
    signup(input: SignupInput!): AuthPayload!
    login(input: LoginInput!): AuthPayload!
    refreshToken: AuthPayload!
    logout: Boolean!
  }
`;