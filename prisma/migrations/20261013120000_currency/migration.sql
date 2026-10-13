-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "displayCurrency" TEXT;

-- CreateTable
CREATE TABLE "ExchangeRate" (
    "base" TEXT NOT NULL,
    "rates" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("base")
);

