export interface CalendarPost {
  id: string;
  week: number;
  scheduledDate: string;
  pillar?: string;
  text: string;
  imagePath?: string;
  imageUrl?: string;
  imageGuidance?: string;
  status: 'scheduled' | 'posted';
  postedAt?: string;
  linkedinPostId?: string;
}

export interface ContentCalendar {
  meta: {
    author: string;
    description: string;
    createdAt: string;
    source?: string;
  };
  posts: CalendarPost[];
}

export function getPostsDueNow(calendar: ContentCalendar, now = new Date()): CalendarPost[] {
  const todayStr = formatDate(now);
  return calendar.posts.filter((post) => {
    if (post.status === 'posted') return false;
    if (!post.scheduledDate) return false;
    return post.scheduledDate === todayStr;
  });
}

export function markPosted(post: CalendarPost, postId: string | null) {
  post.status = 'posted';
  post.postedAt = new Date().toISOString();
  if (postId) post.linkedinPostId = postId;
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}
