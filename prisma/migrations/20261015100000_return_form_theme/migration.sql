-- CreateTable
CREATE TABLE "ReturnFormTheme" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "css" TEXT NOT NULL,
    "style" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnFormTheme_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReturnFormTheme_shopId_key" ON "ReturnFormTheme"("shopId");

-- AddForeignKey
ALTER TABLE "ReturnFormTheme" ADD CONSTRAINT "ReturnFormTheme_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

