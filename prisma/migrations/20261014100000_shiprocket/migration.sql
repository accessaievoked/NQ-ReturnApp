-- AlterTable
ALTER TABLE "ReturnRequest" ADD COLUMN     "carrierStatus" TEXT,
ADD COLUMN     "pickupError" TEXT,
ADD COLUMN     "pickupScheduledAt" TIMESTAMP(3),
ADD COLUMN     "srOrderId" TEXT,
ADD COLUMN     "srShipmentId" TEXT,
ADD COLUMN     "trackingScans" JSONB;

-- CreateTable
CREATE TABLE "ShiprocketConnection" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "webhookSecret" TEXT NOT NULL,
    "email" TEXT,
    "passwordEnc" TEXT,
    "tokenEnc" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "whName" TEXT,
    "whAddress" TEXT,
    "whAddress2" TEXT,
    "whCity" TEXT,
    "whState" TEXT,
    "whPincode" TEXT,
    "whPhone" TEXT,
    "whEmail" TEXT,
    "whCountry" TEXT NOT NULL DEFAULT 'India',
    "parcelLength" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "parcelBreadth" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "parcelHeight" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "parcelWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "autoPickup" BOOLEAN NOT NULL DEFAULT false,
    "autoReceive" BOOLEAN NOT NULL DEFAULT true,
    "autoRefund" BOOLEAN NOT NULL DEFAULT false,
    "lastWebhookAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiprocketConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShiprocketConnection_shopId_key" ON "ShiprocketConnection"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "ShiprocketConnection_publicId_key" ON "ShiprocketConnection"("publicId");

-- CreateIndex
CREATE INDEX "ReturnRequest_awb_idx" ON "ReturnRequest"("awb");

-- AddForeignKey
ALTER TABLE "ShiprocketConnection" ADD CONSTRAINT "ShiprocketConnection_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

