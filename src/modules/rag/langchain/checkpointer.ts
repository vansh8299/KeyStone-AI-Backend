import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import { env } from "../../../config/env";
import { getMongoClient } from "../../../lib/mongo";
import { moduleLogger } from "../../../lib/logger";

const log = moduleLogger("checkpointer");

const CHECKPOINT_TTL_SECONDS = 7 * 24 * 60 * 60;

let cached: Promise<MongoDBSaver> | null = null;

export function getCheckpointer(): Promise<MongoDBSaver> {
  if (!cached) {
    cached = (async () => {
      const client = await getMongoClient();
      const saver = new MongoDBSaver({
        client: client as unknown as ConstructorParameters<typeof MongoDBSaver>[0]["client"],
        dbName: env.mongodbDbName,
        checkpointCollectionName: "agent_checkpoints",
        checkpointWritesCollectionName: "agent_checkpoint_writes",
        ttl: CHECKPOINT_TTL_SECONDS,
      });
      const errors = await saver.setup();
      if (errors.length > 0) log.error({ errors }, "checkpointer index setup failed");
      return saver;
    })().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

export async function deleteAgentThread(threadId: string): Promise<void> {
  const saver = await getCheckpointer();
  await saver.deleteThread(threadId);
}
