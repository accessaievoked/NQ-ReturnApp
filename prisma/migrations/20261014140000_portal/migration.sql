-- CreateEnum
CREATE TYPE "PortalRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

-- CreateTable
CREATE TABLE "PortalSettings" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "allowReturns" BOOLEAN NOT NULL DEFAULT true,
    "allowExchanges" BOOLEAN NOT NULL DEFAULT true,
    "exchangeMode" TEXT NOT NULL DEFAULT 'VARIANT',
    "windowDays" INTEGER NOT NULL DEFAULT 30,
    "nonReturnableTag" TEXT NOT NULL DEFAULT 'final-sale',
    "requireNote" BOOLEAN NOT NULL DEFAULT false,
    "notice" TEXT,

    CONSTRAINT "PortalSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeRequest" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "orderGid" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "customerName" TEXT,
    "customerEmail" TEXT NOT NULL,
    "status" "PortalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "items" JSONB NOT NULL,
    "replacements" JSONB NOT NULL,
    "returnValue" DECIMAL(12,2) NOT NULL,
    "replacementValue" DECIMAL(12,2) NOT NULL,
    "currency" TEXT,
    "flags" JSONB,
    "declineNote" TEXT,
    "returnId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ExchangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortalSettings_shopId_key" ON "PortalSettings"("shopId");

-- CreateIndex
CREATE INDEX "ExchangeRequest_shopId_status_createdAt_idx" ON "ExchangeRequest"("shopId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRequest_shopId_code_key" ON "ExchangeRequest"("shopId", "code");

-- AddForeignKey
ALTER TABLE "PortalSettings" ADD CONSTRAINT "PortalSettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeRequest" ADD CONSTRAINT "ExchangeRequest_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

