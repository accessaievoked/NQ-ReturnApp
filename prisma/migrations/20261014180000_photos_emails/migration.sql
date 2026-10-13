-- AlterTable
ALTER TABLE "PortalSettings" ADD COLUMN     "photoMode" TEXT NOT NULL DEFAULT 'OPTIONAL';

-- CreateTable
CREATE TABLE "PortalUpload" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "claimed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSettings" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "fromName" TEXT,
    "replyTo" TEXT,
    "brandColor" TEXT NOT NULL DEFAULT '#3b3fe0',
    "logoUrl" TEXT,
    "footer" TEXT,
    "portalUrl" TEXT,

    CONSTRAINT "EmailSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "wrap" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortalUpload_shopId_claimed_createdAt_idx" ON "PortalUpload"("shopId", "claimed", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSettings_shopId_key" ON "EmailSettings"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailTemplate_shopId_event_key" ON "EmailTemplate"("shopId", "event");

-- CreateIndex
CREATE INDEX "EmailLog_shopId_createdAt_idx" ON "EmailLog"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailLog_shopId_dedupeKey_key" ON "EmailLog"("shopId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "PortalUpload" ADD CONSTRAINT "PortalUpload_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSettings" ADD CONSTRAINT "EmailSettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

