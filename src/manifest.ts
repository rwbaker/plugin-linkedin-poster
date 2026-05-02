const manifest = {
  name: '@sgnl/plugin-linkedin-poster',
  displayName: 'LinkedIn Poster',
  version: '0.1.0',
  description: 'Automated LinkedIn posting from a content calendar with image support',

  entrypoints: {
    worker: 'dist/worker.js',
  },

  capabilities: [
    'jobs.schedule',
    'plugin.state.read',
    'plugin.state.write',
    'http.outbound',
    'secrets.read-ref',
  ],

  configSchema: {
    type: 'object',
    properties: {
      linkedinAccessToken: {
        type: 'string',
        title: 'LinkedIn Access Token',
        description: 'OAuth access token with w_member_social scope',
      },
      linkedinPersonUrn: {
        type: 'string',
        title: 'LinkedIn Person URN',
        description: 'Format: urn:li:person:XXXXXX',
        pattern: '^urn:li:(person|organization):.+$',
      },
      postingWindowStartHour: {
        type: 'number',
        title: 'Posting window start (hour, ET)',
        default: 8,
        minimum: 0,
        maximum: 23,
      },
      postingWindowEndHour: {
        type: 'number',
        title: 'Posting window end (hour, ET)',
        default: 17,
        minimum: 0,
        maximum: 23,
      },
      dryRun: {
        type: 'boolean',
        title: 'Dry run mode',
        description: 'Log what would be posted without actually posting',
        default: false,
      },
    },
    required: ['linkedinAccessToken', 'linkedinPersonUrn'],
  },

  jobs: [
    {
      jobKey: 'daily-post',
      displayName: 'Daily LinkedIn Post',
      description: 'Posts scheduled content from the calendar. Runs daily at 8am ET.',
      schedule: '0 12 * * *',
    },
  ],
} as const;

export default manifest;
