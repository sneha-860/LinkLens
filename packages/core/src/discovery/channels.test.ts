import { describe, expect, it } from "vitest";
import { DISCOVERY_CHANNELS } from "./channels.js";

describe("DISCOVERY_CHANNELS", () => {
  it("lists the six channels in the order the spec gives them", () => {
    // Must match the discovery_observations.channel CHECK constraint (migration 1).
    expect(DISCOVERY_CHANNELS).toEqual([
      "link_graph",
      "xml_sitemap",
      "robots_sitemap",
      "html_sitemap",
      "feed",
      "llms_txt",
    ]);
  });
});
