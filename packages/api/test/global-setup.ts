import type { TestProject } from "vitest/node";
import { createMigratedTempDatabase, dropTempDatabase, redisUrl } from "@linklens/db/testing";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const url = await createMigratedTempDatabase();
  project.provide("databaseUrl", url);
  project.provide("redisUrl", redisUrl());
  return () => dropTempDatabase(url);
}
