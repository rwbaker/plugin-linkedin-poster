import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/worker.ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

// src/linkedin-client.ts
import { readFile } from "node:fs/promises";
var LINKEDIN_API_BASE = "https://api.linkedin.com/rest";
var LinkedInApiError = class extends Error {
  statusCode;
  constructor(message, statusCode) {
    super(message);
    this.name = "LinkedInApiError";
    this.statusCode = statusCode;
  }
};
var RateLimitError = class extends LinkedInApiError {
  retryAfterSeconds;
  constructor(message, retryAfterSeconds) {
    super(message, 429);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
};
var LinkedInClient = class {
  accessToken;
  personUrn;
  constructor({ accessToken, personUrn }) {
    if (!accessToken) throw new Error("accessToken is required");
    if (!personUrn) throw new Error("personUrn is required");
    this.accessToken = accessToken;
    this.personUrn = personUrn;
  }
  headers(contentType = "application/json") {
    const h = {
      Authorization: `Bearer ${this.accessToken}`,
      "LinkedIn-Version": "202505"
    };
    if (contentType) h["Content-Type"] = contentType;
    return h;
  }
  handleRateLimit(res) {
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after") || "60";
      throw new RateLimitError(`Rate limited. Retry after ${retryAfter}s`, Number(retryAfter));
    }
  }
  async initializeImageUpload() {
    const res = await fetch(`${LINKEDIN_API_BASE}/images?action=initializeUpload`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        initializeUploadRequest: { owner: this.personUrn }
      })
    });
    this.handleRateLimit(res);
    if (!res.ok) {
      const errorBody = await res.text();
      throw new LinkedInApiError(`Image upload init failed ${res.status}: ${errorBody}`, res.status);
    }
    const data = await res.json();
    return { uploadUrl: data.value.uploadUrl, imageUrn: data.value.image };
  }
  async uploadImageBinary(uploadUrl, imageBuffer) {
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/octet-stream"
      },
      body: imageBuffer
    });
    this.handleRateLimit(res);
    if (!res.ok) {
      const errorBody = await res.text();
      throw new LinkedInApiError(`Image binary upload failed ${res.status}: ${errorBody}`, res.status);
    }
  }
  async uploadImage(imagePath) {
    const imageBuffer = await readFile(imagePath);
    const { uploadUrl, imageUrn } = await this.initializeImageUpload();
    await this.uploadImageBinary(uploadUrl, Buffer.from(imageBuffer));
    return imageUrn;
  }
  async uploadImageFromUrl(imageUrl) {
    const res = await fetch(imageUrl);
    if (!res.ok) {
      throw new LinkedInApiError(`Failed to fetch image from ${imageUrl}: ${res.status}`, res.status);
    }
    const imageBuffer = Buffer.from(await res.arrayBuffer());
    const { uploadUrl, imageUrn } = await this.initializeImageUpload();
    await this.uploadImageBinary(uploadUrl, imageBuffer);
    return imageUrn;
  }
  async createPost({ text, imageUrn, visibility = "PUBLIC" }) {
    const body = {
      author: this.personUrn,
      commentary: text,
      visibility,
      distribution: { feedDistribution: "MAIN_FEED" },
      lifecycleState: "PUBLISHED"
    };
    if (imageUrn) {
      body.content = {
        media: { id: imageUrn }
      };
    }
    const res = await fetch(`${LINKEDIN_API_BASE}/posts`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body)
    });
    this.handleRateLimit(res);
    if (!res.ok) {
      const errorBody = await res.text();
      throw new LinkedInApiError(`LinkedIn API error ${res.status}: ${errorBody}`, res.status);
    }
    const postId = res.headers.get("x-restli-id") || res.headers.get("X-RestLi-Id");
    return { postId, status: res.status };
  }
  async verifyToken() {
    const res = await fetch(`${LINKEDIN_API_BASE}/posts?author=${encodeURIComponent(this.personUrn)}&count=1`, {
      headers: this.headers(null)
    });
    if (!res.ok) {
      throw new LinkedInApiError(`Token verification failed: ${res.status}`, res.status);
    }
    return res.json();
  }
};

