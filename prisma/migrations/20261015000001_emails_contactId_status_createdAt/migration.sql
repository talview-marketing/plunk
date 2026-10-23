-- One index per migration: CREATE INDEX CONCURRENTLY cannot run inside a transaction, and it keeps
-- the table writable while the index builds
CREATE INDEX CONCURRENTLY IF NOT EXISTS "emails_contactId_status_createdAt_idx" ON "emails"("contactId", "status", "createdAt");
