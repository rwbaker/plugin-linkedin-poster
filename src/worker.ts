import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { LinkedInClient, RateLimitError } from './linkedin-client.js';
import { type ContentCalendar, type CalendarPost, getPostsDueNow, markPosted } from './calendar.js';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CALENDAR_STATE_KEY = 'content-calendar';
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 5000;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function computeRandomDelay(startHour: number, endHour: number): number {
  const windowMinutes = (endHour - startHour) * 60;
  return Math.floor(Math.random() * windowMinutes) * 60 * 1000;
}

async function resolveImageUrn(
  client: LinkedInClient,
  post: CalendarPost,
  dataDir: string,
): Promise<string | undefined> {
  if (!post.imagePath && !post.imageUrl) return undefined;

  if (post.imageUrl) {
    return client.uploadImageFromUrl(post.imageUrl);
  }

  const absPath = isAbsolute(post.imagePath!)
    ? post.imagePath!
    : resolve(dataDir, post.imagePath!);
  return client.uploadImage(absPath);
}

async function postWithRetry(
  client: LinkedInClient,
  post: CalendarPost,
  dataDir: string,
  attempt = 1,
): Promise<{ postId: string | null; status: number }> {
  try {
    const imageUrn = await resolveImageUrn(client, post, dataDir);
    return await client.createPost({ text: post.text, imageUrn });
  } catch (err: unknown) {
    const error = err as { statusCode?: number; retryAfterSeconds?: number };
    if (err instanceof RateLimitError && attempt < MAX_RETRIES) {
      const delay = Math.max(error.retryAfterSeconds! * 1000, RETRY_BASE_DELAY_MS * attempt);
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

const plugin = definePlugin({
  async setup(ctx) {
    const dataDir = resolve(__dirname, '..', 'data');

    ctx.data.register('calendar', async () => {
      const stored = await ctx.state.get({ scopeKind: 'instance', stateKey: CALENDAR_STATE_KEY });
      return stored ?? null;
    });

    ctx.data.register('health', async () => {
      const config = ctx.config as Record<string, unknown>;
      return {
        hasToken: !!config.linkedinAccessToken,
        hasPersonUrn: !!config.linkedinPersonUrn,
        dryRun: !!config.dryRun,
      };
    });

    ctx.actions.register('import-calendar', async (params) => {
      const calendarJson = params.calendar as ContentCalendar;
      if (!calendarJson?.posts || !Array.isArray(calendarJson.posts)) {
        throw new Error('Invalid calendar format: must have a "posts" array');
      }
      await ctx.state.set(
        { scopeKind: 'instance', stateKey: CALENDAR_STATE_KEY },
        calendarJson,
      );
      return { imported: calendarJson.posts.length };
    });

    ctx.actions.register('post-now', async () => {
      const config = ctx.config as Record<string, string | number | boolean>;
      if (!config.linkedinAccessToken || !config.linkedinPersonUrn) {
        throw new Error('LinkedIn credentials not configured');
      }

      const stored = await ctx.state.get({ scopeKind: 'instance', stateKey: CALENDAR_STATE_KEY });
      if (!stored) throw new Error('No calendar loaded. Import one first.');

      const calendar = stored as ContentCalendar;
      const duePosts = getPostsDueNow(calendar);
      if (duePosts.length === 0) return { message: 'No posts scheduled for today.' };

      const client = new LinkedInClient({
        accessToken: config.linkedinAccessToken as string,
        personUrn: config.linkedinPersonUrn as string,
      });

      const results = { posted: 0, failed: 0, errors: [] as { postId: string; error: string }[] };

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
        } catch (err: unknown) {
          results.failed++;
          results.errors.push({ postId: post.id, error: (err as Error).message });
          ctx.logger.error(`Failed to post "${post.id}": ${(err as Error).message}`);
        }
      }

      await ctx.state.set(
        { scopeKind: 'instance', stateKey: CALENDAR_STATE_KEY },
        calendar,
      );

      return results;
    });

    ctx.jobs.register('daily-post', async (job) => {
      const config = ctx.config as Record<string, string | number | boolean>;
      ctx.logger.info('Daily post job triggered', { runId: job.runId, trigger: job.trigger });

      if (!config.linkedinAccessToken || !config.linkedinPersonUrn) {
        ctx.logger.warn('LinkedIn credentials not configured — skipping');
        return;
      }

      const stored = await ctx.state.get({ scopeKind: 'instance', stateKey: CALENDAR_STATE_KEY });
      if (!stored) {
        ctx.logger.warn('No calendar loaded — skipping');
        return;
      }

      const calendar = stored as ContentCalendar;
      const duePosts = getPostsDueNow(calendar);

      if (duePosts.length === 0) {
        ctx.logger.info('No posts scheduled for today.');
        return;
      }

      ctx.logger.info(`Found ${duePosts.length} post(s) scheduled for today.`);

      const startHour = (config.postingWindowStartHour as number) ?? 8;
      const endHour = (config.postingWindowEndHour as number) ?? 17;
      const delayMs = computeRandomDelay(startHour, endHour);
      const postTime = new Date(Date.now() + delayMs);
      ctx.logger.info(`Random delay: ${Math.round(delayMs / 60000)} minutes. Posting around ${postTime.toISOString()}`);

      if (!config.dryRun) {
        await sleep(delayMs);
      }

      const client = new LinkedInClient({
        accessToken: config.linkedinAccessToken as string,
        personUrn: config.linkedinPersonUrn as string,
      });

      const results = { posted: 0, failed: 0, errors: [] as { postId: string; error: string }[] };

      for (const post of duePosts) {
        try {
          if (config.dryRun) {
            const hasImage = post.imagePath || post.imageUrl ? ' [with image]' : '';
            ctx.logger.info(`[DRY RUN] Would post: "${post.text.substring(0, 80)}..."${hasImage}`);
            continue;
          }

          const result = await postWithRetry(client, post, dataDir);
          markPosted(post, result.postId);
          results.posted++;
          ctx.logger.info(`Posted successfully: ${result.postId}`);
        } catch (err: unknown) {
          results.failed++;
          results.errors.push({ postId: post.id, error: (err as Error).message });
          ctx.logger.error(`Failed to post "${post.id}": ${(err as Error).message}`);
        }
      }

      await ctx.state.set(
        { scopeKind: 'instance', stateKey: CALENDAR_STATE_KEY },
        calendar,
      );

      ctx.logger.info(`Job complete. Posted: ${results.posted}, Failed: ${results.failed}`);

      if (results.failed > 0) {
        throw new Error(`${results.failed} post(s) failed: ${JSON.stringify(results.errors)}`);
      }
    });
  },

  async onHealth() {
    return { status: 'ok', message: 'LinkedIn Poster plugin running' };
  },

  async onValidateConfig(config: Record<string, unknown>) {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!config.linkedinAccessToken) {
      errors.push('LinkedIn Access Token is required');
    }
    if (!config.linkedinPersonUrn) {
      errors.push('LinkedIn Person URN is required');
    } else if (typeof config.linkedinPersonUrn === 'string' && !config.linkedinPersonUrn.startsWith('urn:li:')) {
      errors.push('Person URN must start with urn:li:person: or urn:li:organization:');
    }

    const start = (config.postingWindowStartHour as number) ?? 8;
    const end = (config.postingWindowEndHour as number) ?? 17;
    if (start >= end) {
      errors.push('Posting window start hour must be before end hour');
    }

    if (config.dryRun) {
      warnings.push('Dry run mode is enabled — posts will not actually be published');
    }

    return { ok: errors.length === 0, errors, warnings };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
