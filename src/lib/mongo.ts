    import { MongoClient, Db } from "mongodb";
import { env } from "../config/env";

declare global {
  var __mongoClient: MongoClient | undefined;
}

const client = global.__mongoClient ?? new MongoClient(env.mongodbUri);

if (!env.isProd) {
  global.__mongoClient = client;
}

let connected = false;

export async function getMongoClient(): Promise<MongoClient> {
  if (!connected) {
    await client.connect();
    connected = true;
  }
  return client;
}

export async function getMongoDb(): Promise<Db> {
  return (await getMongoClient()).db(env.mongodbDbName);
}

export async function closeMongo(): Promise<void> {
  if (connected) {
    await client.close();
    connected = false;
  }
}
