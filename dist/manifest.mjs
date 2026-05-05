import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/manifest.ts
var manifest = {
  id: "linkedin-poster",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "LinkedIn Poster",
  description: "Automated LinkedIn posting from a content calendar with image support",
  author: "SGNL Studio",
  categories: ["automation"],
  capabilities: [
    "jobs.schedule",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound"
  ],
  entrypoints: {
    worker: "dist/worker.mjs"
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      linkedinAccessToken: {
        type: "string",
        title: "LinkedIn Access Token",
        description: "OAuth access token with w_member_social scope"
      },
      linkedinPersonUrn: {
        type: "string",
        title: "LinkedIn Person URN",
        description: "Format: urn:li:person:XXXXXX"
      },
      postingWindowStartHour: {
        type: "number",
        title: "Posting window start (hour, ET)",
        default: 8
      },
      postingWindowEndHour: {
        type: "number",
        title: "Posting window end (hour, ET)",
        default: 17
      },
      dryRun: {
        type: "boolean",
        title: "Dry run mode",
        description: "Log what would be posted without actually posting",
        default: false
      }
    }
  },
  jobs: [
    {
      jobKey: "daily-post",
      displayName: "Daily LinkedIn Post",
      description: "Posts scheduled content from the calendar at a random time in the posting window",
      schedule: "0 12 * * *"
    }
  ]
};
var manifest_default = manifest;
export {
  manifest_default as default
};
//# sourceMappingURL=manifest.mjs.map
