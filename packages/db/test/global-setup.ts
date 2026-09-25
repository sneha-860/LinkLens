import type { TestProject } from "vitest/node";
import { migrate } from "../src/migrate.js";
import { createTempDatabase, dropTempDatabase } from "./helpers.js";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const url = await createTempDatabase();
  await migrate(url, "up");
  project.provide("databaseUrl", url);
  return () => dropTempDatabase(url);
}
