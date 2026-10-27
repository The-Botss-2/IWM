-- Runs once, when the Postgres container initializes an empty data volume.
-- schema.prisma declares trigram (gin_trgm_ops) search indexes, which need the
-- pg_trgm extension. Install it in the app database and in template1, so the
-- temporary shadow database `prisma migrate dev` creates has it too.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
\c template1
CREATE EXTENSION IF NOT EXISTS pg_trgm;
