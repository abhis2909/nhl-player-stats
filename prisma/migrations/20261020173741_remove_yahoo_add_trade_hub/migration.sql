-- DropTable (Yahoo Fantasy import removed — never got the OAuth app approved)
DROP TABLE IF EXISTS "YahooMatchupCache";
DROP TABLE IF EXISTS "YahooTransactionCache";
DROP TABLE IF EXISTS "YahooRosterCache";
DROP TABLE IF EXISTS "YahooStandingsCache";
DROP TABLE IF EXISTS "YahooDraftCache";
DROP TABLE IF EXISTS "YahooToken";

-- CreateTable
CREATE TABLE "TradeHubEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "blockPlayers" JSONB NOT NULL DEFAULT '[]',
    "targetPlayers" JSONB NOT NULL DEFAULT '[]',
    "targetCategories" JSONB NOT NULL DEFAULT '[]',
    "roster" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeHubEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TradeHubEntry_userId_key" ON "TradeHubEntry"("userId");

-- AddForeignKey
ALTER TABLE "TradeHubEntry" ADD CONSTRAINT "TradeHubEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
