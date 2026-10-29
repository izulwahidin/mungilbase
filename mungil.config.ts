import type { MungilConfigInput } from './src/config/schema.js'

/**
 * Your entire backend definition.
 *
 * Every rule is required. Use `null` to deny, `'true'` to allow everyone, or
 * an expression. `!= null` on auth.uid is the idiomatic "signed in" check.
 *
 * `author_id` stores an auth user id. Auth users live in internal tables, so
 * there is intentionally no foreign key from posts to them.
 */
export default {
  appUrl: 'http://localhost:8787',

  // Browser origins allowed to call the API. Empty = same-origin only.
  allowedOrigins: [],

  // Keep signup closed; bootstrap accounts with `npm run user:create`.
  auth: {
    allowSignup: false,
  },

  tables: [
    {
      name: 'posts',
      fields: [
        { name: 'author_id', type: 'text', required: true },
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'text' },
        { name: 'published', type: 'boolean', default: false },
      ],
      rules: {
        list: 'published == true | auth.uid == author_id',
        view: 'published == true | auth.uid == author_id',
        create: 'auth.uid != null & author_id == auth.uid',
        update: 'auth.uid == author_id',
        delete: 'auth.uid == author_id',
      },
    },
  ],
} satisfies MungilConfigInput
