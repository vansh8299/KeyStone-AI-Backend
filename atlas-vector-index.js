const openaiIndexDefinition = {
  fields: [
    {
      type: "vector",
      path: "embedding",
      numDimensions: 1536,
      similarity: "cosine",
    },
    { type: "filter", path: "documentId" },
  ],
};

const geminiIndexDefinition = {
  fields: [
    {
      type: "vector",
      path: "embedding",
      numDimensions: 3072,
      similarity: "cosine",
    },
    { type: "filter", path: "documentId" },
  ],
};
module.exports = { openaiIndexDefinition, geminiIndexDefinition };
