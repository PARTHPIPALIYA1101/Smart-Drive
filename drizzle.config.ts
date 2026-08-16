import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/persistence/schema/index.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL || './smart_drive.db',
  },
});
