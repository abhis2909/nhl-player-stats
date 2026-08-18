-- AlterTable
ALTER TABLE "ProjectionSettings" ADD COLUMN     "restOfSeasonShrinkageGames" INTEGER NOT NULL DEFAULT 20;

-- CreateTable
CREATE TABLE "RatingSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "positionWeights" JSONB NOT NULL,
    "goalieWeights" JSONB NOT NULL,
    "minGpFraction" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "ratingFloor" INTEGER NOT NULL DEFAULT 25,
    "ratingCeil" INTEGER NOT NULL DEFAULT 99,
    "ratingPremium" DOUBLE PRECISION NOT NULL DEFAULT 1.04,
    "tierThresholds" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RatingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatsSnapshot" (
    "date" TEXT NOT NULL,
    "seasonId" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatsSnapshot_pkey" PRIMARY KEY ("date")
);
