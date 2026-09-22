import gql from "graphql-tag";

export const feedbackTypeDefs = gql`
  enum FeedbackRating {
    LIKE
    DISLIKE
  }

  "Quick-pick reasons for a dislike."
  enum FeedbackCategory {
    not_accurate
    not_helpful
    incomplete
    didnt_follow_instructions
    unsafe_or_offensive
    other
  }

  "The user's thumbs up / down on an assistant response."
  type MessageFeedback {
    rating: FeedbackRating!
    "Only for DISLIKE; empty otherwise."
    categories: [FeedbackCategory!]!
    "Optional free-text reason (DISLIKE only)."
    reason: String
    updatedAt: DateTime!
  }

  extend type Message {
    "The user's feedback on this response; null if none (always null for user messages)."
    feedback: MessageFeedback
  }

  extend type Mutation {
    """
    Likes or dislikes one of your assistant responses; rating null removes the feedback. For a
    dislike, categories and reason are optional (a dislike can be saved first and the reason
    added with a second call). Returns the updated message.
    """
    setMessageFeedback(
      messageId: ID!
      rating: FeedbackRating
      categories: [FeedbackCategory!]
      reason: String
    ): Message!
  }
`;
