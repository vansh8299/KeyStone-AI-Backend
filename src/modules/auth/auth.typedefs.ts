import gql from "graphql-tag";

export const authTypeDefs = gql`
  type AuthPayload {
    user: User!
  }

  "Sign-up succeeded; a verification code was emailed and must be confirmed with verifyEmail."
  type SignupPayload {
    email: String!
  }

  input VerifyEmailInput {
    email: String!
    code: String!
  }

  input ResetPasswordInput {
    email: String!
    code: String!
    newPassword: String!
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
    signup(input: SignupInput!): SignupPayload!
    verifyEmail(input: VerifyEmailInput!): AuthPayload!
    resendVerificationCode(email: String!): Boolean!
    "Fails with EMAIL_NOT_VERIFIED (extensions.email) when the account hasn't been verified; a new code is emailed."
    login(input: LoginInput!): AuthPayload!
    "Always returns true so it can't be used to discover which emails have accounts."
    requestPasswordReset(email: String!): Boolean!
    "Sets a new password using the emailed code and signs out every session."
    resetPassword(input: ResetPasswordInput!): Boolean!
    refreshToken: AuthPayload!
    logout: Boolean!
  }
`;