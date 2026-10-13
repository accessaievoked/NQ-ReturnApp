-- CreateEnum
CREATE TYPE "RuleAction" AS ENUM ('APPROVE', 'DECLINE');

-- AlterTable
ALTER TABLE "ReturnRequest" ADD COLUMN     "autoHandled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "returnValue" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "action" "RuleAction" NOT NULL,
    "declineNote" TEXT,
    "conditions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ruleId" TEXT,
    "returnId" TEXT NOT NULL,
    "action" "RuleAction" NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutomationRule_shopId_enabled_priority_idx" ON "AutomationRule"("shopId", "enabled", "priority");

-- CreateIndex
CREATE INDEX "AutomationRun_shopId_createdAt_idx" ON "AutomationRun"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "ReturnRequest_shopId_customerEmail_idx" ON "ReturnRequest"("shopId", "customerEmail");

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "ReturnRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: value of existing returns = sum(unitPrice * quantity) of their items
UPDATE "ReturnRequest" r
SET "returnValue" = COALESCE((
  SELECT SUM(COALESCE(i."unitPrice", 0) * i."quantity") FROM "ReturnItem" i WHERE i."returnId" = r.id
), 0);
