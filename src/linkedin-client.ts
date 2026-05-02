import { readFile } from 'node:fs/promises';

const LINKEDIN_API_BASE = 'https://api.linkedin.com/rest';

export class LinkedInApiError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'LinkedInApiError';
    this.statusCode = statusCode;
  }
}

export class RateLimitError extends LinkedInApiError {
  retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super(message, 429);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface CreatePostOptions {
  text: string;
  imageUrn?: string;
  visibility?: string;
}

export class LinkedInClient {
  private accessToken: string;
  private personUrn: string;

  constructor({ accessToken, personUrn }: { accessToken: string; personUrn: string }) {
    if (!accessToken) throw new Error('accessToken is required');
    if (!personUrn) throw new Error('personUrn is required');
    this.accessToken = accessToken;
    this.personUrn = personUrn;
  }

  private headers(contentType: string | null = 'application/json'): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': '202401',
    };
    if (contentType) h['Content-Type'] = contentType;
    return h;
  }

  private handleRateLimit(res: Response) {
    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after') || '60';
      throw new RateLimitError(`Rate limited. Retry after ${retryAfter}s`, Number(retryAfter));
    }
  }

  async initializeImageUpload(): Promise<{ uploadUrl: string; imageUrn: string }> {
    const res = await fetch(`${LINKEDIN_API_BASE}/images?action=initializeUpload`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        initializeUploadRequest: { owner: this.personUrn },
      }),
    });

    this.handleRateLimit(res);

    if (!res.ok) {
      const errorBody = await res.text();
      throw new LinkedInApiError(`Image upload init failed ${res.status}: ${errorBody}`, res.status);
    }

    const data = await res.json();
    return { uploadUrl: data.value.uploadUrl, imageUrn: data.value.image };
  }

  async uploadImageBinary(uploadUrl: string, imageBuffer: Buffer): Promise<void> {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: imageBuffer,
    });

    this.handleRateLimit(res);

    if (!res.ok) {
      const errorBody = await res.text();
      throw new LinkedInApiError(`Image binary upload failed ${res.status}: ${errorBody}`, res.status);
    }
  }

  async uploadImage(imagePath: string): Promise<string> {
    const imageBuffer = await readFile(imagePath);
    const { uploadUrl, imageUrn } = await this.initializeImageUpload();
    await this.uploadImageBinary(uploadUrl, Buffer.from(imageBuffer));
    return imageUrn;
  }

  async uploadImageFromUrl(imageUrl: string): Promise<string> {
    const res = await fetch(imageUrl);
    if (!res.ok) {
      throw new LinkedInApiError(`Failed to fetch image from ${imageUrl}: ${res.status}`, res.status);
    }
    const imageBuffer = Buffer.from(await res.arrayBuffer());
    const { uploadUrl, imageUrn } = await this.initializeImageUpload();
    await this.uploadImageBinary(uploadUrl, imageBuffer);
    return imageUrn;
  }

  async createPost({ text, imageUrn, visibility = 'PUBLIC' }: CreatePostOptions) {
    const shareContent: Record<string, unknown> = {
      shareCommentary: { text },
      shareMediaCategory: imageUrn ? 'IMAGE' : 'NONE',
    };

    if (imageUrn) {
      shareContent.media = [{ status: 'READY', media: imageUrn }];
    }

    const body = {
      author: this.personUrn,
      lifecycleState: 'PUBLISHED',
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': visibility },
      specificContent: { 'com.linkedin.ugc.ShareContent': shareContent },
    };

    const res = await fetch(`${LINKEDIN_API_BASE}/ugcPosts`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    this.handleRateLimit(res);

    if (!res.ok) {
      const errorBody = await res.text();
      throw new LinkedInApiError(`LinkedIn API error ${res.status}: ${errorBody}`, res.status);
    }

    const postId = res.headers.get('x-restli-id') || res.headers.get('X-RestLi-Id');
    return { postId, status: res.status };
  }

  async verifyToken() {
    const res = await fetch(`${LINKEDIN_API_BASE}/me`, {
      headers: this.headers(null),
    });
    if (!res.ok) {
      throw new LinkedInApiError(`Token verification failed: ${res.status}`, res.status);
    }
    return res.json();
  }
}
