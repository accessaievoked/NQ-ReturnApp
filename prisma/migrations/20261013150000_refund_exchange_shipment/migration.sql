-- AlterTable
ALTER TABLE "ReturnRequest" ADD COLUMN     "awb" TEXT,
ADD COLUMN     "carrier" TEXT,
ADD COLUMN     "exchangeDone" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "exchangeUnits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "refundedAt" TIMESTAMP(3),
ADD COLUMN     "shipmentStatus" TEXT;

