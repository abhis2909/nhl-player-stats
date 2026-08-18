-- AlterTable
ALTER TABLE "RatingSettings" DROP COLUMN "minGpFraction",
ADD COLUMN     "minGamesPlayedGoalies" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "minGamesPlayedSkaters" INTEGER NOT NULL DEFAULT 20;
