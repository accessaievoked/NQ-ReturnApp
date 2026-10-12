-- AlterTable
ALTER TABLE "ReturnItem" ADD COLUMN     "customerImages" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ReturnRequest" ADD COLUMN     "currency" TEXT,
ADD COLUMN     "orderCreatedAt" TIMESTAMP(3),
ADD COLUMN     "orderTotal" DECIMAL(12,2),
ADD COLUMN     "paymentMethod" TEXT;