// src/calendar.ts
function getPostsDueNow(calendar, now = /* @__PURE__ */ new Date()) {
  const todayStr = formatDate(now);
  return calendar.posts.filter((post) => {
    if (post.status === "posted") return false;
    if (!post.scheduledDate) return false;
    return post.scheduledDate === todayStr;
  });
}
function markPosted(post, postId) {
  post.status = "posted";
  post.postedAt = (/* @__PURE__ */ new Date()).toISOString();
  if (postId) post.linkedinPostId = postId;
}
function formatDate(date) {
  return date.toISOString().split("T")[0];
}

// src/worker.ts
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
var __dirname = dirname(fileURLToPath(import.meta.url));
var CALENDAR_STATE_KEY = "content-calendar";
var MAX_RETRIES = 3;
var RETRY_BASE_DELAY_MS = 5e3;
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function computeRandomDelay(startHour, endHour) {
  const windowMinutes = (endHour - startHour) * 60;
  return Math.floor(Math.random() * windowMinutes) * 60 * 1e3;
}
async function resolveImageUrn(client, post, dataDir) {
  if (!post.imagePath && !post.imageUrl) return void 0;
  if (post.imageUrl) {
    return client.uploadImageFromUrl(post.imageUrl);
  }
  const absPath = isAbsolute(post.imagePath) ? post.imagePath : resolve(dataDir, post.imagePath);
  return client.uploadImage(absPath);
}
async function postWithRetry(client, post, dataDir, attempt = 1) {
  try {
    const imageUrn = await resolveImageUrn(client, post, dataDir);
    return await client.createPost({ text: post.text, imageUrn });
  } catch (err) {
    const error = err;
    if (err instanceof RateLimitError && attempt < MAX_RETRIES) {
      const delay = Math.max(error.retryAfterSeconds * 1e3, RETRY_BASE_DELAY_MS * attempt);
      await sleep(delay);
      return postWithRetry(client, post, dataDir, attempt + 1);
    }
    if (error.statusCode && error.statusCode >= 500 && attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * attempt;
      await sleep(delay);
      return postWithRetry(client, post, dataDir, attempt + 1);
    }
    throw err;
  }
}
var plugin = definePlugin({
  async setup(ctx) {
    const dataDir = resolve(__dirname, "..", "data");
    ctx.data.register("calendar", async () => {
      const stored = await ctx.state.get({ scopeKind: "instance", stateKey: CALENDAR_STATE_KEY });
      return stored ?? null;
    });
    ctx.data.register("health", async () => {
      const config = ctx.config;
      return {
        hasToken: !!config.linkedinAccessToken,
        hasPersonUrn: !!config.linkedinPersonUrn,
        dryRun: !!config.dryRun
      };
    });
    ctx.actions.register("import-calendar", async (params) => {
      const calendarJson = params.calendar;
      if (!calendarJson?.posts || !Array.isArray(calendarJson.posts)) {
        throw new Error('Invalid calendar format: must have a "posts" array');
      }
      await ctx.state.set(
        { scopeKind: "instance", stateKey: CALENDAR_STATE_KEY },
        calendarJson
      );
      return { imported: calendarJson.posts.length };
    });
    ctx.actions.register("post-now", async () => {
      const config = ctx.config;
      if (!config.linkedinAccessToken || !config.linkedinPersonUrn) {
        throw new Error("LinkedIn credentials not configured");
      }
      const stored = await ctx.state.get({ scopeKind: "instance", stateKey: CALENDAR_STATE_KEY });
      if (!stored) throw new Error("No calendar loaded. Import one first.");
      const calendar = stored;
      const duePosts = getPostsDueNow(calendar);
      if (duePosts.length === 0) return { message: "No posts scheduled for today." };
      const client = new LinkedInClient({
        accessToken: config.linkedinAccessToken,
        personUrn: config.linkedinPersonUrn
      });
      const results = { posted: 0, failed: 0, errors: [] };
      for (const post of duePosts) {
        try {
          if (config.dryRun) {
            ctx.logger.info(`[DRY RUN] Would post: "${post.text.substring(0, 80)}..."`);
            continue;
          }
          const result = await postWithRetry(client, post, dataDir);
          markPosted(post, result.postId);
          results.posted++;
          ctx.logger.info(`Posted successfully: ${result.postId}`);
        } catch (err) {
          results.failed++;
          results.errors.push({ postId: post.id, error: err.message });
          ctx.logger.error(`Failed to post "${post.id}": ${err.message}`);
        }
      }
      await ctx.state.set(
        { scopeKind: "instance", stateKey: CALENDAR_STATE_KEY },
        calendar
      );
      return results;
    });
    ctx.jobs.register("daily-post", async (job) => {
      const config = ctx.config;
      ctx.logger.info("Daily post job triggered", { runId: job.runId, trigger: job.trigger });
      if (!config.linkedinAccessToken || !config.linkedinPersonUrn) {
        ctx.logger.warn("LinkedIn credentials not configured \u2014 skipping");
        return;
      }
      const stored = await ctx.state.get({ scopeKind: "instance", stateKey: CALENDAR_STATE_KEY });
      if (!stored) {
        ctx.logger.warn("No calendar loaded \u2014 skipping");
        return;
      }
      const calendar = stored;
      const duePosts = getPostsDueNow(calendar);
      if (duePosts.length === 0) {
        ctx.logger.info("No posts scheduled for today.");
        return;
      }
      ctx.logger.info(`Found ${duePosts.length} post(s) scheduled for today.`);
      const startHour = config.postingWindowStartHour ?? 8;
      const endHour = config.postingWindowEndHour ?? 17;
      const delayMs = computeRandomDelay(startHour, endHour);
      const postTime = new Date(Date.now() + delayMs);
      ctx.logger.info(`Random delay: ${Math.round(delayMs / 6e4)} minutes. Posting around ${postTime.toISOString()}`);
      if (!config.dryRun) {
        await sleep(delayMs);
      }
      const client = new LinkedInClient({
        accessToken: config.linkedinAccessToken,
        personUrn: config.linkedinPersonUrn
      });
      const results = { posted: 0, failed: 0, errors: [] };
      for (const post of duePosts) {
        try {
          if (config.dryRun) {
            const hasImage = post.imagePath || post.imageUrl ? " [with image]" : "";
            ctx.logger.info(`[DRY RUN] Would post: "${post.text.substring(0, 80)}..."${hasImage}`);
            continue;
          }
          const result = await postWithRetry(client, post, dataDir);
          markPosted(post, result.postId);
          results.posted++;
          ctx.logger.info(`Posted successfully: ${result.postId}`);
        } catch (err) {
          results.failed++;
          results.errors.push({ postId: post.id, error: err.message });
          ctx.logger.error(`Failed to post "${post.id}": ${err.message}`);
        }
      }
      await ctx.state.set(
        { scopeKind: "instance", stateKey: CALENDAR_STATE_KEY },
        calendar
      );
      ctx.logger.info(`Job complete. Posted: ${results.posted}, Failed: ${results.failed}`);
      if (results.failed > 0) {
        throw new Error(`${results.failed} post(s) failed: ${JSON.stringify(results.errors)}`);
      }
    });
  },
  async onHealth() {
    return { status: "ok", message: "LinkedIn Poster plugin running" };
  },
  async onValidateConfig(config) {
    const errors = [];
    const warnings = [];
    if (!config.linkedinAccessToken) {
      errors.push("LinkedIn Access Token is required");
    }
    if (!config.linkedinPersonUrn) {
      errors.push("LinkedIn Person URN is required");
    } else if (typeof config.linkedinPersonUrn === "string" && !config.linkedinPersonUrn.startsWith("urn:li:")) {
      errors.push("Person URN must start with urn:li:person: or urn:li:organization:");
    }
    const start = config.postingWindowStartHour ?? 8;
    const end = config.postingWindowEndHour ?? 17;
    if (start >= end) {
      errors.push("Posting window start hour must be before end hour");
    }
    if (config.dryRun) {
      warnings.push("Dry run mode is enabled \u2014 posts will not actually be published");
    }
    return { ok: errors.length === 0, errors, warnings };
  }
});
var worker_default = plugin;
runWorker(plugin, import.meta.url);
export {
  worker_default as default
};
//# sourceMappingURL=worker.mjs.map
