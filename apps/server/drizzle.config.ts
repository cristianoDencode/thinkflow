import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/shared/infrastructure/db/schema.ts',
  out: './drizzle',
});
