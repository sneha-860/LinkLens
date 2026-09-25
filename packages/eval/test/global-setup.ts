import type { TestProject } from "vitest/node";
import { createMigratedTempDatabase, dropTempDatabase } from "@linklens/db/testing";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const url = await createMigratedTempDatabase();
  project.provide("databaseUrl", url);
  return () => dropTempDatabase(url);
}
