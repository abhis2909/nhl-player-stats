-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatarConfig" JSONB;

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sideA" JSONB NOT NULL,
    "sideB" JSONB NOT NULL,
    "sideAOverall" DOUBLE PRECISION NOT NULL,
    "sideBOverall" DOUBLE PRECISION NOT NULL,
    "winner" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
