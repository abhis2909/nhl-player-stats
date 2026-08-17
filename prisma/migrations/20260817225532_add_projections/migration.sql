-- CreateTable
CREATE TABLE "PlayerDeployment" (
    "id" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "nhlPlayerId" INTEGER NOT NULL,
    "toiPerGame" DOUBLE PRECISION,
    "ppToiPerGame" DOUBLE PRECISION,
    "gamesProjected" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectionSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "seasonWeights" JSONB NOT NULL,
    "ageCurveEnabled" BOOLEAN NOT NULL DEFAULT true,
    "multiplierClipMin" DOUBLE PRECISION NOT NULL DEFAULT 0.85,
    "multiplierClipMax" DOUBLE PRECISION NOT NULL DEFAULT 1.15,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectionSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlayerDeployment_season_nhlPlayerId_key" ON "PlayerDeployment"("season", "nhlPlayerId");
