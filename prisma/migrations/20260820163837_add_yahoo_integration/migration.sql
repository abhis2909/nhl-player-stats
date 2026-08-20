-- CreateTable
CREATE TABLE "YahooToken" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "leagueKey" TEXT,
    "leagueName" TEXT,
    "gameKey" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YahooToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YahooStandingsCache" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "rawData" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YahooStandingsCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YahooRosterCache" (
    "teamKey" TEXT NOT NULL,
    "teamName" TEXT NOT NULL,
    "rawData" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YahooRosterCache_pkey" PRIMARY KEY ("teamKey")
);

-- CreateTable
CREATE TABLE "YahooTransactionCache" (
    "transactionKey" TEXT NOT NULL,
    "rawData" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YahooTransactionCache_pkey" PRIMARY KEY ("transactionKey")
);

-- CreateTable
CREATE TABLE "YahooDraftCache" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "rawData" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YahooDraftCache_pkey" PRIMARY KEY ("id")
);
